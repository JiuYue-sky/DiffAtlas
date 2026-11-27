import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUntrustedIdentifier } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

export interface JvmProdDecl {
  file: string;
  symbols: string[];
}

export interface JvmWorkspaceIndex {
  /** Fully-qualified type/function name `com.acme.auth.TokenService` -> workspace file path(s) */
  fqcnToFiles: Map<string, string[]>;
  /** Package name `com.acme.auth` -> non-test `.java`/`.kt` file declarations in that package */
  packageToProdDecls: Map<string, JvmProdDecl[]>;
  /** Fingerprint of package + top-level type declarations for cache invalidation */
  fingerprint: string;
}

const JVM_EXTERNAL_PREFIXES = [
  'java.',
  'javax.',
  'jakarta.',
  'kotlin.',
  'kotlinx.',
  'android.',
  'androidx.',
  'org.junit.',
  'org.mockito.',
  'org.slf4j.',
];

const MAX_WILDCARD_FANOUT = 80;

function maskJvmCommentsAndStrings(source: string, isKotlin: boolean): string {
  const chars = new Array<string>(source.length);

  const scanCodeRange = (startIdx: number, stopOnCloseBrace: boolean): number => {
    let i = startIdx;
    let braceDepth = 1;

    while (i < source.length) {
      const ch = source[i]!;
      const next = source[i + 1];

      if (stopOnCloseBrace) {
        if (ch === '{') {
          braceDepth++;
          chars[i] = '{';
          i++;
          continue;
        }
        if (ch === '}') {
          braceDepth--;
          chars[i] = '}';
          i++;
          if (braceDepth === 0) return i;
          continue;
        }
      }

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
        let depth = 1;
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        while (i < source.length && depth > 0) {
          if (isKotlin && source[i] === '/' && source[i + 1] === '*') {
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

      // Triple-quoted text blocks (`"""..."""`) — in Kotlin, preserve `${...}` / `$ident` template expressions!
      if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        chars[i + 2] = ' ';
        i += 3;
        while (i < source.length) {
          if (source[i] === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            chars[i + 2] = ' ';
            i += 3;
            break;
          }
          if (isKotlin && source[i] === '$' && source[i + 1] === '{') {
            chars[i] = ' ';
            chars[i + 1] = '{';
            i = scanCodeRange(i + 2, true);
            continue;
          }
          if (isKotlin && source[i] === '$' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
            chars[i] = ' ';
            i++;
            while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
              chars[i] = source[i]!;
              i++;
            }
            continue;
          }
          chars[i] = source[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        const q = ch;
        chars[i] = ' ';
        i++;
        while (i < source.length && source[i] !== '\n') {
          if (source[i] === '\\') {
            chars[i] = ' ';
            if (i + 1 < source.length) chars[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
            i = Math.min(i + 2, source.length);
            continue;
          }
          if (isKotlin && q === '"' && source[i] === '$' && source[i + 1] === '{') {
            chars[i] = ' ';
            chars[i + 1] = '{';
            i = scanCodeRange(i + 2, true);
            continue;
          }
          if (isKotlin && q === '"' && source[i] === '$' && /[A-Za-z_]/.test(source[i + 1] ?? '')) {
            chars[i] = ' ';
            i++;
            while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) {
              chars[i] = source[i]!;
              i++;
            }
            continue;
          }
          if (source[i] === q) {
            chars[i] = ' ';
            i++;
            break;
          }
          chars[i] = ' ';
          i++;
        }
        continue;
      }

      chars[i] = ch;
      i++;
    }
    return i;
  };

  scanCodeRange(0, false);
  return chars.join('');
}

/**
 * Blanks `@Annotation` and `@Annotation(...nested(...)...)` on an already comment/string-masked buffer
 * so multi-line or nested-paren annotations NEVER block class/function declaration regexes.
 */
function blankJvmAnnotations(masked: string): string {
  const chars = new Array<string>(masked.length);
  let i = 0;
  while (i < masked.length) {
    if (masked[i] === '@' && /[A-Za-z_]/.test(masked[i + 1] ?? '')) {
      chars[i] = ' ';
      i++;
      while (i < masked.length && /[A-Za-z0-9_.:]/.test(masked[i]!)) {
        chars[i] = ' ';
        i++;
      }
      let p = i;
      while (p < masked.length && (masked[p] === ' ' || masked[p] === '\t')) p++;
      if (masked[p] === '(') {
        while (i <= p) {
          chars[i] = ' ';
          i++;
        }
        let depth = 1;
        while (i < masked.length && depth > 0) {
          if (masked[i] === '(') depth++;
          else if (masked[i] === ')') depth--;
          chars[i] = masked[i] === '\n' ? '\n' : ' ';
          i++;
        }
      }
      continue;
    }
    chars[i] = masked[i]!;
    i++;
  }
  return chars.join('');
}

function stripKotlinBackticks(identOrPath: string): string {
  return identOrPath.replace(/`/g, '');
}

function offsetToLine(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Indexes Java & Kotlin package declarations and top-level types across the workspace.
 */
export function buildJvmWorkspaceIndex(
  workspaceRoot: string,
  jvmNodes: ReadonlyArray<{ relativePath: string; isTestFile: boolean; language: 'java' | 'kotlin' }>,
): JvmWorkspaceIndex {
  const fqcnToFiles = new Map<string, string[]>();
  const packageToProdDecls = new Map<string, JvmProdDecl[]>();
  const fpParts: string[] = [];

  const addFqcn = (fqcn: string, file: string) => {
    const list = fqcnToFiles.get(fqcn) ?? [];
    if (!list.includes(file)) {
      list.push(file);
      fqcnToFiles.set(fqcn, list);
    }
  };

  for (const node of jvmNodes) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(workspaceRoot, node.relativePath), 'utf8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    const masked = maskJvmCommentsAndStrings(raw, node.language === 'kotlin');
    const declReady = stripKotlinBackticks(blankJvmAnnotations(masked));
    const pkgMatch = /(?:^|\n)[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*;?/.exec(
      declReady,
    );
    const pkgName = pkgMatch?.[1]?.trim() ?? '';

    const stem = path.posix.basename(node.relativePath, path.posix.extname(node.relativePath));
    const types = new Set<string>([stem]);

    const declRe =
      /(?:^|[\n;{])\s*(?:(?:public|internal|private|protected|abstract|final|sealed|open|data|value|enum|annotation|static|expect|actual|inner|fun)\s+)*(?:class|interface|enum|record|object)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const dm of declReady.matchAll(declRe)) {
      if (dm[1]) types.add(dm[1]);
    }

    // Kotlin top-level functions/vals/const vals/typealiases (including `@Composable fun ...` and `const val ...`)
    if (node.language === 'kotlin') {
      const ktTopRe =
        /(?:^|\n)[ \t]*(?:(?:public|internal|private|inline|noinline|crossinline|suspend|override|infix|operator|const|lateinit|tailrec|external|expect|actual)\s+)*(?:fun|val|var|typealias)\s+(?:<[^>]{1,120}>\s*)?(?:[A-Za-z0-9_<>?, ]{1,120}\.)?([A-Za-z_][A-Za-z0-9_]*)/g;
      for (const km of declReady.matchAll(ktTopRe)) {
        if (km[1]) types.add(km[1]);
      }
    }

    if (pkgName) {
      const symbolList = Array.from(types).sort();
      for (const t of symbolList) {
        addFqcn(`${pkgName}.${t}`, node.relativePath);
      }
      if (!node.isTestFile) {
        const list = packageToProdDecls.get(pkgName) ?? [];
        list.push({ file: node.relativePath, symbols: symbolList });
        packageToProdDecls.set(pkgName, list);
      }
      fpParts.push(`${node.relativePath}:${pkgName}:${symbolList.join(',')}`);
    }
  }

  return { fqcnToFiles, packageToProdDecls, fingerprint: fpParts.join('|') };
}

/**
 * Deterministic zero-native-addon Java & Kotlin import parser.
 */
export function parseJvmImports(
  sourceFilePosix: string,
  rawSourceText: string,
  language: 'java' | 'kotlin',
  isTestFile: boolean,
  jvmIndex: JvmWorkspaceIndex,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const masked = maskJvmCommentsAndStrings(sourceText, language === 'kotlin');
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

  // 1. Explicit & wildcard imports (`import [static] com.acme.Foo[.bar] [as Alias];`, including Kotlin `` `in` `` segments)
  const importRe =
    /(?:^|\n)[ \t]*import[ \t]+(?:static[ \t]+)?((?:`?[A-Za-z_][A-Za-z0-9_]*`?)(?:\.(?:`?[A-Za-z_][A-Za-z0-9_]*`?))*(?:\.\*)?)(?:[ \t]+as[ \t]+`?[A-Za-z_][A-Za-z0-9_]*`?)?[ \t]*;?/g;
  for (const m of masked.matchAll(importRe)) {
    const spec = stripKotlinBackticks((m[1] ?? '').trim());
    if (!spec || JVM_EXTERNAL_PREFIXES.some((p) => spec.startsWith(p))) continue;
    const kwOffset = (m.index ?? 0) + m[0].indexOf('import');
    const line = offsetToLine(sourceText, kwOffset);

    if (spec.endsWith('.*')) {
      const pkgOrClass = spec.slice(0, -2);
      // Could be `import static com.acme.MyClass.*` OR `import com.acme.pkg.*`
      const exactClassFiles = jvmIndex.fqcnToFiles.get(pkgOrClass);
      if (exactClassFiles && exactClassFiles.length > 0) {
        for (const tf of exactClassFiles) {
          if (tf !== sourceFilePosix) {
            pushUnique({
              sourceFile: sourceFilePosix,
              targetFile: tf,
              specifier: sanitizeUntrustedIdentifier(spec, 160),
              line,
              snippet: getSnippet(line),
              kind: 'static_import',
              confidence: 'high',
            });
          }
        }
        continue;
      }
      const pkgFiles = (jvmIndex.packageToProdDecls.get(pkgOrClass) ?? [])
        .map((d) => d.file)
        .filter((f) => f !== sourceFilePosix);
      for (const tf of pkgFiles.slice(0, MAX_WILDCARD_FANOUT)) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: tf,
          specifier: sanitizeUntrustedIdentifier(spec, 160),
          line,
          snippet: getSnippet(line),
          kind: 'package_import',
          confidence: 'low',
          note: 'Wildcard package import (`.*`) — verify specific class usage manually.',
        });
      }
      continue;
    }

    // Exact FQCN, nested class, or static member (`com.acme.Foo`, `com.acme.Foo.Builder.create`)
    let matchedFiles = jvmIndex.fqcnToFiles.get(spec);
    if (!matchedFiles) {
      let probe = spec;
      while (!matchedFiles) {
        const lastDot = probe.lastIndexOf('.');
        if (lastDot <= 0) break;
        probe = probe.slice(0, lastDot);
        matchedFiles = jvmIndex.fqcnToFiles.get(probe);
      }
    }
    if (matchedFiles) {
      for (const tf of matchedFiles) {
        if (tf !== sourceFilePosix) {
          pushUnique({
            sourceFile: sourceFilePosix,
            targetFile: tf,
            specifier: sanitizeUntrustedIdentifier(spec, 160),
            line,
            snippet: getSnippet(line),
            kind: 'static_import',
            confidence: 'high',
          });
        }
      }
    }
  }

  // 2. Same-package implicit references (both production siblings & test files in the same Java/Kotlin package!)
  const cleanMasked = stripKotlinBackticks(masked);
  const pkgMatch = /(?:^|\n)[ \t]*package[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*;?/.exec(
    cleanMasked,
  );
  if (pkgMatch?.[1]) {
    const pkgName = pkgMatch[1].trim();
    const pkgLine = offsetToLine(sourceText, (pkgMatch.index ?? 0) + pkgMatch[0].indexOf('package'));
    const peers = (jvmIndex.packageToProdDecls.get(pkgName) ?? []).filter((d) => d.file !== sourceFilePosix);
    const bodyWithoutHeader = cleanMasked
      .replace(/(?:^|\n)[ \t]*package[ \t]+[^\n;]+;?/g, '\n')
      .replace(/(?:^|\n)[ \t]*import[ \t]+[^\n;]+;?/g, '\n');
    const bodyIdents = new Set(bodyWithoutHeader.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

    const stem = path.posix
      .basename(sourceFilePosix, path.posix.extname(sourceFilePosix))
      .replace(/IT$/, '')
      .replace(/(Tests?|Spec)$/i, '')
      .replace(/^Test(?=[A-Z0-9])/, '');

    for (const peer of peers) {
      const clsName = path.posix.basename(peer.file, path.posix.extname(peer.file));
      const isNameMatchedTest = isTestFile && clsName.toLowerCase() === stem.toLowerCase();
      const isReferencedInBody = peer.symbols.some((sym) => sym.length >= 2 && bodyIdents.has(sym));
      if (isNameMatchedTest || isReferencedInBody) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: peer.file,
          specifier: `package ${pkgName}`,
          line: pkgLine,
          snippet: getSnippet(pkgLine),
          kind: 'package_import',
          confidence: 'high',
        });
      }
    }
  }

  // 3. Dynamic reflection (`Class.forName(...)`)
  for (const dm of masked.matchAll(/\bClass\.forName\s*\(/g)) {
    const line = offsetToLine(sourceText, dm.index ?? 0);
    pushUnique({
      sourceFile: sourceFilePosix,
      targetFile: null,
      specifier: 'Class.forName',
      line,
      snippet: getSnippet(line),
      kind: 'dynamic_import',
      confidence: 'low',
      note: 'Dynamic JVM reflection Class.forName() detected — verify runtime class dependency manually.',
    });
  }

  return results;
}
