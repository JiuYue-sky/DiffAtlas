import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUntrustedIdentifier, toPosixPath } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

export interface GoModuleConfig {
  /** Workspace-relative POSIX directory containing `go.mod` (`""` for workspace root) */
  modDirRel: string;
  /** Declared Go module path from `module <path>` */
  modulePath: string;
  /** Local filesystem `replace old/mod => ./local/dir` mappings */
  replaces: Array<{ fromPrefix: string; toDirRel: string }>;
}

export interface GoWorkspaceIndex {
  modules: GoModuleConfig[];
  /** Directory POSIX path (`""` for root) -> sorted non-test `.go` files in that package */
  dirToProdFiles: Map<string, string[]>;
  /** Fingerprint covering go.mod contents for topology cache invalidation */
  fingerprint: string;
}

const MAX_PACKAGE_FANOUT_FILES = 80;

function parseGoModFile(modDirRel: string, rawText: string): GoModuleConfig | null {
  const clean = rawText.replace(/^\uFEFF/, '');
  let modulePath = '';
  const replaces: Array<{ fromPrefix: string; toDirRel: string }> = [];
  let inReplaceBlock = false;

  const parseReplaceLine = (lineBody: string) => {
    const m = /^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)$/.exec(lineBody);
    if (!m?.[1] || !m[2]) return;
    const targetRaw = m[2].replace(/^"|"$/g, '');
    // Only map local relative filesystem replaces (not remote version replacements)
    if (targetRaw.startsWith('./') || targetRaw.startsWith('../') || targetRaw === '.') {
      const joined = modDirRel
        ? path.posix.normalize(`${modDirRel}/${toPosixPath(targetRaw)}`)
        : path.posix.normalize(toPosixPath(targetRaw));
      if (joined !== '..' && !joined.startsWith('../')) {
        replaces.push({
          fromPrefix: m[1].replace(/^"|"$/g, ''),
          toDirRel: joined === '.' ? '' : joined.replace(/\/+$/, ''),
        });
      }
    }
  };

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (inReplaceBlock) {
      if (line === ')') {
        inReplaceBlock = false;
        continue;
      }
      parseReplaceLine(line);
      continue;
    }

    const modMatch = /^module\s+(?:"([^"]+)"|(\S+))$/.exec(line);
    if (modMatch) {
      modulePath = (modMatch[1] ?? modMatch[2] ?? '').trim();
      continue;
    }

    if (/^replace\s*\($/.test(line)) {
      inReplaceBlock = true;
      continue;
    }

    const singleRep = /^replace\s+(.+)$/.exec(line);
    if (singleRep?.[1]) {
      parseReplaceLine(singleRep[1].trim());
    }
  }

  if (!modulePath) return null;
  return { modDirRel, modulePath, replaces };
}

/**
 * Builds a lightweight workspace index of `go.mod` modules and Go package directories.
 */
export function buildGoWorkspaceIndex(
  workspaceRoot: string,
  allFileSet: ReadonlySet<string>,
): GoWorkspaceIndex {
  const modules: GoModuleConfig[] = [];
  const dirToProdFiles = new Map<string, string[]>();
  const fpParts: string[] = [];

  for (const rel of Array.from(allFileSet).sort()) {
    // Skip Go toolchain ignored directories (`vendor/` third-party code & `testdata/` test fixtures)
    if (/(?:^|\/)(?:vendor|testdata)\//.test(rel)) continue;
    const base = path.posix.basename(rel);
    if (base === 'go.mod') {
      const dir = path.posix.dirname(rel);
      const modDirRel = dir === '.' ? '' : dir;
      try {
        const text = fs.readFileSync(path.join(workspaceRoot, rel), 'utf8');
        const parsed = parseGoModFile(modDirRel, text);
        if (parsed) {
          modules.push(parsed);
          fpParts.push(`${rel}:${parsed.modulePath}:${JSON.stringify(parsed.replaces)}`);
        }
      } catch {
        // Ignore unreadable go.mod
      }
    } else if (rel.toLowerCase().endsWith('.go') && !rel.toLowerCase().endsWith('_test.go')) {
      const dir = path.posix.dirname(rel);
      const dirKey = dir === '.' ? '' : dir;
      const list = dirToProdFiles.get(dirKey) ?? [];
      list.push(rel);
      dirToProdFiles.set(dirKey, list);
    }
  }

  // Sort modules deepest-first so nested sub-modules take precedence
  modules.sort((a, b) => b.modDirRel.length - a.modDirRel.length);
  for (const [dir, list] of dirToProdFiles.entries()) {
    const pkgBase = dir ? path.posix.basename(dir) : '';
    list.sort((a, b) => {
      // Prioritize `<pkg>.go` or `main.go` before other files in the package
      const aPrimary = path.posix.basename(a) === `${pkgBase}.go` || path.posix.basename(a) === 'main.go' ? 0 : 1;
      const bPrimary = path.posix.basename(b) === `${pkgBase}.go` || path.posix.basename(b) === 'main.go' ? 0 : 1;
      if (aPrimary !== bPrimary) return aPrimary - bPrimary;
      return a.localeCompare(b);
    });
  }

  return { modules, dirToProdFiles, fingerprint: fpParts.join('|') };
}

function maskGoCommentsAndStrings(source: string): string {
  const chars = new Array<string>(source.length);
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          break;
        }
        chars[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Raw backtick string literal (can span multiple lines; no escapes!)
    if (ch === '`') {
      chars[i] = '`';
      i++;
      while (i < source.length) {
        if (source[i] === '`') {
          chars[i] = '`';
          i++;
          break;
        }
        chars[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Rune literal `'a'` or `'\n'`
    if (ch === "'") {
      chars[i] = "'";
      i++;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < source.length) chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (source[i] === "'") {
          chars[i] = "'";
          i++;
          break;
        }
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    if (ch === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          i = Math.min(i + 2, source.length);
          continue;
        }
        if (source[i] === '"') {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      chars[start] = '"';
      const innerEnd = closed ? i - 1 : i;
      for (let k = start + 1; k < innerEnd; k++) {
        chars[k] = source[k] === '\n' ? '\n' : '_';
      }
      if (closed && i - 1 > start) chars[i - 1] = '"';
      continue;
    }

    chars[i] = ch;
    i++;
  }

  return chars.join('');
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function resolveGoImportToDir(
  sourceFilePosix: string,
  importPath: string,
  goIndex: GoWorkspaceIndex,
): string | null {
  // 1. Check `replace` directives of enclosing module(s) first
  for (const mod of goIndex.modules) {
    const inMod = !mod.modDirRel || sourceFilePosix.startsWith(`${mod.modDirRel}/`);
    if (!inMod) continue;
    for (const rep of mod.replaces) {
      if (importPath === rep.fromPrefix || importPath.startsWith(`${rep.fromPrefix}/`)) {
        const suffix = importPath.slice(rep.fromPrefix.length).replace(/^\/+/, '');
        const dir = rep.toDirRel ? (suffix ? `${rep.toDirRel}/${suffix}` : rep.toDirRel) : suffix;
        if (goIndex.dirToProdFiles.has(dir)) return dir;
      }
    }
  }

  // 2. Match any workspace `go.mod` module prefix (handles monorepos & Go workspaces cleanly)
  for (const mod of goIndex.modules) {
    if (importPath === mod.modulePath || importPath.startsWith(`${mod.modulePath}/`)) {
      const suffix = importPath.slice(mod.modulePath.length).replace(/^\/+/, '');
      const dir = mod.modDirRel ? (suffix ? `${mod.modDirRel}/${suffix}` : mod.modDirRel) : suffix;
      if (goIndex.dirToProdFiles.has(dir)) return dir;
    }
  }

  return null;
}

/**
 * Deterministic zero-native-addon Go import parser (`go.mod` + `import (...)` + same-package `_test.go` linkage).
 */
export function parseGoImports(
  sourceFilePosix: string,
  rawSourceText: string,
  goIndex: GoWorkspaceIndex,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const masked = maskGoCommentsAndStrings(sourceText);
  const lines = sourceText.split(/\r?\n/);
  const results: ParsedImportRecord[] = [];
  const seen = new Set<string>();

  const pushUnique = (rec: ParsedImportRecord) => {
    const key = `${rec.line}:${rec.kind}:${rec.specifier}:${rec.targetFile ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(rec);
  };

  const getSnippet = (lineNum: number): string =>
    sanitizeUntrustedIdentifier((lines[lineNum - 1] ?? '').trim(), 140);

  const emitImportSpec = (specPath: string, line: number) => {
    if (!specPath) return;
    const targetDir = resolveGoImportToDir(sourceFilePosix, specPath, goIndex);
    if (targetDir === null) return; // stdlib or external module
    const prodFiles = (goIndex.dirToProdFiles.get(targetDir) ?? []).filter((f) => f !== sourceFilePosix);
    for (const targetFile of prodFiles.slice(0, MAX_PACKAGE_FANOUT_FILES)) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile,
        specifier: sanitizeUntrustedIdentifier(specPath, 160),
        line,
        snippet: getSnippet(line),
        kind: 'package_import',
        confidence: 'high',
      });
    }
  };

  // 1. Grouped `import ( ... )` blocks
  const groupedRe = /(?:^|\n)[ \t]*import[ \t]*\(([\s\S]*?)\)/g;
  for (const m of masked.matchAll(groupedRe)) {
    const blockMasked = m[1] ?? '';
    const blockStart = (m.index ?? 0) + m[0].indexOf('(') + 1;
    const specRe = /(?:^|[\n;])[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*|\.)?[ \t]*"([^"\n]+)"/g;
    for (const sm of blockMasked.matchAll(specRe)) {
      const qStart = blockStart + (sm.index ?? 0) + sm[0].indexOf('"');
      const qEnd = blockStart + (sm.index ?? 0) + sm[0].lastIndexOf('"');
      const realSpec = sourceText.slice(qStart + 1, qEnd);
      emitImportSpec(realSpec, offsetToLine(sourceText, qStart));
    }
  }

  // 2. Single-line `import [alias] "pkg/path"`
  const singleRe = /(?:^|\n)[ \t]*import[ \t]+(?:(?:[A-Za-z_][A-Za-z0-9_]*|\.)[ \t]+)?"([^"\n]+)"/g;
  for (const m of masked.matchAll(singleRe)) {
    const absStart = m.index ?? 0;
    const qStart = absStart + m[0].indexOf('"');
    const qEnd = absStart + m[0].lastIndexOf('"');
    const realSpec = sourceText.slice(qStart + 1, qEnd);
    emitImportSpec(realSpec, offsetToLine(sourceText, qStart));
  }

  // 3. Same-package Go unit tests (`foo_test.go` declaring `package foo`, NOT `package foo_test`)
  // implicitly depend on non-test `.go` files in the same directory without an `import` statement!
  if (sourceFilePosix.toLowerCase().endsWith('_test.go')) {
    const pkgMatch = /(?:^|\n)[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*)/.exec(masked);
    if (pkgMatch?.[1] && !pkgMatch[1].endsWith('_test')) {
      const pkgLine = offsetToLine(sourceText, (pkgMatch.index ?? 0) + pkgMatch[0].indexOf('package'));
      const dir = path.posix.dirname(sourceFilePosix);
      const dirKey = dir === '.' ? '' : dir;
      const peers = goIndex.dirToProdFiles.get(dirKey) ?? [];
      // In Go, same-package `*_test.go` compiles against ALL non-test `.go` files in that package directory!
      const targets = peers.slice(0, MAX_PACKAGE_FANOUT_FILES);
      for (const peer of targets) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: peer,
          specifier: `package ${pkgMatch[1]}`,
          line: pkgLine,
          snippet: getSnippet(pkgLine),
          kind: 'package_import',
          confidence: 'high',
        });
      }
    }
  }

  // 4. Dynamic Go plugin loading (`plugin.Open(...)`)
  for (const dm of masked.matchAll(/\bplugin\.Open\s*\(/g)) {
    const line = offsetToLine(sourceText, dm.index ?? 0);
    pushUnique({
      sourceFile: sourceFilePosix,
      targetFile: null,
      specifier: 'plugin.Open',
      line,
      snippet: getSnippet(line),
      kind: 'dynamic_import',
      confidence: 'low',
      note: 'Dynamic Go plugin.Open() loader detected — verify runtime shared object dependency manually.',
    });
  }

  return results;
}
