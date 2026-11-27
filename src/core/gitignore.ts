import fs from 'node:fs';
import path from 'node:path';

/** Directories always excluded from workspace scanning regardless of nesting depth */
export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.agents',
  '.agent',
  '_agents',
  '_agent',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  '.tox',
  '.next',
  '.nuxt',
  '.turbo',
  '.tmp-cleanroom',
  '.idea',
  '.vscode',
]);

/** Build artifact dirs skipped by default unless located inside application source folders (`src/`, `lib/`, `app/`) */
const DEFAULT_BUILD_OUTPUT_DIRS = new Set(['dist', 'build', 'coverage', '.gradle', 'cmake-build-debug', 'cmake-build-release']);

/** Names that are only ignored when confirmed to be a real Python virtualenv (not `src/env/config.ts`!) */
const CONDITIONAL_VENV_DIR_NAMES = new Set(['venv', 'env']);

/** Rust/Maven `target/` and .NET `obj/`/`bin/` only skipped when confirmed build artifact folders */
const CONDITIONAL_BUILD_DIR_NAMES = new Set(['target', 'obj', 'bin']);

const SOURCE_CONTAINER_SEGMENTS = new Set(['src', 'lib', 'app', 'source', 'core']);

interface GitignoreRule {
  /** Base POSIX directory prefix where this rule was defined (`""` for workspace root) */
  basePrefix: string;
  negated: boolean;
  dirOnly: boolean;
  regex: RegExp;
  /** Matches strictly nested children under a directory-only rule (never a sibling regular file with the same name) */
  nestedUnderDirRegex?: RegExp;
}

function escapeRegexChar(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

const MAX_GITIGNORE_LINE_LEN = 512;
const MAX_GITIGNORE_RULES = 2_000;

function globToRegexSource(rawPattern: string): string {
  // Collapse redundant `**/**/` and `***` sequences to neutralize catastrophic ReDoS backtracking on untrusted repos!
  const pattern = rawPattern.replace(/(?:\*\*\/)+/g, '**/').replace(/\*{3,}/g, '**');
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\' && i + 1 < pattern.length) {
      out += escapeRegexChar(pattern[i + 1]!);
      i++;
      continue;
    }
    if (ch === '[') {
      const closeIdx = pattern.indexOf(']', i + 1);
      if (closeIdx > i + 1) {
        let inner = pattern.slice(i + 1, closeIdx);
        if (inner.startsWith('!')) {
          inner = `^${inner.slice(1)}`;
        }
        out += `[${inner}]`;
        i = closeIdx;
        continue;
      }
    }
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return out;
}

function compileGitignoreLine(rawLine: string, basePrefix = ''): GitignoreRule | null {
  const trimmed = rawLine.replace(/^\uFEFF/, '').trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.length > MAX_GITIGNORE_LINE_LEN) return null;

  let line = trimmed;
  let negated = false;
  if (line.startsWith('!')) {
    negated = true;
    line = line.slice(1);
  }
  if (!line) return null;

  const dirOnly = line.endsWith('/');
  if (dirOnly) {
    line = line.slice(0, -1);
  }

  const anchored = line.startsWith('/') || line.includes('/');
  if (line.startsWith('/')) {
    line = line.slice(1);
  }
  if (!line) return null;

  const body = globToRegexSource(line);
  // Reject pathological patterns with too many nested `.*` wildcards (ReDoS protection)
  if ((body.match(/\.\*/g) ?? []).length > 6) return null;

  const fullPattern = anchored
    ? `^${body}(?:/.*)?$`
    : `(?:^|/)${body}(?:/.*)?$`;
  const nestedPattern = anchored ? `^${body}/` : `(?:^|/)${body}/`;

  try {
    return {
      basePrefix,
      negated,
      dirOnly,
      regex: new RegExp(fullPattern),
      ...(dirOnly ? { nestedUnderDirRegex: new RegExp(nestedPattern) } : {}),
    };
  } catch {
    // Skip malformed regex character classes like `[z-a]` without aborting remaining rules!
    return null;
  }
}

function isPythonVirtualEnvDir(dirAbs: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dirAbs, 'pyvenv.cfg')) ||
      fs.existsSync(path.join(dirAbs, 'bin', 'activate')) ||
      fs.existsSync(path.join(dirAbs, 'Scripts', 'activate'))
    );
  } catch {
    return false;
  }
}

function isConfirmedCompiledArtifactDir(dirAbs: string, dirName: string): boolean {
  try {
    if (dirName === 'target') {
      return (
        fs.existsSync(path.join(dirAbs, 'CACHEDIR.TAG')) ||
        fs.existsSync(path.join(dirAbs, 'debug')) ||
        fs.existsSync(path.join(dirAbs, 'release')) ||
        fs.existsSync(path.join(dirAbs, 'classes'))
      );
    }
    if (dirName === 'obj') {
      return (
        fs.existsSync(path.join(dirAbs, 'Debug')) ||
        fs.existsSync(path.join(dirAbs, 'Release')) ||
        fs.existsSync(path.join(dirAbs, 'project.assets.json'))
      );
    }
    if (dirName === 'bin') {
      // Only treat `bin/` as an MSBuild .NET output dir when BOTH `Debug`/`Release` AND a sibling `obj/` dir exist
      // (guarantees Node/Go/Unix `bin/` CLI script folders are NEVER falsely ignored!)
      const hasDotnetConfig =
        fs.existsSync(path.join(dirAbs, 'Debug')) || fs.existsSync(path.join(dirAbs, 'Release'));
      const siblingObj = path.join(path.dirname(dirAbs), 'obj');
      return hasDotnetConfig && fs.existsSync(siblingObj);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Lightweight zero-dependency `.gitignore` matcher for workspace tree & dependency scanning.
 * Supports root `.gitignore`, `.git/info/exclude`, nested subdirectory `.gitignore` files,
 * UTF-8 BOM files, POSIX character classes (`*.py[cod]`), and safe virtualenv detection.
 */
export class GitignoreMatcher {
  private readonly workspaceRoot: string;
  private readonly rules: GitignoreRule[] = [];
  private readonly loadedIgnoreDirs = new Set<string>();
  private readonly venvDirCache = new Map<string, boolean>();
  private readonly buildDirCache = new Map<string, boolean>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.loadIgnoreFile(path.join(workspaceRoot, '.git', 'info', 'exclude'), '');
    this.loadIgnoreFile(path.join(workspaceRoot, '.gitignore'), '');
    this.loadedIgnoreDirs.add('');
  }

  private loadIgnoreFile(filePath: string, basePrefix: string): void {
    if (!fs.existsSync(filePath)) return;
    try {
      const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      for (const line of content.split(/\r?\n/)) {
        if (this.rules.length >= MAX_GITIGNORE_RULES) break;
        const rule = compileGitignoreLine(line, basePrefix);
        if (rule) this.rules.push(rule);
      }
    } catch {
      // Ignore unreadable .gitignore
    }
  }

  /**
   * Loads a nested `<dirRelPosix>/.gitignore` file on demand while walking subdirectories.
   */
  public loadNestedGitignore(dirRelPosix: string): void {
    const clean = dirRelPosix.replace(/^\/+|\/+$/g, '');
    if (!clean || this.loadedIgnoreDirs.has(clean)) return;
    this.loadedIgnoreDirs.add(clean);
    this.loadIgnoreFile(path.join(this.workspaceRoot, clean, '.gitignore'), clean);
  }

  private isConfirmedVenvDir(dirRelPosix: string): boolean {
    const cached = this.venvDirCache.get(dirRelPosix);
    if (cached !== undefined) return cached;
    const result = isPythonVirtualEnvDir(path.join(this.workspaceRoot, dirRelPosix));
    this.venvDirCache.set(dirRelPosix, result);
    return result;
  }

  private isConfirmedBuildArtifactDir(dirRelPosix: string, seg: string): boolean {
    const cached = this.buildDirCache.get(dirRelPosix);
    if (cached !== undefined) return cached;
    const result = isConfirmedCompiledArtifactDir(path.join(this.workspaceRoot, dirRelPosix), seg);
    this.buildDirCache.set(dirRelPosix, result);
    return result;
  }

  public isIgnored(relPosixPath: string, isDirectory: boolean): boolean {
    const clean = relPosixPath.replace(/^\/+|\/+$/g, '');
    if (!clean) return false;
    const segments = clean.split('/');
    // Only directory segments (all segments if `isDirectory`, or ancestor segments if regular file)
    const dirSegmentCount = isDirectory ? segments.length : segments.length - 1;

    for (let i = 0; i < dirSegmentCount; i++) {
      const seg = segments[i]!;
      if (DEFAULT_IGNORED_DIRS.has(seg)) return true;
      if (DEFAULT_BUILD_OUTPUT_DIRS.has(seg)) {
        const insideSourceContainer = segments.slice(0, i).some((anc) => SOURCE_CONTAINER_SEGMENTS.has(anc.toLowerCase()));
        if (!insideSourceContainer) return true;
      }
      if (CONDITIONAL_VENV_DIR_NAMES.has(seg)) {
        const dirRel = segments.slice(0, i + 1).join('/');
        if (this.isConfirmedVenvDir(dirRel)) return true;
      }
      if (CONDITIONAL_BUILD_DIR_NAMES.has(seg)) {
        const insideSourceContainer = segments.slice(0, i).some((anc) => SOURCE_CONTAINER_SEGMENTS.has(anc.toLowerCase()));
        if (!insideSourceContainer) {
          const dirRel = segments.slice(0, i + 1).join('/');
          if (this.isConfirmedBuildArtifactDir(dirRel, seg)) return true;
        }
      }
    }

    let ignored = false;
    for (const rule of this.rules) {
      let target = clean;
      if (rule.basePrefix) {
        const prefixWithSlash = `${rule.basePrefix}/`;
        if (!clean.startsWith(prefixWithSlash)) continue;
        target = clean.slice(prefixWithSlash.length);
      }
      if (rule.dirOnly && !isDirectory) {
        // A directory-only rule (`build/`) ignores files *inside* `build/...`, never a regular file literally named `src/build`
        if (rule.nestedUnderDirRegex?.test(target)) {
          ignored = !rule.negated;
        }
        continue;
      }
      if (rule.regex.test(target)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  }
}
