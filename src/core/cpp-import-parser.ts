import path from 'node:path';
import { sanitizeUntrustedIdentifier, toPosixPath } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

const CPP_STD_HEADER_NAMES = new Set([
  'algorithm', 'any', 'array', 'atomic', 'bitset', 'cassert', 'cctype', 'cerrno', 'chrono',
  'climits', 'cmath', 'condition_variable', 'cstddef', 'cstdint', 'cstdio', 'cstdlib', 'cstring',
  'ctime', 'deque', 'exception', 'filesystem', 'format', 'fstream', 'functional', 'future',
  'initializer_list', 'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'iterator', 'limits',
  'list', 'locale', 'map', 'memory', 'mutex', 'new', 'numeric', 'optional', 'ostream', 'queue',
  'random', 'ranges', 'ratio', 'regex', 'set', 'shared_mutex', 'span', 'sstream', 'stack',
  'stdexcept', 'stop_token', 'streambuf', 'string', 'string_view', 'thread', 'tuple', 'type_traits',
  'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray', 'variant',
  'vector', 'stdio.h', 'stdlib.h', 'string.h', 'stdint.h', 'stdbool.h', 'stddef.h', 'math.h',
  'time.h', 'ctype.h', 'errno.h', 'assert.h', 'limits.h', 'unistd.h', 'fcntl.h', 'pthread.h',
  'windows.h', 'winsock2.h',
]);

/**
 * Masks C/C++ `//`, `/* ... *\/`, C++11 raw strings `R"d(...)d"`, and non-`#include` normal string literals
 * (including `\`-continued multiline strings) while keeping `#include "..."` directives intact.
 */
function maskCppCommentsAndRawStrings(source: string): string {
  const chars = new Array<string>(source.length);
  let i = 0;
  let lineStart = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '\n') {
      chars[i] = '\n';
      i++;
      lineStart = i;
      continue;
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
        if (source[i] === '\n') lineStart = i + 1;
        i++;
      }
      continue;
    }

    // C++11 raw string literal `R"delim(...)delim"`
    if (ch === 'R' && next === '"' && (i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]!))) {
      const parenIdx = source.indexOf('(', i + 2);
      if (parenIdx !== -1 && parenIdx - (i + 2) <= 16) {
        const delim = source.slice(i + 2, parenIdx);
        const closeSeq = `)${delim}"`;
        const closeIdx = source.indexOf(closeSeq, parenIdx + 1);
        if (closeIdx !== -1) {
          const end = closeIdx + closeSeq.length;
          for (let k = i; k < end; k++) {
            chars[k] = source[k] === '\n' ? '\n' : ' ';
            if (source[k] === '\n') lineStart = k + 1;
          }
          i = end;
          continue;
        }
      }
    }

    // Single-char literal (`'"'`, `'\"'`, `'\n'`) — avoid `'"'` opening a fake string while ignoring C++14 `1'000` digit separators!
    if (ch === "'") {
      const rest = source.slice(i, Math.min(source.length, i + 6));
      const charLit = /^'(?:\\.|[^'\\\n])'/.exec(rest);
      if (charLit) {
        for (let k = 0; k < charLit[0].length; k++) chars[i + k] = ' ';
        i += charLit[0].length;
        continue;
      }
    }

    // Preserve `#include "..."` and `#import "..."` verbatim (checking already-masked `chars` so `#include /* c */ "x.h"` works!),
    // while masking all other double-quoted strings (including backslash-continued multiline strings).
    if (ch === '"') {
      const maskedLinePrefix = chars.slice(lineStart, i).join('');
      if (/^[ \t]*#[ \t]*(?:include|import)[ \t]*$/.test(maskedLinePrefix)) {
        chars[i] = '"';
        i++;
        while (i < source.length && source[i] !== '\n') {
          chars[i] = source[i]!;
          if (source[i] === '"') {
            i++;
            break;
          }
          i++;
        }
        continue;
      }
      chars[i] = ' ';
      i++;
      while (i < source.length) {
        if (source[i] === '\\') {
          chars[i] = ' ';
          if (i + 1 < source.length) {
            if (source[i + 1] === '\r' && source[i + 2] === '\n') {
              chars[i + 1] = ' ';
              chars[i + 2] = '\n';
              lineStart = i + 3;
              i += 3;
              continue;
            }
            chars[i + 1] = source[i + 1] === '\n' ? '\n' : ' ';
            if (source[i + 1] === '\n') lineStart = i + 2;
            i += 2;
            continue;
          }
          i++;
          continue;
        }
        if (source[i] === '\n') {
          chars[i] = '\n';
          lineStart = i + 1;
          i++;
          break;
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

function resolveCppInclude(
  sourceFilePosix: string,
  includeSpec: string,
  isQuoted: boolean,
  allFileSet: ReadonlySet<string>,
  includeSearchRoots: readonly string[],
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): string | null {
  const cleanSpec = toPosixPath(includeSpec).replace(/^\/+/, '');
  if (!cleanSpec) return null;
  if (!isQuoted && CPP_STD_HEADER_NAMES.has(cleanSpec.toLowerCase())) {
    return null;
  }

  const importerDir = path.posix.dirname(sourceFilePosix);
  const bases: string[] = [];
  if (isQuoted) {
    bases.push(importerDir === '.' ? '' : importerDir);
  }
  bases.push('', 'include', 'src');
  for (const r of includeSearchRoots) {
    if (!bases.includes(r)) bases.push(r);
  }

  for (const base of bases) {
    const joined = base ? path.posix.normalize(`${base}/${cleanSpec}`) : path.posix.normalize(cleanSpec);
    if (joined === '..' || joined.startsWith('../')) continue;
    if (allFileSet.has(joined)) return joined;
    if (caseInsensitiveMap) {
      const ci = caseInsensitiveMap.get(joined.toLowerCase());
      if (ci) return ci;
    }
  }

  return null;
}

/**
 * Collects unique `include` directories across the workspace (e.g. `include`, `libs/math/include`) once per scan.
 */
export function collectCppIncludeRoots(allFileSet: ReadonlySet<string>): string[] {
  const roots = new Set<string>(['', 'include', 'src']);
  for (const f of allFileSet) {
    const parts = f.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!.toLowerCase();
      if (seg === 'include' || seg === 'inc') {
        roots.add(parts.slice(0, i + 1).join('/'));
      }
    }
  }
  return Array.from(roots).sort();
}

/**
 * Deterministic zero-native-addon C/C++ `#include` dependency parser.
 */
export function parseCppImports(
  sourceFilePosix: string,
  rawSourceText: string,
  allFileSet: ReadonlySet<string>,
  includeSearchRoots: readonly string[],
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const masked = maskCppCommentsAndRawStrings(sourceText);
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

  const includeRe = /(?:^|\n)[ \t]*#[ \t]*(?:include|import)[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/g;
  for (const m of masked.matchAll(includeRe)) {
    const isQuoted = m[1] !== undefined;
    const spec = (m[1] ?? m[2] ?? '').trim();
    const hashOffset = (m.index ?? 0) + m[0].indexOf('#');
    const line = offsetToLine(sourceText, hashOffset);

    const targetFile = resolveCppInclude(
      sourceFilePosix,
      spec,
      isQuoted,
      allFileSet,
      includeSearchRoots,
      caseInsensitiveMap,
    );
    if (targetFile && targetFile !== sourceFilePosix) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile,
        specifier: sanitizeUntrustedIdentifier(spec, 160),
        line,
        snippet: getSnippet(line),
        kind: 'include_header',
        confidence: 'high',
      });
    } else if (isQuoted) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: sanitizeUntrustedIdentifier(spec, 160),
        line,
        snippet: getSnippet(line),
        kind: 'unresolved_import',
        confidence: 'low',
        note: 'Quoted local #include header could not be resolved in indexed workspace directories.',
      });
    }
  }

  // Detect dynamic library loading (`dlopen`, `LoadLibraryA/W`) as low-confidence warnings
  for (const dm of masked.matchAll(/\b(dlopen|LoadLibrary[AW]?)\s*\(/g)) {
    const line = offsetToLine(sourceText, dm.index ?? 0);
    pushUnique({
      sourceFile: sourceFilePosix,
      targetFile: null,
      specifier: dm[1]!,
      line,
      snippet: getSnippet(line),
      kind: 'dynamic_import',
      confidence: 'low',
      note: `Dynamic native library loader "${dm[1]}" detected — verify runtime module dependency manually.`,
    });
  }

  return results;
}
