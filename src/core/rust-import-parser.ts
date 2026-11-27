import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUntrustedIdentifier } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

export interface RustCrateInfo {
  /** Workspace-relative directory containing Cargo.toml (`""` for workspace root) */
  crateDirRel: string;
  /** Crate identifier normalized with underscores (`my-core` -> `my_core`) */
  crateIdent: string;
  /** Crate root source file (`src/lib.rs` or `src/main.rs`) */
  entrySrcDirRel: string;
  libRootFile: string | null;
  mainRootFile: string | null;
}

export interface RustWorkspaceIndex {
  crates: RustCrateInfo[];
  crateByIdent: Map<string, RustCrateInfo>;
  rsFileSet: Set<string>;
  fingerprint: string;
}

const RUST_STD_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);

interface ParsedCargoManifest {
  packageName: string | null;
  libName: string | null;
  libPath: string | null;
  binPath: string | null;
}

function parseCargoManifest(rawToml: string): ParsedCargoManifest {
  const clean = rawToml.replace(/^\uFEFF/, '');
  let section = '';
  let packageName: string | null = null;
  let libName: string | null = null;
  let libPath: string | null = null;
  let binPath: string | null = null;

  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line;
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']$/.exec(line);
    if (!kv?.[1] || !kv[2]) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (section === '[package]' && key === 'name') {
      packageName = val;
    } else if (section === '[lib]') {
      if (key === 'name') libName = val;
      else if (key === 'path') libPath = val;
    } else if (section === '[[bin]]' && key === 'path' && !binPath) {
      binPath = val;
    }
  }
  return { packageName, libName, libPath, binPath };
}

/**
 * Builds a workspace index of Rust Cargo crates (`Cargo.toml` package/[lib] names + custom/standard root files).
 */
export function buildRustWorkspaceIndex(
  workspaceRoot: string,
  allFileSet: ReadonlySet<string>,
): RustWorkspaceIndex {
  const rsFileSet = new Set<string>();
  const cargoPaths: string[] = [];

  for (const rel of Array.from(allFileSet).sort()) {
    if (rel.toLowerCase().endsWith('.rs')) {
      rsFileSet.add(rel);
    } else if (path.posix.basename(rel) === 'Cargo.toml') {
      cargoPaths.push(rel);
    }
  }

  const crates: RustCrateInfo[] = [];
  const crateByIdent = new Map<string, RustCrateInfo>();
  const fpParts: string[] = [];

  for (const cargoRel of cargoPaths) {
    const dir = path.posix.dirname(cargoRel);
    const crateDirRel = dir === '.' ? '' : dir;
    try {
      const text = fs.readFileSync(path.join(workspaceRoot, cargoRel), 'utf8');
      const manifest = parseCargoManifest(text);
      const primaryName = manifest.libName ?? manifest.packageName;
      if (!primaryName) continue;
      const crateIdent = primaryName.replace(/-/g, '_');
      const pkgIdent = manifest.packageName ? manifest.packageName.replace(/-/g, '_') : crateIdent;

      const resolveCrateFile = (relInCrate: string): string =>
        crateDirRel ? path.posix.normalize(`${crateDirRel}/${relInCrate}`) : path.posix.normalize(relInCrate);

      const libCandidate = resolveCrateFile(manifest.libPath ?? 'src/lib.rs');
      const mainCandidate = resolveCrateFile(manifest.binPath ?? 'src/main.rs');
      const libRootFile = rsFileSet.has(libCandidate) ? libCandidate : null;
      const mainRootFile = rsFileSet.has(mainCandidate) ? mainCandidate : null;
      const rootRef = libRootFile ?? mainRootFile;
      const defaultSrcDir = crateDirRel ? `${crateDirRel}/src` : 'src';
      const entrySrcDirRel = rootRef
        ? path.posix.dirname(rootRef) === '.'
          ? ''
          : path.posix.dirname(rootRef)
        : defaultSrcDir;

      const info: RustCrateInfo = {
        crateDirRel,
        crateIdent,
        entrySrcDirRel,
        libRootFile,
        mainRootFile,
      };
      crates.push(info);
      crateByIdent.set(crateIdent, info);
      if (pkgIdent !== crateIdent && !crateByIdent.has(pkgIdent)) {
        crateByIdent.set(pkgIdent, info);
      }
      fpParts.push(`${cargoRel}:${crateIdent}:${pkgIdent}:${libRootFile ?? ''}:${mainRootFile ?? ''}`);
    } catch {
      // Ignore unreadable Cargo.toml
    }
  }

  // Fallback synthetic crate when `.rs` files exist without a Cargo.toml (e.g. minimal fixture)
  if (crates.length === 0 && rsFileSet.size > 0) {
    const srcDir = rsFileSet.has('src/lib.rs') || rsFileSet.has('src/main.rs') ? 'src' : '';
    const libPath = srcDir ? `${srcDir}/lib.rs` : 'lib.rs';
    const mainPath = srcDir ? `${srcDir}/main.rs` : 'main.rs';
    crates.push({
      crateDirRel: '',
      crateIdent: 'crate',
      entrySrcDirRel: srcDir,
      libRootFile: rsFileSet.has(libPath) ? libPath : null,
      mainRootFile: rsFileSet.has(mainPath) ? mainPath : null,
    });
  }

  crates.sort((a, b) => b.crateDirRel.length - a.crateDirRel.length);

  return { crates, crateByIdent, rsFileSet, fingerprint: fpParts.join('|') };
}

/**
 * Masks Rust line comments, NESTED block comments, raw strings (`r#"..."#`),
 * normal strings (`"..."`), and char literals (`'x'`) WITHOUT confusing lifetime tokens (`'a`, `'static`)!
 */
function maskRustCommentsAndStrings(source: string): string {
  const chars = new Array<string>(source.length);
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Line comment `//`
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

    // Nested block comment `/* ... /* ... */ ... */`
    if (ch === '/' && next === '*') {
      let depth = 1;
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
          continue;
        }
        chars[i] = source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    // Raw string `r"..."` or `r#"..."#` (also `br#"..."#` or `cr#"..."#`)
    if (
      (ch === 'r' || ((ch === 'b' || ch === 'c') && next === 'r')) &&
      (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]!))
    ) {
      let p = ch === 'r' ? i + 1 : i + 2;
      let hashes = 0;
      while (p < source.length && source[p] === '#') {
        hashes++;
        p++;
      }
      if (source[p] === '"') {
        for (let k = i; k <= p; k++) chars[k] = ' ';
        p++;
        while (p < source.length) {
          if (source[p] === '"') {
            let closeHashes = 0;
            while (closeHashes < hashes && source[p + 1 + closeHashes] === '#') {
              closeHashes++;
            }
            if (closeHashes === hashes) {
              for (let k = p; k <= p + hashes; k++) chars[k] = ' ';
              p += hashes + 1;
              break;
            }
          }
          chars[p] = source[p] === '\n' ? '\n' : ' ';
          p++;
        }
        i = p;
        continue;
      }
    }

    // Double-quoted string literal
    if (ch === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < source.length) {
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

    // Char literal (`'a'`, `'\n'`, `'\x7f'`, `'\u{1F600}'`) — strictly NOT lifetime `'a` or `'static`!
    if (ch === "'") {
      const rest = source.slice(i, Math.min(source.length, i + 16));
      const charLit = /^'(?:\\(?:x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f_]+\}|.)|[^'\\\n])'/.exec(rest);
      if (charLit) {
        for (let k = 0; k < charLit[0].length; k++) chars[i + k] = ' ';
        i += charLit[0].length;
        continue;
      }
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

/**
 * Expands Rust grouped `use` trees like `crate::a::{b, c::{self, d as dd}}` into flat path arrays.
 */
function expandRustUseTree(tree: string, depth = 0): string[][] {
  if (depth > 4) return [];
  const trimmed = tree.trim();
  if (!trimmed) return [];

  const braceIdx = trimmed.indexOf('{');
  if (braceIdx === -1) {
    const noAlias = trimmed.split(/\s+as\s+/)[0]?.trim() ?? '';
    const segs = noAlias.split('::').map((s) => s.trim()).filter(Boolean);
    return segs.length > 0 ? [segs] : [];
  }

  const closeIdx = trimmed.lastIndexOf('}');
  if (closeIdx <= braceIdx) return [];

  const prefixRaw = trimmed.slice(0, braceIdx).replace(/::\s*$/, '').trim();
  const prefixSegs = prefixRaw ? prefixRaw.split('::').map((s) => s.trim()).filter(Boolean) : [];
  const inner = trimmed.slice(braceIdx + 1, closeIdx);

  // Split top-level comma items inside `{ ... }` respecting nested braces
  const items: string[] = [];
  let cur = '';
  let nest = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '{') nest++;
    else if (c === '}') nest = Math.max(0, nest - 1);
    if (c === ',' && nest === 0) {
      if (cur.trim()) items.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) items.push(cur.trim());

  const out: string[][] = [];
  for (const item of items) {
    for (const sub of expandRustUseTree(item, depth + 1)) {
      if (sub.length === 1 && sub[0] === 'self') {
        if (prefixSegs.length > 0) out.push([...prefixSegs]);
      } else {
        out.push([...prefixSegs, ...sub]);
      }
    }
  }
  return out;
}

function stripRustRawIdent(seg: string): string {
  return seg.startsWith('r#') ? seg.slice(2) : seg;
}

function resolveRustModuleChain(
  baseDirRel: string,
  segments: readonly string[],
  rsFileSet: ReadonlySet<string>,
): string | null {
  const cleanSegs = segments.map(stripRustRawIdent);
  // Walk longest prefix first (`crate::net::http::Client` -> try `net/http/Client.rs`, then `net/http.rs`, then `net/http/mod.rs`, then `net.rs`)
  for (let len = cleanSegs.length; len >= 1; len--) {
    const sub = cleanSegs.slice(0, len);
    if (sub.some((s) => !s || s === '*' || s === 'self')) continue;
    const joined = baseDirRel ? `${baseDirRel}/${sub.join('/')}` : sub.join('/');
    const asRs = `${joined}.rs`;
    if (rsFileSet.has(asRs)) return asRs;
    const asMod = `${joined}/mod.rs`;
    if (rsFileSet.has(asMod)) return asMod;
  }
  return null;
}

function computeRustChildModuleDir(sourceFilePosix: string, owningCrate?: RustCrateInfo): string {
  const dir = path.posix.dirname(sourceFilePosix);
  const base = path.posix.basename(sourceFilePosix);
  const cleanDir = dir === '.' ? '' : dir;
  // In Rust, crate roots (`lib.rs`, `main.rs`, or custom `[lib] path` / `[[bin]] path`) and `mod.rs`
  // look for child modules in their SAME directory; named submodules (`src/foo.rs`) look in `src/foo/`!
  const isCrateOrModRoot =
    base === 'lib.rs' ||
    base === 'main.rs' ||
    base === 'mod.rs' ||
    sourceFilePosix === owningCrate?.libRootFile ||
    sourceFilePosix === owningCrate?.mainRootFile;
  if (isCrateOrModRoot) {
    return cleanDir;
  }
  const stem = base.slice(0, -'.rs'.length);
  return cleanDir ? `${cleanDir}/${stem}` : stem;
}

/**
 * Deterministic zero-native-addon Rust dependency parser (`mod foo;`, `#[path = "..."] mod`, `use crate::/super::/self::/<workspace_crate>::`).
 */
export function parseRustImports(
  sourceFilePosix: string,
  rawSourceText: string,
  rustIndex: RustWorkspaceIndex,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const masked = maskRustCommentsAndStrings(sourceText);
  const lines = sourceText.split(/\r?\n/);
  const results: ParsedImportRecord[] = [];
  const seen = new Set<string>();

  const pushUnique = (rec: ParsedImportRecord) => {
    const key = rec.targetFile
      ? `${rec.line}:${rec.kind}:${rec.targetFile}`
      : `${rec.line}:${rec.kind}:${rec.specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(rec);
  };

  const getSnippet = (lineNum: number): string =>
    sanitizeUntrustedIdentifier((lines[lineNum - 1] ?? '').trim(), 140);

  const owningCrate =
    rustIndex.crates.find((c) => !c.crateDirRel || sourceFilePosix.startsWith(`${c.crateDirRel}/`)) ??
    rustIndex.crates[0];
  const childModDir = computeRustChildModuleDir(sourceFilePosix, owningCrate);

  // 1. External `mod foo;` declarations (supporting `r#type` raw idents and ANY order of `#[cfg(...)]` + `#[path = "custom.rs"]`!)
  const modRe =
    /(?:^|[;\n{}\]])\s*((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+((?:r#)?[A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const m of masked.matchAll(modRe)) {
    const rawModName = m[2]!;
    const modName = stripRustRawIdent(rawModName);
    const absIdx = m.index ?? 0;
    const modKwOffset = absIdx + m[0].lastIndexOf('mod');
    const line = offsetToLine(sourceText, modKwOffset);

    let targetFile: string | null = null;
    if (m[1]) {
      const attrStartInMatch = m[0].indexOf(m[1]);
      const attrReal = sourceText.slice(absIdx + attrStartInMatch, absIdx + attrStartInMatch + m[1].length);
      const pathAttr = /#\[path\s*=\s*"([^"]+)"\]/.exec(attrReal);
      if (pathAttr?.[1]) {
        const curDir = path.posix.dirname(sourceFilePosix);
        const joined = path.posix.normalize(curDir === '.' ? pathAttr[1] : `${curDir}/${pathAttr[1]}`);
        if (rustIndex.rsFileSet.has(joined)) targetFile = joined;
      }
    }
    if (!targetFile) {
      targetFile = resolveRustModuleChain(childModDir, [modName], rustIndex.rsFileSet);
    }
    if (targetFile && targetFile !== sourceFilePosix) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile,
        specifier: `mod ${rawModName}`,
        line,
        snippet: getSnippet(line),
        kind: 'static_import',
        confidence: 'high',
      });
    }
  }

  // 2. `use ...;` statements (including `pub use` re-exports, single-line attributes, `{ use ...; }`, and nested brace trees)
  const useRe = /(?:^|[;\n{}\]])\s*(pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g;
  for (const m of masked.matchAll(useRe)) {
    const isPub = Boolean(m[1]);
    const treeText = (m[2] ?? '').trim();
    const useKwOffset = (m.index ?? 0) + m[0].indexOf('use');
    const line = offsetToLine(sourceText, useKwOffset);

    const expandedPaths = expandRustUseTree(treeText);
    for (const segs of expandedPaths) {
      if (segs.length === 0) continue;
      const head = segs[0]!.replace(/^::/, '');
      if (!head || RUST_STD_CRATES.has(head)) continue;

      let targetFile: string | null = null;
      if (head === 'crate') {
        const srcBase = owningCrate?.entrySrcDirRel ?? '';
        targetFile =
          resolveRustModuleChain(srcBase, segs.slice(1), rustIndex.rsFileSet) ??
          owningCrate?.libRootFile ??
          owningCrate?.mainRootFile ??
          null;
      } else if (head === 'self') {
        targetFile = resolveRustModuleChain(childModDir, segs.slice(1), rustIndex.rsFileSet);
      } else if (head === 'super') {
        let upCount = 0;
        while (upCount < segs.length && segs[upCount] === 'super') upCount++;
        const rest = segs.slice(upCount);
        // Move up from current file's module directory
        let baseDir = path.posix.dirname(sourceFilePosix);
        if (baseDir === '.') baseDir = '';
        const isModIndex =
          ['lib.rs', 'main.rs', 'mod.rs'].includes(path.posix.basename(sourceFilePosix)) ||
          sourceFilePosix === owningCrate?.libRootFile ||
          sourceFilePosix === owningCrate?.mainRootFile;
        const climbs = isModIndex ? upCount : Math.max(0, upCount - 1);
        for (let c = 0; c < climbs; c++) {
          const p = path.posix.dirname(baseDir);
          baseDir = p === '.' ? '' : p;
        }
        targetFile = resolveRustModuleChain(baseDir, rest, rustIndex.rsFileSet);
        if (!targetFile && baseDir && rustIndex.rsFileSet.has(`${baseDir}.rs`)) {
          targetFile = `${baseDir}.rs`;
        } else if (!targetFile && baseDir && rustIndex.rsFileSet.has(`${baseDir}/mod.rs`)) {
          targetFile = `${baseDir}/mod.rs`;
        } else if (!targetFile && owningCrate && baseDir === owningCrate.entrySrcDirRel) {
          targetFile = owningCrate.libRootFile ?? owningCrate.mainRootFile;
        }
      } else {
        const cleanHead = stripRustRawIdent(head);
        const wsCrate = rustIndex.crateByIdent.get(cleanHead);
        if (wsCrate) {
          targetFile =
            resolveRustModuleChain(wsCrate.entrySrcDirRel, segs.slice(1), rustIndex.rsFileSet) ??
            wsCrate.libRootFile ??
            wsCrate.mainRootFile;
        } else {
          // Rust 2018/2021 local child module path without `self::` or `crate::` (`mod sub; pub use sub::leaf::Item;`)
          targetFile = resolveRustModuleChain(childModDir, segs, rustIndex.rsFileSet);
        }
      }

      if (targetFile && targetFile !== sourceFilePosix) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile,
          specifier: sanitizeUntrustedIdentifier(segs.join('::'), 160),
          line,
          snippet: getSnippet(line),
          kind: isPub ? 'reexport' : 'static_import',
          confidence: 'high',
        });
      }
    }
  }

  // 3. Legacy `extern crate <name>;` targeting workspace crates
  const externCrateRe = /(?:^|[;\n}\]])\s*(?:pub\s+)?extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+[A-Za-z_][A-Za-z0-9_]*)?\s*;/g;
  for (const em of masked.matchAll(externCrateRe)) {
    const crateIdent = em[1]!;
    if (RUST_STD_CRATES.has(crateIdent)) continue;
    const wsCrate = rustIndex.crateByIdent.get(crateIdent);
    const targetFile = wsCrate?.libRootFile ?? wsCrate?.mainRootFile ?? null;
    if (targetFile && targetFile !== sourceFilePosix) {
      const line = offsetToLine(sourceText, (em.index ?? 0) + em[0].indexOf('extern'));
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile,
        specifier: `extern crate ${crateIdent}`,
        line,
        snippet: getSnippet(line),
        kind: 'static_import',
        confidence: 'high',
      });
    }
  }

  // 4. Rust `include!("file.rs")` static file inclusion vs `include!(concat!(...))` dynamic macro inclusion
  const includeMacroRe = /\binclude!\s*\(\s*([^)]+)\)/g;
  for (const im of masked.matchAll(includeMacroRe)) {
    const absIdx = im.index ?? 0;
    const line = offsetToLine(sourceText, absIdx);
    const argMasked = im[1]!.trim();
    if (argMasked.startsWith('"') && argMasked.endsWith('"')) {
      const qStart = absIdx + im[0].indexOf('"');
      const qEnd = absIdx + im[0].lastIndexOf('"');
      const relSpec = sourceText.slice(qStart + 1, qEnd);
      const curDir = path.posix.dirname(sourceFilePosix);
      const joined = path.posix.normalize(curDir === '.' ? relSpec : `${curDir}/${relSpec}`);
      if (rustIndex.rsFileSet.has(joined) && joined !== sourceFilePosix) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: joined,
          specifier: sanitizeUntrustedIdentifier(relSpec, 160),
          line,
          snippet: getSnippet(line),
          kind: 'static_import',
          confidence: 'high',
        });
      }
    } else {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: 'include!(...)',
        line,
        snippet: getSnippet(line),
        kind: 'dynamic_import',
        confidence: 'low',
        note: 'Dynamic Rust include!() macro (e.g. OUT_DIR build.rs codegen) — verify manually.',
      });
    }
  }

  return results;
}
