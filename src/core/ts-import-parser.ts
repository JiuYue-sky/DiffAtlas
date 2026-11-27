import fs from 'node:fs';
import path from 'node:path';
import { sanitizeUntrustedIdentifier, toPosixPath } from '../kit/path-guard.js';

export type ImportEdgeKind =
  | 'static_import'
  | 'reexport'
  | 'commonjs_require'
  | 'tsconfig_alias'
  | 'package_import'
  | 'include_header'
  | 'namespace_import'
  | 'dynamic_import_literal'
  | 'dynamic_import'
  | 'dynamic_alias_candidate'
  | 'unresolved_import';

export type ImportConfidence = 'high' | 'low';

export interface ParsedImportRecord {
  /** Workspace-relative POSIX path of the importing file */
  sourceFile: string;
  /** Workspace-relative POSIX path of the resolved target file, or `null` if dynamic/unresolved */
  targetFile: string | null;
  /** Original raw specifier (sanitized) */
  specifier: string;
  /** 1-based line number in `sourceFile` */
  line: number;
  /** Trimmed single-line source evidence snippet */
  snippet: string;
  kind: ImportEdgeKind;
  confidence: ImportConfidence;
  /** Optional explanation for low-confidence edges */
  note?: string;
}

export interface TsConfigPathConfig {
  baseUrlRel: string | null;
  paths: Array<{ prefix: string; suffix: string; hasWildcard: boolean; targets: string[] }>;
}

const TS_JS_RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.json',
];

const JS_TO_TS_EXTENSION_MAP: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.js', '.jsx'],
  '.jsx': ['.tsx', '.ts', '.jsx', '.js'],
  '.mjs': ['.mts', '.ts', '.mjs', '.js'],
  '.cjs': ['.cts', '.ts', '.cjs', '.js'],
};

/**
 * Strips JSONC comments (`//`, `/* ... *\/`) and trailing commas safely without breaking strings.
 */
export function parseJsoncLoose(raw: string): Record<string, unknown> | null {
  const input = raw.replace(/^\uFEFF/, '');
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < input.length && input[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }

  // Remove trailing commas before `}` or `]`
  const cleaned = out.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Loads `tsconfig.json` / `jsconfig.json` `compilerOptions.baseUrl` and `compilerOptions.paths`,
 * following `"extends"` chains (both single string and TS 5.0+ string arrays) and child `"references"` up to depth 5.
 */
export function loadTsConfigPaths(workspaceRoot: string, configRelDir = ''): TsConfigPathConfig {
  const empty: TsConfigPathConfig = { baseUrlRel: null, paths: [] };
  const visited = new Set<string>();

  const readConfigChain = (cfgAbsPath: string, depth: number): TsConfigPathConfig | null => {
    const norm = path.resolve(cfgAbsPath);
    if (depth > 5 || visited.has(norm) || !fs.existsSync(norm)) return null;
    visited.add(norm);

    let parsed: Record<string, unknown> | null;
    try {
      parsed = parseJsoncLoose(fs.readFileSync(norm, 'utf8'));
    } catch {
      return null;
    }
    if (!parsed) return null;

    const cfgDir = path.dirname(norm);
    const cfgDirRel = toPosixPath(path.relative(workspaceRoot, cfgDir));

    // 1. Inherit from `"extends"` if present (supports both single string and TS 5.0+ array of strings)
    let inherited: TsConfigPathConfig = { baseUrlRel: null, paths: [] };
    const rawExtends = Array.isArray(parsed.extends)
      ? parsed.extends.filter((x): x is string => typeof x === 'string')
      : typeof parsed.extends === 'string'
        ? [parsed.extends]
        : [];
    for (const extItem of rawExtends) {
      const extRaw = extItem.trim();
      if (extRaw.startsWith('.')) {
        let extCandidate = path.resolve(cfgDir, extRaw);
        if (fs.existsSync(extCandidate) && fs.statSync(extCandidate).isDirectory()) {
          extCandidate = path.join(extCandidate, 'tsconfig.json');
        } else if (!extCandidate.endsWith('.json') && fs.existsSync(`${extCandidate}.json`)) {
          extCandidate = `${extCandidate}.json`;
        }
        const parentCfg = readConfigChain(extCandidate, depth + 1);
        if (parentCfg) {
          if (parentCfg.baseUrlRel !== null) inherited.baseUrlRel = parentCfg.baseUrlRel;
          if (parentCfg.paths.length > 0) inherited.paths = [...parentCfg.paths, ...inherited.paths];
        }
      }
    }

    const co = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
    let baseUrlRel = inherited.baseUrlRel;
    if (typeof co.baseUrl === 'string') {
      const resolvedBaseAbs = path.resolve(cfgDir, co.baseUrl);
      baseUrlRel = toPosixPath(path.relative(workspaceRoot, resolvedBaseAbs)).replace(/^\.\//, '').replace(/\/$/, '');
    }

    const rawPaths = co.paths;
    const entries: TsConfigPathConfig['paths'] = [];
    if (rawPaths && typeof rawPaths === 'object' && !Array.isArray(rawPaths)) {
      // TypeScript 4.1+: when `paths` is defined without `baseUrl`, targets resolve relative to the defining tsconfig's directory
      const effectiveBaseRel = baseUrlRel !== null ? baseUrlRel : cfgDirRel;
      for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const starIdx = pattern.indexOf('*');
        const prefix = starIdx === -1 ? pattern : pattern.slice(0, starIdx);
        const suffix = starIdx === -1 ? '' : pattern.slice(starIdx + 1);
        const cleanTargets = targets
          .filter((t): t is string => typeof t === 'string')
          .map((t) => {
            const cleaned = toPosixPath(t).replace(/^\.\//, '');
            return effectiveBaseRel ? path.posix.normalize(`${effectiveBaseRel}/${cleaned}`) : cleaned;
          });
        if (cleanTargets.length > 0) {
          entries.push({ prefix, suffix, hasWildcard: starIdx !== -1, targets: cleanTargets });
        }
      }
    }

    const mergedPaths = entries.length > 0 ? [...entries] : [...inherited.paths];

    // 2. If root config has project `"references"` (e.g. `tsconfig.node.json` + `tsconfig.app.json`),
    // aggregate paths across ALL referenced configs rather than stopping on the first reference!
    let mergedBaseUrlRel = baseUrlRel;
    if (Array.isArray(parsed.references)) {
      const seenPatternKeys = new Set(mergedPaths.map((p) => `${p.prefix}|${p.hasWildcard ? '*' : ''}|${p.suffix}`));
      for (const ref of parsed.references as Array<{ path?: unknown }>) {
        if (typeof ref?.path !== 'string') continue;
        let refAbs = path.resolve(cfgDir, ref.path);
        if (fs.existsSync(refAbs) && fs.statSync(refAbs).isDirectory()) {
          refAbs = path.join(refAbs, 'tsconfig.json');
        } else if (!refAbs.endsWith('.json') && fs.existsSync(`${refAbs}.json`)) {
          refAbs = `${refAbs}.json`;
        }
        const refCfg = readConfigChain(refAbs, depth + 1);
        if (refCfg) {
          if (mergedBaseUrlRel === null && refCfg.baseUrlRel !== null) {
            mergedBaseUrlRel = refCfg.baseUrlRel;
          }
          for (const p of refCfg.paths) {
            const key = `${p.prefix}|${p.hasWildcard ? '*' : ''}|${p.suffix}`;
            if (!seenPatternKeys.has(key)) {
              seenPatternKeys.add(key);
              mergedPaths.push(p);
            }
          }
        }
      }
    }

    // Match exact aliases before wildcards, and longer prefixes first (TypeScript specificity rules)
    mergedPaths.sort((a, b) => {
      if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
      return b.prefix.length - a.prefix.length;
    });

    return { baseUrlRel: mergedBaseUrlRel, paths: mergedPaths };
  };

  const targetBaseDir = configRelDir ? path.join(workspaceRoot, configRelDir) : workspaceRoot;
  for (const fileName of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(targetBaseDir, fileName);
    if (!fs.existsSync(cfgPath)) continue;
    const loaded = readConfigChain(cfgPath, 0);
    if (loaded) return loaded;
  }
  return empty;
}

interface MaskedSource {
  /** Source with comments and non-import string interiors blanked while preserving exact line breaks */
  code: string;
  /** Original lines (0-indexed) for snippet extraction */
  lines: string[];
}

/**
 * Replaces comments and string/template bodies with spaces (preserving `\n` and quotes),
 * keeping string literal offsets extractable from original source so comments/strings NEVER
 * produce false-positive imports.
 */
function maskCommentsAndTemplates(source: string): MaskedSource {
  const lines = source.split(/\r?\n/);
  const chars = new Array<string>(source.length);
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Single-line comment
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

    // Multi-line block comment
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

    // Regex literal guard (prevents quotes inside `/don't/` from desyncing string masking)
    if (ch === '/' && next !== '/' && next !== '*') {
      // Look backward for last non-whitespace char to distinguish regex vs division
      let prevIdx = i - 1;
      while (prevIdx >= 0 && (source[prevIdx] === ' ' || source[prevIdx] === '\t')) prevIdx--;
      const prevChar = prevIdx >= 0 ? source[prevIdx]! : '\n';
      const likelyRegex =
        prevIdx < 0 ||
        '(=,:;[!&|?{}\n'.includes(prevChar) ||
        /\b(?:return|case|throw|in|of|typeof|void|delete)$/.test(source.slice(Math.max(0, prevIdx - 8), prevIdx + 1));

      if (likelyRegex) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < source.length && source[j] !== '\n') {
          const rc = source[j]!;
          if (rc === '\\') {
            j += 2;
            continue;
          }
          if (rc === '[') inClass = true;
          else if (rc === ']') inClass = false;
          else if (rc === '/' && !inClass) {
            closed = true;
            j++;
            break;
          }
          j++;
        }
        if (closed) {
          for (let k = i; k < j; k++) chars[k] = ' ';
          i = j;
          continue;
        }
      }
    }

    // Single or double quoted string: blank interior while preserving quotes so statements inside strings never match!
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let hasNewline = false;
      let closed = false;
      while (i < source.length) {
        const sc = source[i]!;
        if (sc === '\\') {
          if (i + 1 < source.length && source[i + 1] === '\n') hasNewline = true;
          i = Math.min(i + 2, source.length);
          continue;
        }
        if (sc === '\n') hasNewline = true;
        if (sc === quote) {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      const spanLen = i - start;
      chars[start] = quote;
      const innerEnd = closed ? i - 1 : i;
      for (let k = start + 1; k < innerEnd; k++) {
        chars[k] = source[k] === '\n' ? '\n' : hasNewline || spanLen > 240 ? ' ' : '_';
      }
      if (closed && i - 1 > start) chars[i - 1] = quote;
      continue;
    }

    // Template literal with stack-tracked `${ ... }` interpolation expressions!
    // Prevents backticks inside `'...'` strings or nested templates inside `${...}` from desyncing the file!
    if (ch === '`') {
      const scanTemplate = (startIdx: number): number => {
        chars[startIdx] = '`';
        let p = startIdx + 1;
        while (p < source.length) {
          const tc = source[p]!;
          if (tc === '\\') {
            chars[p] = ' ';
            if (p + 1 < source.length) chars[p + 1] = source[p + 1] === '\n' ? '\n' : ' ';
            p = Math.min(p + 2, source.length);
            continue;
          }
          if (tc === '$' && source[p + 1] === '{') {
            chars[p] = ' ';
            chars[p + 1] = '{';
            p = scanTemplateExpr(p + 2);
            continue;
          }
          if (tc === '`') {
            chars[p] = '`';
            return p + 1;
          }
          chars[p] = tc === '\n' ? '\n' : ' ';
          p++;
        }
        return p;
      };

      const scanTemplateExpr = (exprStart: number): number => {
        let p = exprStart;
        let braceDepth = 1;
        while (p < source.length && braceDepth > 0) {
          const ec = source[p]!;
          const enext = source[p + 1];
          if (ec === '/' && enext === '/') {
            while (p < source.length && source[p] !== '\n') {
              chars[p] = ' ';
              p++;
            }
            continue;
          }
          if (ec === '/' && enext === '*') {
            chars[p] = ' ';
            chars[p + 1] = ' ';
            p += 2;
            while (p < source.length) {
              if (source[p] === '*' && source[p + 1] === '/') {
                chars[p] = ' ';
                chars[p + 1] = ' ';
                p += 2;
                break;
              }
              chars[p] = source[p] === '\n' ? '\n' : ' ';
              p++;
            }
            continue;
          }
          if (ec === "'" || ec === '"') {
            const q = ec;
            const qStart = p;
            p++;
            let qClosed = false;
            while (p < source.length) {
              if (source[p] === '\\') {
                p = Math.min(p + 2, source.length);
                continue;
              }
              if (source[p] === q) {
                qClosed = true;
                p++;
                break;
              }
              p++;
            }
            chars[qStart] = q;
            const qInnerEnd = qClosed ? p - 1 : p;
            for (let k = qStart + 1; k < qInnerEnd; k++) {
              chars[k] = source[k] === '\n' ? '\n' : '_';
            }
            if (qClosed && p - 1 > qStart) chars[p - 1] = q;
            continue;
          }
          if (ec === '`') {
            p = scanTemplate(p);
            continue;
          }
          if (ec === '{') {
            braceDepth++;
            chars[p] = '{';
            p++;
            continue;
          }
          if (ec === '}') {
            braceDepth--;
            chars[p] = '}';
            p++;
            continue;
          }
          chars[p] = ec;
          p++;
        }
        return p;
      };

      i = scanTemplate(i);
      continue;
    }

    chars[i] = ch;
    i++;
  }

  return { code: chars.join(''), lines };
}

function offsetToLineNumber(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function resolveCandidateExact(clean: string, fileSet: ReadonlySet<string>): string | null {
  if (fileSet.has(clean)) return clean;

  const ext = path.posix.extname(clean).toLowerCase();
  const mappedExts = JS_TO_TS_EXTENSION_MAP[ext];
  if (mappedExts) {
    const stem = clean.slice(0, -ext.length);
    for (const altExt of mappedExts) {
      const alt = `${stem}${altExt}`;
      if (fileSet.has(alt)) return alt;
    }
  }

  for (const tryExt of TS_JS_RESOLVE_EXTENSIONS) {
    const withExt = `${clean}${tryExt}`;
    if (fileSet.has(withExt)) return withExt;
  }

  for (const tryExt of TS_JS_RESOLVE_EXTENSIONS) {
    const idxFile = `${clean}/index${tryExt}`;
    if (fileSet.has(idxFile)) return idxFile;
  }

  return null;
}

function resolveCandidateInIndex(
  relCandidatePosix: string,
  fileSet: ReadonlySet<string>,
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): string | null {
  const clean = toPosixPath(relCandidatePosix).replace(/^\.\//, '');
  // Fast path: check all exact-case candidates first (zero string lowercasing overhead!)
  const exact = resolveCandidateExact(clean, fileSet);
  if (exact || !caseInsensitiveMap) return exact;

  // Fallback on case-insensitive OSes (Windows / macOS) only when exact casing missed
  const lowerClean = clean.toLowerCase();
  const ciDirect = caseInsensitiveMap.get(lowerClean);
  if (ciDirect) return ciDirect;

  const ext = path.posix.extname(lowerClean);
  const mappedExts = JS_TO_TS_EXTENSION_MAP[ext];
  if (mappedExts) {
    const stem = lowerClean.slice(0, -ext.length);
    for (const altExt of mappedExts) {
      const ciAlt = caseInsensitiveMap.get(`${stem}${altExt}`);
      if (ciAlt) return ciAlt;
    }
  }

  for (const tryExt of TS_JS_RESOLVE_EXTENSIONS) {
    const ciWithExt = caseInsensitiveMap.get(`${lowerClean}${tryExt}`);
    if (ciWithExt) return ciWithExt;
  }

  for (const tryExt of TS_JS_RESOLVE_EXTENSIONS) {
    const ciIdx = caseInsensitiveMap.get(`${lowerClean}/index${tryExt}`);
    if (ciIdx) return ciIdx;
  }

  return null;
}

function stripBundlerQueryAndHash(specifier: string): string {
  const qIdx = specifier.indexOf('?');
  const hIdx = specifier.indexOf('#');
  let cut = specifier.length;
  if (qIdx !== -1) cut = Math.min(cut, qIdx);
  if (hIdx !== -1) cut = Math.min(cut, hIdx);
  return specifier.slice(0, cut);
}

function resolveTsJsSpecifier(
  sourceFilePosix: string,
  rawSpecifier: string,
  fileSet: ReadonlySet<string>,
  tsConfig: TsConfigPathConfig,
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): { targetFile: string | null; isLocal: boolean; viaAlias: boolean } {
  const specifier = stripBundlerQueryAndHash(rawSpecifier);
  if (!specifier) {
    return { targetFile: null, isLocal: false, viaAlias: false };
  }

  // 1. Relative import (`./` or `../`)
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    const dir = path.posix.dirname(sourceFilePosix);
    const joined = path.posix.normalize(dir === '.' ? specifier : `${dir}/${specifier}`);
    if (joined === '..' || joined.startsWith('../')) {
      return { targetFile: null, isLocal: true, viaAlias: false };
    }
    return {
      targetFile: resolveCandidateInIndex(joined, fileSet, caseInsensitiveMap),
      isLocal: true,
      viaAlias: false,
    };
  }

  // 2. `tsconfig.json` `paths` alias (targets are already normalized relative to workspace root by `loadTsConfigPaths`)
  let matchedAnyAliasRule = false;
  for (const rule of tsConfig.paths) {
    const matches = rule.hasWildcard
      ? specifier.length >= rule.prefix.length + rule.suffix.length &&
        specifier.startsWith(rule.prefix) &&
        specifier.endsWith(rule.suffix)
      : specifier === rule.prefix;
    if (matches) {
      matchedAnyAliasRule = true;
      const wildcardMatch = rule.hasWildcard
        ? specifier.slice(
            rule.prefix.length,
            rule.suffix.length > 0 ? specifier.length - rule.suffix.length : specifier.length,
          )
        : '';
      for (const targetPattern of rule.targets) {
        const replaced = path.posix.normalize(
          rule.hasWildcard ? targetPattern.replace('*', wildcardMatch) : targetPattern,
        );
        const resolved = resolveCandidateInIndex(replaced, fileSet, caseInsensitiveMap);
        if (resolved) {
          return { targetFile: resolved, isLocal: true, viaAlias: true };
        }
      }
    }
  }
  if (matchedAnyAliasRule) {
    return { targetFile: null, isLocal: true, viaAlias: true };
  }

  // 3. `tsconfig.json` `baseUrl` non-relative local module (e.g. `src/kit/types`)
  if (tsConfig.baseUrlRel !== null) {
    const candidate = tsConfig.baseUrlRel
      ? path.posix.normalize(`${tsConfig.baseUrlRel}/${specifier}`)
      : path.posix.normalize(specifier);
    const resolved = resolveCandidateInIndex(candidate, fileSet, caseInsensitiveMap);
    if (resolved) {
      return { targetFile: resolved, isLocal: true, viaAlias: true };
    }
  }

  // External package (`react`, `zod`, `node:fs`, `@modelcontextprotocol/server`, etc.)
  return { targetFile: null, isLocal: false, viaAlias: false };
}

/**
 * Deterministic TS/JS import & re-export parser with zero false positives from comments/strings/templates.
 */
export function parseTsJsImports(
  sourceFilePosix: string,
  rawSourceText: string,
  fileSet: ReadonlySet<string>,
  tsConfig: TsConfigPathConfig,
  caseInsensitiveMap?: ReadonlyMap<string, string>,
): ParsedImportRecord[] {
  const sourceText = rawSourceText.replace(/^\uFEFF/, '');
  const { code, lines } = maskCommentsAndTemplates(sourceText);
  const results: ParsedImportRecord[] = [];
  const seenKeys = new Set<string>();

  const pushUnique = (rec: ParsedImportRecord) => {
    const key = `${rec.line}:${rec.kind}:${rec.specifier}:${rec.targetFile ?? ''}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    results.push(rec);
  };

  const getSnippet = (lineNum: number, specifier?: string): string => {
    const rawLine = (lines[lineNum - 1] ?? '').trim();
    if (specifier && rawLine.endsWith('{') && !rawLine.includes('from')) {
      return sanitizeUntrustedIdentifier(`${rawLine} … } from '${specifier}'`, 140);
    }
    return sanitizeUntrustedIdentifier(rawLine, 140);
  };

  const extractRealLiteral = (matchStart: number, quoteStartRel: number, quoteEndRel: number): string => {
    return sourceText.slice(matchStart + quoteStartRel + 1, matchStart + quoteEndRel - 1);
  };

  // 1. Static `import ... from '...'` and `export ... from '...'`
  // Strictly constrained binding syntax so semicolon-free (ASI) `export function foo() { ... }` can NEVER bridge to a later `from`.
  const boundedFromRe =
    /(?:^|[;\n}])\s*(import|export)\s+(?:type\s+)?(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^;{}()=]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\*\s+as\s+[A-Za-z_$][\w$]*|\{[^;{}()=]*\}))?)\s*from\s*(['"])([^'"\n]+)\2/g;
  for (const m of code.matchAll(boundedFromRe)) {
    const keyword = m[1]!;
    const fullMatch = m[0];
    const idx = m.index ?? 0;
    const kwOffset = idx + fullMatch.indexOf(keyword);
    const quoteChar = m[2]!;
    const quoteEndRel = fullMatch.length;
    const quoteStartRel = fullMatch.lastIndexOf(quoteChar, quoteEndRel - 2);
    const specifier = extractRealLiteral(idx, quoteStartRel, quoteEndRel);
    const line = offsetToLineNumber(sourceText, kwOffset);
    const resolved = resolveTsJsSpecifier(sourceFilePosix, specifier, fileSet, tsConfig, caseInsensitiveMap);

    if (!resolved.isLocal) continue;
    if (resolved.targetFile) {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: resolved.targetFile,
        specifier: sanitizeUntrustedIdentifier(specifier, 160),
        line,
        snippet: getSnippet(line, specifier),
        kind: keyword === 'export' ? 'reexport' : resolved.viaAlias ? 'tsconfig_alias' : 'static_import',
        confidence: 'high',
      });
    } else {
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: sanitizeUntrustedIdentifier(specifier, 160),
        line,
        snippet: getSnippet(line, specifier),
        kind: 'unresolved_import',
        confidence: 'low',
        note: 'Local/aliased specifier could not be resolved to an indexed workspace file.',
      });
    }
  }

  // 2. Side-effect imports: `import './styles.css'`
  const sideEffectRe = /(?:^|[;\n}])\s*import\s+(['"])([^'"\n]+)\1/g;
  for (const m of code.matchAll(sideEffectRe)) {
    const fullMatch = m[0];
    const idx = m.index ?? 0;
    const quoteChar = m[1]!;
    const quoteEndRel = fullMatch.length;
    const quoteStartRel = fullMatch.lastIndexOf(quoteChar, quoteEndRel - 2);
    const specifier = extractRealLiteral(idx, quoteStartRel, quoteEndRel);
    const importKwOffset = idx + fullMatch.indexOf('import');
    const line = offsetToLineNumber(sourceText, importKwOffset);
    const resolved = resolveTsJsSpecifier(sourceFilePosix, specifier, fileSet, tsConfig, caseInsensitiveMap);
    if (!resolved.isLocal) continue;
    pushUnique({
      sourceFile: sourceFilePosix,
      targetFile: resolved.targetFile,
      specifier: sanitizeUntrustedIdentifier(specifier, 160),
      line,
      snippet: getSnippet(line),
      kind: resolved.targetFile ? 'static_import' : 'unresolved_import',
      confidence: resolved.targetFile ? 'high' : 'low',
      ...(resolved.targetFile ? {} : { note: 'Unresolved side-effect import.' }),
    });
  }

  // 3. CommonJS `require(...)` — single/multi-line static string literal vs dynamic expression
  const requireRe = /(?<![.\w$])require\s*\(\s*((?:[^()]|\([^()]*\)){1,240}?)\s*\)/g;
  for (const m of code.matchAll(requireRe)) {
    const idx = m.index ?? 0;
    const afterParen = code.slice(idx + m[0].length);
    // Skip class/interface method declarations named `require(...) { ... }` or `require(...): T`
    if (/^\s*[:{]/.test(afterParen)) continue;
    const line = offsetToLineNumber(sourceText, idx);
    const rawArgMasked = m[1]!.trim();
    const isQuoted =
      (rawArgMasked.startsWith("'") && rawArgMasked.endsWith("'")) ||
      (rawArgMasked.startsWith('"') && rawArgMasked.endsWith('"'));

    if (isQuoted) {
      const argStartInFull = m[0].indexOf(rawArgMasked);
      const specifier = sourceText.slice(
        idx + argStartInFull + 1,
        idx + argStartInFull + rawArgMasked.length - 1,
      );
      const resolved = resolveTsJsSpecifier(sourceFilePosix, specifier, fileSet, tsConfig, caseInsensitiveMap);
      if (!resolved.isLocal) continue;
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: resolved.targetFile,
        specifier: sanitizeUntrustedIdentifier(specifier, 160),
        line,
        snippet: getSnippet(line),
        kind: resolved.targetFile ? 'commonjs_require' : 'unresolved_import',
        confidence: resolved.targetFile ? 'high' : 'low',
        ...(resolved.targetFile ? {} : { note: 'Unresolved require() local path.' }),
      });
    } else {
      const realArgStart = idx + m[0].indexOf('(') + 1;
      const realArgEnd = idx + m[0].lastIndexOf(')');
      const expr = sourceText.slice(realArgStart, realArgEnd).trim();
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: sanitizeUntrustedIdentifier(expr, 120),
        line,
        snippet: getSnippet(line),
        kind: 'dynamic_import',
        confidence: 'low',
        note: 'Dynamic require() expression cannot be statically resolved — verify manually.',
      });
    }
  }

  // 4. Dynamic `import(...)` — single/multi-line literal specifier vs dynamic expression (always `low` confidence per charter!)
  const dynamicImportRe = /(?<![.\w$])import\s*\(\s*((?:[^()]|\([^()]*\)){1,240}?)\s*\)/g;
  for (const m of code.matchAll(dynamicImportRe)) {
    const idx = m.index ?? 0;
    const afterParen = code.slice(idx + m[0].length);
    // Skip TypeScript class/interface method declarations like `import(file: string): Promise<void>`
    if (/^\s*[:{]/.test(afterParen)) continue;
    const line = offsetToLineNumber(sourceText, idx);
    const rawArgMasked = m[1]!.trim();
    const isSingleOrDoubleQuoted =
      (rawArgMasked.startsWith("'") && rawArgMasked.endsWith("'")) ||
      (rawArgMasked.startsWith('"') && rawArgMasked.endsWith('"'));
    const isBacktickQuoted =
      rawArgMasked.startsWith('`') && rawArgMasked.endsWith('`') && !rawArgMasked.includes('{');

    if (isSingleOrDoubleQuoted || isBacktickQuoted) {
      const argStartInFull = m[0].indexOf(rawArgMasked);
      const specifier = sourceText.slice(
        idx + argStartInFull + 1,
        idx + argStartInFull + rawArgMasked.length - 1,
      );
      const resolved = resolveTsJsSpecifier(sourceFilePosix, specifier, fileSet, tsConfig, caseInsensitiveMap);
      if (!resolved.isLocal) continue;
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: resolved.targetFile,
        specifier: sanitizeUntrustedIdentifier(specifier, 160),
        line,
        snippet: getSnippet(line, specifier),
        kind: 'dynamic_import_literal',
        confidence: 'low',
        note: 'Dynamic import() with string literal — runtime-loaded dependency.',
      });
    } else {
      const realArgStart = idx + m[0].indexOf('(') + 1;
      const realArgEnd = idx + m[0].lastIndexOf(')');
      const expr = sourceText.slice(realArgStart, realArgEnd).trim();
      pushUnique({
        sourceFile: sourceFilePosix,
        targetFile: null,
        specifier: sanitizeUntrustedIdentifier(expr, 120),
        line,
        snippet: getSnippet(line),
        kind: 'dynamic_import',
        confidence: 'low',
        note: 'Dynamic import() expression cannot be statically resolved — verify manually.',
      });
    }
  }

  return results;
}
