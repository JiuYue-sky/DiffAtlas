import path from 'node:path';
import { sanitizeUntrustedIdentifier } from '../kit/path-guard.js';
import type { ParsedImportRecord } from './ts-import-parser.js';

const PYTHON_STDLIB_TOP_LEVEL = new Set([
  '__future__',
  'abc',
  'argparse',
  'array',
  'ast',
  'asyncio',
  'atexit',
  'base64',
  'binascii',
  'bisect',
  'builtins',
  'calendar',
  'cmath',
  'cmd',
  'code',
  'codecs',
  'collections',
  'colorsys',
  'concurrent',
  'configparser',
  'contextlib',
  'contextvars',
  'copy',
  'copyreg',
  'csv',
  'ctypes',
  'dataclasses',
  'datetime',
  'decimal',
  'difflib',
  'dis',
  'email',
  'encodings',
  'enum',
  'errno',
  'faulthandler',
  'fcntl',
  'filecmp',
  'fileinput',
  'fnmatch',
  'fractions',
  'ftplib',
  'functools',
  'gc',
  'getopt',
  'getpass',
  'gettext',
  'glob',
  'graphlib',
  'gzip',
  'hashlib',
  'heapq',
  'hmac',
  'html',
  'http',
  'imaplib',
  'importlib',
  'inspect',
  'io',
  'ipaddress',
  'itertools',
  'json',
  'keyword',
  'linecache',
  'locale',
  'logging',
  'lzma',
  'math',
  'mimetypes',
  'mmap',
  'multiprocessing',
  'netrc',
  'numbers',
  'operator',
  'os',
  'pathlib',
  'pdb',
  'pickle',
  'pkgutil',
  'platform',
  'plistlib',
  'posixpath',
  'pprint',
  'profile',
  'pstats',
  'queue',
  'quopri',
  'random',
  're',
  'readline',
  'reprlib',
  'resource',
  'runpy',
  'sched',
  'secrets',
  'select',
  'selectors',
  'shelve',
  'shlex',
  'shutil',
  'signal',
  'site',
  'smtplib',
  'socket',
  'socketserver',
  'sqlite3',
  'ssl',
  'stat',
  'statistics',
  'string',
  'struct',
  'subprocess',
  'sys',
  'sysconfig',
  'tarfile',
  'tempfile',
  'termios',
  'textwrap',
  'threading',
  'time',
  'timeit',
  'tkinter',
  'token',
  'tokenize',
  'tomllib',
  'trace',
  'traceback',
  'tracemalloc',
  'tty',
  'turtle',
  'types',
  'typing',
  'unicodedata',
  'unittest',
  'urllib',
  'uuid',
  'venv',
  'warnings',
  'wave',
  'weakref',
  'webbrowser',
  'winreg',
  'winsound',
  'wsgiref',
  'xml',
  'xmlrpc',
  'zipapp',
  'zipfile',
  'zipimport',
  'zlib',
  'zoneinfo',
]);

interface PyLogicalStatement {
  text: string;
  startLine: number;
}

/**
 * Tokenizes Python source into logical statements while cleanly stripping `#` comments
 * and blanking single/triple-quoted strings & docstrings so docstrings NEVER cause false-positive imports!
 * Properly joins parenthesized `(...)` blocks and `\` line continuations while preserving the true `startLine`.
 */
function extractPythonLogicalStatements(sourceText: string): {
  statements: PyLogicalStatement[];
  lines: string[];
  hasDynamicImportlibHook: boolean;
} {
  const lines = sourceText.split(/\r?\n/);
  const chars = new Array<string>(sourceText.length);
  let i = 0;

  while (i < sourceText.length) {
    const ch = sourceText[i]!;

    // Hash comment
    if (ch === '#') {
      while (i < sourceText.length && sourceText[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }

    // Triple-quoted or single-quoted string literals (including r/b/u/f prefixes handled naturally)
    if (ch === "'" || ch === '"') {
      const isTriple = sourceText[i + 1] === ch && sourceText[i + 2] === ch;
      const delimLen = isTriple ? 3 : 1;
      for (let k = 0; k < delimLen; k++) chars[i + k] = ch;
      i += delimLen;
      while (i < sourceText.length) {
        const sc = sourceText[i]!;
        if (sc === '\\') {
          chars[i] = ' ';
          if (i + 1 < sourceText.length) chars[i + 1] = sourceText[i + 1] === '\n' ? '\n' : ' ';
          i = Math.min(i + 2, sourceText.length);
          continue;
        }
        if (isTriple && sc === ch && sourceText[i + 1] === ch && sourceText[i + 2] === ch) {
          chars[i] = ch;
          chars[i + 1] = ch;
          chars[i + 2] = ch;
          i += 3;
          break;
        }
        if (!isTriple && sc === ch) {
          chars[i] = ch;
          i++;
          break;
        }
        chars[i] = sc === '\n' ? '\n' : ' ';
        i++;
      }
      continue;
    }

    chars[i] = ch;
    i++;
  }

  const masked = chars.join('');
  const hasDynamicImportlibHook =
    /\b(?:importlib\.import_module|importlib\.util\.spec_from_file_location|spec_from_file_location|__import__)\s*\(/.test(
      masked,
    );

  // Split into logical statements respecting parentheses `()`, brackets `[]`, braces `{}`, `;`, and `\` continuations
  const statements: PyLogicalStatement[] = [];
  let buf = '';
  let stmtStartLine = 1;
  let currentLine = 1;
  let parenDepth = 0;

  const flush = () => {
    const trimmed = buf.trim();
    if (trimmed.length > 0) {
      statements.push({ text: trimmed, startLine: stmtStartLine });
    }
    buf = '';
  };

  for (let p = 0; p < masked.length; p++) {
    const ch = masked[p]!;
    if (buf.trim().length === 0 && ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n' && ch !== ';') {
      stmtStartLine = currentLine;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      parenDepth++;
      buf += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      parenDepth = Math.max(0, parenDepth - 1);
      buf += ch;
      continue;
    }

    // Explicit backslash line continuation
    if (ch === '\\' && (masked[p + 1] === '\n' || (masked[p + 1] === '\r' && masked[p + 2] === '\n'))) {
      if (masked[p + 1] === '\r') p += 2;
      else p += 1;
      currentLine++;
      buf += ' ';
      continue;
    }

    if (ch === '\n') {
      currentLine++;
      if (parenDepth === 0) {
        flush();
      } else {
        buf += ' ';
      }
      continue;
    }

    if (ch === ';' && parenDepth === 0) {
      flush();
      continue;
    }

    if (ch !== '\r') {
      buf += ch;
    }
  }
  flush();

  return { statements, lines, hasDynamicImportlibHook };
}

function resolvePyModulePath(baseDirPosix: string, modulePathParts: readonly string[], pyFileSet: ReadonlySet<string>): string | null {
  if (modulePathParts.length === 0) return null;
  const relJoined = baseDirPosix
    ? path.posix.normalize(`${baseDirPosix}/${modulePathParts.join('/')}`)
    : path.posix.normalize(modulePathParts.join('/'));
  if (relJoined === '..' || relJoined.startsWith('../')) return null;

  const asPy = `${relJoined}.py`;
  if (pyFileSet.has(asPy)) return asPy;

  const asInit = `${relJoined}/__init__.py`;
  if (pyFileSet.has(asInit)) return asInit;

  const asPyi = `${relJoined}.pyi`;
  if (pyFileSet.has(asPyi)) return asPyi;

  return null;
}

/**
 * Resolves an absolute Python dotted module (e.g. `pkg.sub.mod`) against:
 * 1. Workspace root (`pkg/sub/mod.py` or `pkg/sub/mod/__init__.py`)
 * 2. `src/` layout (`src/pkg/sub/mod.py`)
 * 3. Same package root as importer (`<dir>/pkg/sub/mod.py`)
 */
function resolveAbsolutePythonModule(
  sourceFilePosix: string,
  dottedModule: string,
  pyFileSet: ReadonlySet<string>,
  pyBasenameIndex: ReadonlyMap<string, readonly string[]>,
  hasDynamicImportlibHook: boolean,
  allowDynamicAliasFallback = true,
): { targetFile: string | null; kind: ParsedImportRecord['kind']; confidence: 'high' | 'low'; isLocalOrCandidate: boolean; note?: string } {
  const parts = dottedModule.split('.').filter(Boolean);
  if (parts.length === 0) {
    return { targetFile: null, kind: 'unresolved_import', confidence: 'low', isLocalOrCandidate: false };
  }
  const topPkg = parts[0]!;
  if (PYTHON_STDLIB_TOP_LEVEL.has(topPkg)) {
    return { targetFile: null, kind: 'static_import', confidence: 'high', isLocalOrCandidate: false };
  }

  // 1. Direct root or `src/` or importer-sibling resolution
  const importerDir = path.posix.dirname(sourceFilePosix);
  const searchBases = ['', 'src', ...(importerDir !== '.' ? [importerDir] : [])];

  // Try full dotted path first
  for (const base of searchBases) {
    const direct = resolvePyModulePath(base, parts, pyFileSet);
    if (direct) {
      return { targetFile: direct, kind: 'static_import', confidence: 'high', isLocalOrCandidate: true };
    }
  }

  // 2. Check package-root ancestor (e.g. `bundled_addons/io_scene_ueformat/...` importing `io_scene_ueformat.options`)
  const importerSegments = sourceFilePosix.split('/');
  for (let i = 0; i < importerSegments.length - 1; i++) {
    if (importerSegments[i] === topPkg) {
      const pkgParent = importerSegments.slice(0, i).join('/');
      const resolved = resolvePyModulePath(pkgParent, parts, pyFileSet);
      if (resolved) {
        return { targetFile: resolved, kind: 'static_import', confidence: 'high', isLocalOrCandidate: true };
      }
    }
  }

  // 3. Dynamic alias candidate fallback (e.g., `tests/test_pipeline_suite.py` aliases `ww-auto-core` to `core` via `spec_from_file_location`)
  // ONLY emit as LOW-confidence candidate when unique local file matches leaf module!
  if (allowDynamicAliasFallback) {
    const leaf = parts[parts.length - 1]!;
    const candidates = pyBasenameIndex.get(leaf);
    if (candidates && candidates.length === 1 && (hasDynamicImportlibHook || parts.length >= 2)) {
      return {
        targetFile: candidates[0]!,
        kind: 'dynamic_alias_candidate',
        confidence: 'low',
        isLocalOrCandidate: true,
        note: hasDynamicImportlibHook
          ? `Matched via dynamic importlib alias heuristic (${dottedModule} -> ${candidates[0]}) — confirm manually.`
          : `Unresolved package prefix "${topPkg}" matched unique local module "${candidates[0]}" — confirm sys.path/package alias.`,
      };
    }
  }

  return { targetFile: null, kind: 'unresolved_import', confidence: 'low', isLocalOrCandidate: false };
}

/**
 * Deterministic zero-native-addon Python import parser.
 * Supports `import a, b`, `from .x import (...)`, `from ..pkg import y`, `from . import submod`,
 * and flags `importlib.import_module` / `spec_from_file_location` / `__import__` as low-confidence dynamic imports.
 */
export function parsePythonImports(
  sourceFilePosix: string,
  rawSourceText: string,
  pyFileSet: ReadonlySet<string>,
  pyBasenameIndex: ReadonlyMap<string, readonly string[]>,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const { statements, lines, hasDynamicImportlibHook } = extractPythonLogicalStatements(sourceText);
  const results: ParsedImportRecord[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (rec: ParsedImportRecord) => {
    const key = `${rec.line}:${rec.kind}:${rec.specifier}:${rec.targetFile ?? ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    results.push(rec);
  };

  const getSnippet = (lineNum: number): string => {
    const raw = lines[lineNum - 1] ?? '';
    return sanitizeUntrustedIdentifier(raw.trim(), 140);
  };

  for (const stmt of statements) {
    // Strip single-line suite header prefixes like `if TYPE_CHECKING: from .x import y`, `with suppress(ImportError): import pkg`, or `try: import pkg`
    const text = stmt.text.replace(/^(?:(?:if|elif|with)\s+[^:]+|else|try|except(?:\s+[^:]+)?|finally)\s*:\s*/, '');

    // 1. `from <dots><module?> import <names>` (also handles valid compact `from.mod import x` syntax)
    const fromMatch = /^from(?:\s+|\s*(?=\.))(\.+)?([A-Za-z_][A-Za-z0-9_.]*)?\s+import\s+(.+)$/.exec(text);
    if (fromMatch) {
      const dots = fromMatch[1] ?? '';
      const modName = fromMatch[2] ?? '';
      const rawNames = fromMatch[3]!.replace(/^\(/, '').replace(/\)$/, '').trim();
      const importedSymbols = rawNames
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => s.length > 0 && s !== '*');

      if (dots.length > 0) {
        // Relative import (e.g. `.` = current dir, `..` = parent dir)
        let baseDir = path.posix.dirname(sourceFilePosix);
        if (baseDir === '.') baseDir = '';
        let escapedRoot = false;
        for (let up = 1; up < dots.length; up++) {
          if (!baseDir || baseDir === '.') {
            escapedRoot = true;
            break;
          }
          const parent = path.posix.dirname(baseDir);
          baseDir = parent === '.' ? '' : parent;
        }

        if (escapedRoot) {
          pushUnique({
            sourceFile: sourceFilePosix,
            targetFile: null,
            specifier: `${dots}${modName}`,
            line: stmt.startLine,
            snippet: getSnippet(stmt.startLine),
            kind: 'unresolved_import',
            confidence: 'low',
            note: 'Relative import climbs above workspace root.',
          });
          continue;
        }

        if (modName) {
          const modParts = modName.split('.').filter(Boolean);
          // Always check imported symbols for concrete child submodules FIRST (even when `subpkg/__init__.py` exists!)
          let matchedSubmoduleCount = 0;
          for (const sym of importedSymbols) {
            const childRes = resolvePyModulePath(baseDir, [...modParts, sym], pyFileSet);
            if (childRes) {
              matchedSubmoduleCount++;
              pushUnique({
                sourceFile: sourceFilePosix,
                targetFile: childRes,
                specifier: `${dots}${modName}.${sym}`,
                line: stmt.startLine,
                snippet: getSnippet(stmt.startLine),
                kind: 'static_import',
                confidence: 'high',
              });
            }
          }
          const direct = resolvePyModulePath(baseDir, modParts, pyFileSet);
          const hasNonSubmoduleSymbol = importedSymbols.length === 0 || matchedSubmoduleCount < importedSymbols.length;
          if (direct && (hasNonSubmoduleSymbol || matchedSubmoduleCount === 0)) {
            pushUnique({
              sourceFile: sourceFilePosix,
              targetFile: direct,
              specifier: `${dots}${modName}`,
              line: stmt.startLine,
              snippet: getSnippet(stmt.startLine),
              kind: 'static_import',
              confidence: 'high',
            });
          } else if (!direct && matchedSubmoduleCount === 0) {
            pushUnique({
              sourceFile: sourceFilePosix,
              targetFile: null,
              specifier: `${dots}${modName}`,
              line: stmt.startLine,
              snippet: getSnippet(stmt.startLine),
              kind: 'unresolved_import',
              confidence: 'low',
              note: 'Relative Python module could not be resolved on disk.',
            });
          }
        } else {
          // `from . import a, b` -> resolve sibling modules `a.py`, `b.py`, or fallback to `__init__.py`
          let matchedAny = false;
          for (const sym of importedSymbols) {
            const sibling = resolvePyModulePath(baseDir, [sym], pyFileSet);
            if (sibling) {
              matchedAny = true;
              pushUnique({
                sourceFile: sourceFilePosix,
                targetFile: sibling,
                specifier: `${dots}${sym}`,
                line: stmt.startLine,
                snippet: getSnippet(stmt.startLine),
                kind: 'static_import',
                confidence: 'high',
              });
            }
          }
          if (!matchedAny) {
            const pkgInit = baseDir ? `${baseDir}/__init__.py` : '__init__.py';
            if (pyFileSet.has(pkgInit) && pkgInit !== sourceFilePosix) {
              pushUnique({
                sourceFile: sourceFilePosix,
                targetFile: pkgInit,
                specifier: dots,
                line: stmt.startLine,
                snippet: getSnippet(stmt.startLine),
                kind: 'static_import',
                confidence: 'high',
              });
            }
          }
        }
        continue;
      }

      // Absolute `from pkg.mod import ...`
      if (modName) {
        // 1. Check whether any imported symbol is a concrete static submodule on disk (`pkg/submod.py`)
        // EVEN WHEN `pkg/__init__.py` ALSO EXISTS! (strict static check only, no basename guessing on symbol names)
        let matchedStaticSubmodules = 0;
        for (const sym of importedSymbols) {
          const staticSub = resolveAbsolutePythonModule(
            sourceFilePosix,
            `${modName}.${sym}`,
            pyFileSet,
            pyBasenameIndex,
            hasDynamicImportlibHook,
            false,
          );
          if (staticSub.targetFile) {
            matchedStaticSubmodules++;
            pushUnique({
              sourceFile: sourceFilePosix,
              targetFile: staticSub.targetFile,
              specifier: `${modName}.${sym}`,
              line: stmt.startLine,
              snippet: getSnippet(stmt.startLine),
              kind: staticSub.kind,
              confidence: staticSub.confidence,
            });
          }
        }

        const hasUnmatchedSymbol = importedSymbols.length === 0 || matchedStaticSubmodules < importedSymbols.length;
        if (hasUnmatchedSymbol) {
          const res = resolveAbsolutePythonModule(
            sourceFilePosix,
            modName,
            pyFileSet,
            pyBasenameIndex,
            hasDynamicImportlibHook,
            true,
          );
          if (res.targetFile) {
            pushUnique({
              sourceFile: sourceFilePosix,
              targetFile: res.targetFile,
              specifier: modName,
              line: stmt.startLine,
              snippet: getSnippet(stmt.startLine),
              kind: res.kind,
              confidence: res.confidence,
              ...(res.note ? { note: res.note } : {}),
            });
          } else if (matchedStaticSubmodules === 0) {
            // Dynamic alias fallback on `from aliased_pkg import child_mod` (e.g. `from core import config_rules`)
            for (const sym of importedSymbols) {
              const dynSub = resolveAbsolutePythonModule(
                sourceFilePosix,
                `${modName}.${sym}`,
                pyFileSet,
                pyBasenameIndex,
                hasDynamicImportlibHook,
                true,
              );
              if (dynSub.targetFile) {
                pushUnique({
                  sourceFile: sourceFilePosix,
                  targetFile: dynSub.targetFile,
                  specifier: `${modName}.${sym}`,
                  line: stmt.startLine,
                  snippet: getSnippet(stmt.startLine),
                  kind: dynSub.kind,
                  confidence: dynSub.confidence,
                  ...(dynSub.note ? { note: dynSub.note } : {}),
                });
              }
            }
          }
        }
      }
      continue;
    }

    // 2. `import a.b, c as d`
    const importMatch = /^import\s+(.+)$/.exec(text);
    if (importMatch) {
      const targets = importMatch[1]!
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
        .filter((s) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s));

      for (const modName of targets) {
        const res = resolveAbsolutePythonModule(
          sourceFilePosix,
          modName,
          pyFileSet,
          pyBasenameIndex,
          hasDynamicImportlibHook,
        );
        if (res.targetFile) {
          pushUnique({
            sourceFile: sourceFilePosix,
            targetFile: res.targetFile,
            specifier: modName,
            line: stmt.startLine,
            snippet: getSnippet(stmt.startLine),
            kind: res.kind,
            confidence: res.confidence,
            ...(res.note ? { note: res.note } : {}),
          });
        }
      }
      continue;
    }

    // 3. Dynamic import calls (`importlib.import_module(...)`, `spec_from_file_location(...)`, `__import__(...)`)
    const dynMatch = /\b(importlib\.import_module|importlib\.util\.spec_from_file_location|spec_from_file_location|__import__)\s*\(/.exec(
      text,
    );
    if (dynMatch) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: dynMatch[1]!,
        line: stmt.startLine,
        snippet: getSnippet(stmt.startLine),
        kind: 'dynamic_import',
        confidence: 'low',
        note: `Dynamic Python loader "${dynMatch[1]}" detected — runtime module binding requires manual verification.`,
      });
    }
  }

  return results;
}
