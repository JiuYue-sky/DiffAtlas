import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUntrustedIdentifier } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

export interface CSharpFileDecl {
  file: string;
  namespaces: string[];
  declaredTypes: string[];
}

export interface CSharpWorkspaceIndex {
  /** Namespace (`MyApp.Services`) -> non-test file declarations in that namespace */
  nsToDecls: Map<string, CSharpFileDecl[]>;
  /** Qualified type (`MyApp.Services.AuthService`) -> file path(s) */
  fqTypeToFiles: Map<string, string[]>;
  fingerprint: string;
}

const CS_FRAMEWORK_PREFIXES = ['System', 'Microsoft', 'Windows', 'Xunit', 'NUnit', 'Moq', 'FluentAssertions'];
const MAX_NAMESPACE_FALLBACK_FILES = 64;

function isFrameworkNamespace(ns: string): boolean {
  return CS_FRAMEWORK_PREFIXES.some((p) => ns === p || ns.startsWith(`${p}.`));
}

/**
 * Masks C# `//`, `/* ... *\/`, verbatim strings (`@"..."`), raw strings (`"""..."""`), and standard strings,
 * while preserving `{ ... }` expression holes inside interpolated strings (`$"..."`, `$@"..."`, `@$"..."`)!
 */
function maskCSharpCommentsAndStrings(source: string): string {
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

      // Raw string literals (`"""..."""` or `$"""..."""` / `$$"""..."""`)
      if (ch === '$' || ch === '"') {
        let dollarCount = 0;
        while (source[i + dollarCount] === '$') dollarCount++;
        const qStart = i + dollarCount;
        if (source[qStart] === '"' && source[qStart + 1] === '"' && source[qStart + 2] === '"') {
          let qCount = 0;
          while (source[qStart + qCount] === '"') qCount++;
          for (let k = i; k < qStart + qCount; k++) chars[k] = ' ';
          i = qStart + qCount;
          const closeSeq = '"'.repeat(qCount);
          const closeIdx = source.indexOf(closeSeq, i);
          const end = closeIdx === -1 ? source.length : closeIdx + qCount;
          for (let k = i; k < end; k++) chars[k] = source[k] === '\n' ? '\n' : ' ';
          i = end;
          continue;
        }
      }

      // Verbatim string (`@"..."`) and interpolated verbatim string (`$@"..."` or `@$"..."`)
      if (
        (ch === '@' && next === '"') ||
        (ch === '$' && next === '@' && source[i + 2] === '"') ||
        (ch === '@' && next === '$' && source[i + 2] === '"')
      ) {
        const isInterp = ch === '$' || next === '$';
        const qOffset = next === '"' ? i + 1 : i + 2;
        for (let k = i; k <= qOffset; k++) chars[k] = ' ';
        i = qOffset + 1;
        while (i < source.length) {
          if (source[i] === '"' && source[i + 1] === '"') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            continue;
          }
          if (isInterp && (source[i] === '{' || source[i] === '}') && source[i + 1] === source[i]) {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            continue;
          }
          if (isInterp && source[i] === '{') {
            chars[i] = '{';
            i = scanCodeRange(i + 1, true);
            continue;
          }
          if (source[i] === '"') {
            chars[i] = ' ';
            i++;
            break;
          }
          chars[i] = source[i] === '\n' ? '\n' : ' ';
          i++;
        }
        continue;
      }

      // Interpolated regular string (`$"..."`)
      if (ch === '$' && next === '"') {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
        while (i < source.length && source[i] !== '\n') {
          if (source[i] === '\\') {
            chars[i] = ' ';
            if (i + 1 < source.length) chars[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
            i = Math.min(i + 2, source.length);
            continue;
          }
          if ((source[i] === '{' || source[i] === '}') && source[i + 1] === source[i]) {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i += 2;
            continue;
          }
          if (source[i] === '{') {
            chars[i] = '{';
            i = scanCodeRange(i + 1, true);
            continue;
          }
          if (source[i] === '"') {
            chars[i] = ' ';
            i++;
            break;
          }
          chars[i] = ' ';
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
 * Blanks balanced `[...]` C# attribute lists (including nested brackets like `[TypeFilter(typeof(string[]))]`)
 * at declaration boundaries without touching array return types like `int[] GetItems()`.
 */
function blankCSharpAttributes(masked: string): string {
  const chars = new Array<string>(masked.length);
  let i = 0;
  let canStartAttr = true;

  while (i < masked.length) {
    const ch = masked[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      chars[i] = ch;
      i++;
      continue;
    }
    if (canStartAttr && ch === '[') {
      let depth = 1;
      chars[i] = ' ';
      i++;
      while (i < masked.length && depth > 0) {
        if (masked[i] === '[') depth++;
        else if (masked[i] === ']') depth--;
        chars[i] = masked[i] === '\n' ? '\n' : ' ';
        i++;
      }
      // Consecutive `[Attr1][Attr2]` can immediately follow!
      canStartAttr = true;
      continue;
    }
    canStartAttr = ch === '{' || ch === '}' || ch === ';';
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
 * Indexes C# `namespace` declarations and declared types (`class`, `interface`, `struct`, `record`, `enum`).
 */
export function buildCSharpWorkspaceIndex(
  workspaceRoot: string,
  csNodes: ReadonlyArray<{ relativePath: string; isTestFile: boolean }>,
): CSharpWorkspaceIndex {
  const nsToDecls = new Map<string, CSharpFileDecl[]>();
  const fqTypeToFiles = new Map<string, string[]>();
  const fpParts: string[] = [];

  for (const node of csNodes) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(workspaceRoot, node.relativePath), 'utf8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    const masked = maskCSharpCommentsAndStrings(raw);
    const namespaces: string[] = [];
    // Support BOTH file-scoped (`namespace Foo;`), K&R (`namespace Foo {`), AND Allman (`namespace Foo\n{`)!
    for (const nm of masked.matchAll(/(?:^|\n)[ \t]*namespace[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:;|\{)/g)) {
      if (nm[1] && !namespaces.includes(nm[1])) namespaces.push(nm[1]);
    }
    if (namespaces.length === 0) continue;

    const declaredTypes = new Set<string>();
    const declReady = blankCSharpAttributes(masked);
    const typeRe =
      /(?:^|[\n;{])\s*(?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|ref|file|unsafe|new)\s+)*(?:record\s+(?:class|struct)|class|interface|struct|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (const tm of declReady.matchAll(typeRe)) {
      if (tm[1]) declaredTypes.add(tm[1]);
    }
    // Also index C# delegate declarations (`public delegate Task OrderHandler(...)`)
    const delegateRe =
      /(?:^|[\n;{])\s*(?:(?:public|internal|private|protected|unsafe|new)\s+)*delegate\s+[A-Za-z0-9_<>.,?\[\] ]{1,120}\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/g;
    for (const dm of declReady.matchAll(delegateRe)) {
      if (dm[1]) declaredTypes.add(dm[1]);
    }
    const typeArr = Array.from(declaredTypes).sort();
    const decl: CSharpFileDecl = { file: node.relativePath, namespaces, declaredTypes: typeArr };

    for (const ns of namespaces) {
      if (!node.isTestFile) {
        const list = nsToDecls.get(ns) ?? [];
        list.push(decl);
        nsToDecls.set(ns, list);
      }
      for (const t of typeArr) {
        const fq = `${ns}.${t}`;
        const files = fqTypeToFiles.get(fq) ?? [];
        if (!files.includes(node.relativePath)) {
          files.push(node.relativePath);
          fqTypeToFiles.set(fq, files);
        }
      }
    }
    fpParts.push(`${node.relativePath}:${namespaces.join(',')}:${typeArr.join(',')}`);
  }

  return { nsToDecls, fqTypeToFiles, fingerprint: fpParts.join('|') };
}

/**
 * Deterministic zero-native-addon C# dependency parser (`using`, `using static`, `using Alias =`, and type-filtered namespace matching).
 */
export function parseCSharpImports(
  sourceFilePosix: string,
  rawSourceText: string,
  csIndex: CSharpWorkspaceIndex,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const masked = maskCSharpCommentsAndStrings(sourceText);
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

  // Strip ONLY top-level `using` directives (NEVER `using var x = new Service();` local resource declarations!)
  const bodyWithoutUsings = masked.replace(
    /(?:^|\n)[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+|[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*)?(?:global::)?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*[ \t]*;/g,
    '\n',
  );
  const bodyIdents = new Set(bodyWithoutUsings.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);

  // 1. `using static A.B.Type;` and `using Alias = [global::]A.B.Type;` (exact type targets -> High Confidence)
  const exactUsingRe =
    /(?:^|\n)[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+|[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*)(?:global::)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*;/g;
  for (const m of masked.matchAll(exactUsingRe)) {
    const fq = (m[1] ?? '').trim();
    if (!fq || isFrameworkNamespace(fq)) continue;
    const kwOffset = (m.index ?? 0) + m[0].indexOf('using');
    const line = offsetToLine(sourceText, kwOffset);
    const files = csIndex.fqTypeToFiles.get(fq);
    if (files) {
      for (const tf of files) {
        if (tf !== sourceFilePosix) {
          pushUnique({
            sourceFile: sourceFilePosix,
            targetFile: tf,
            specifier: sanitizeUntrustedIdentifier(fq, 160),
            line,
            snippet: getSnippet(line),
            kind: 'static_import',
            confidence: 'high',
          });
        }
      }
    }
  }

  // 2. Namespace `using [global::]MyApp.Services;` — narrow by declared type identifiers actually referenced in body!
  const nsUsingRe =
    /(?:^|\n)[ \t]*(?:global[ \t]+)?using[ \t]+(?:global::)?([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)[ \t]*;/g;
  for (const m of masked.matchAll(nsUsingRe)) {
    const ns = (m[1] ?? '').trim();
    if (!ns || isFrameworkNamespace(ns)) continue;
    const kwOffset = (m.index ?? 0) + m[0].indexOf('using');
    const line = offsetToLine(sourceText, kwOffset);
    const decls = (csIndex.nsToDecls.get(ns) ?? []).filter((d) => d.file !== sourceFilePosix);
    if (decls.length === 0) continue;

    // Prefer exact files whose declared types appear in this file's body (O(1) Set lookup)
    const typeMatched = decls.filter((d) =>
      d.declaredTypes.some((tName) => tName.length >= 2 && bodyIdents.has(tName)),
    );

    if (typeMatched.length > 0) {
      for (const d of typeMatched) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: d.file,
          specifier: sanitizeUntrustedIdentifier(ns, 160),
          line,
          snippet: getSnippet(line),
          kind: 'namespace_import',
          confidence: 'high',
        });
      }
    } else if (decls.length === 1) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: decls[0]!.file,
        specifier: sanitizeUntrustedIdentifier(ns, 160),
        line,
        snippet: getSnippet(line),
        kind: 'namespace_import',
        confidence: 'low',
        note: 'Namespace-level C# using directive (no direct type match in body; may use extension methods).',
      });
    } else {
      for (const d of decls.slice(0, MAX_NAMESPACE_FALLBACK_FILES)) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: d.file,
          specifier: sanitizeUntrustedIdentifier(ns, 160),
          line,
          snippet: getSnippet(line),
          kind: 'namespace_import',
          confidence: 'low',
          note: 'Namespace-level C# using directive spanning multiple files — verify manually.',
        });
      }
    }
  }

  // 3. Same-namespace implicit references (two C# files sharing a namespace without explicit `using`)
  for (const nm of masked.matchAll(/(?:^|\n)[ \t]*namespace[ \t]+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:;|\{)/g)) {
    const ownNs = nm[1]?.trim();
    if (!ownNs) continue;
    const nsLine = offsetToLine(sourceText, (nm.index ?? 0) + nm[0].indexOf('namespace'));
    const peers = (csIndex.nsToDecls.get(ownNs) ?? []).filter((d) => d.file !== sourceFilePosix);
    for (const peer of peers) {
      const mentionsPeerType = peer.declaredTypes.some((tName) => tName.length >= 2 && bodyIdents.has(tName));
      if (mentionsPeerType) {
        pushUnique({
          sourceFile: sourceFilePosix,
          targetFile: peer.file,
          specifier: `namespace ${ownNs}`,
          line: nsLine,
          snippet: getSnippet(nsLine),
          kind: 'namespace_import',
          confidence: 'high',
        });
      }
    }
  }

  // 4. Dynamic reflection (`Assembly.Load*` / `Type.GetType`)
  for (const dm of masked.matchAll(/\b(Assembly\.Load(?:From|File)?|Type\.GetType)\s*\(/g)) {
    const line = offsetToLine(sourceText, dm.index ?? 0);
    pushUnique({
      sourceFile: sourceFilePosix,
      targetFile: null,
      specifier: dm[1]!,
      line,
      snippet: getSnippet(line),
      kind: 'dynamic_import',
      confidence: 'low',
      note: `Dynamic .NET reflection "${dm[1]}" detected — verify runtime assembly dependency manually.`,
    });
  }

  return results;
}
