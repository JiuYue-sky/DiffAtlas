import fs from 'node:fs';
import path from 'node:path';
import { truncateUtf8Clean } from '../kit/mcp-shell.js';
import { PathGuard, isSensitivePath, redactSecretsAndPaths, toFileUri, toPosixPath } from '../kit/path-guard.js';
import { runCommandSafe } from '../kit/process-guard.js';
import type { WorkspaceFileLanguage } from '../shared/languages.js';
import { GitignoreMatcher } from './gitignore.js';

export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'clean';

export interface WorkspaceFileNode {
  relativePath: string;
  fileUri: string;
  sizeBytes: number;
  mtimeMs: number;
  gitStatus: GitFileStatus;
  language: WorkspaceFileLanguage;
  isTestFile: boolean;
}

export interface WorkspaceSnapshotSummary {
  workspaceRoot: string;
  workspaceName: string;
  isGitRepo: boolean;
  hasInitialCommit: boolean;
  branchName: string | null;
  gitWarning?: string;
  totalFilesScanned: number;
  changedFilesCount: number;
  files: WorkspaceFileNode[];
}

function classifyLanguage(relPath: string): WorkspaceFileLanguage {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) {
    return 'typescript';
  }
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return 'javascript';
  }
  if (lower.endsWith('.vue') || lower.endsWith('.svelte') || lower.endsWith('.astro')) {
    return 'sfc';
  }
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) {
    return 'python';
  }
  if (lower.endsWith('.go')) {
    return 'go';
  }
  if (lower.endsWith('.rs')) {
    return 'rust';
  }
  if (
    lower.endsWith('.c') ||
    lower.endsWith('.h') ||
    lower.endsWith('.cc') ||
    lower.endsWith('.cpp') ||
    lower.endsWith('.cxx') ||
    lower.endsWith('.c++') ||
    lower.endsWith('.hpp') ||
    lower.endsWith('.hh') ||
    lower.endsWith('.hxx') ||
    lower.endsWith('.h++') ||
    lower.endsWith('.ipp') ||
    lower.endsWith('.inl') ||
    lower.endsWith('.tpp') ||
    lower.endsWith('.inc')
  ) {
    return 'cpp';
  }
  if (lower.endsWith('.java')) {
    return 'java';
  }
  if (lower.endsWith('.kt') || lower.endsWith('.kts')) {
    return 'kotlin';
  }
  if (lower.endsWith('.cs')) {
    return 'csharp';
  }
  if (lower.endsWith('.json') || lower.endsWith('.jsonc')) {
    return 'json';
  }
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) {
    return 'markdown';
  }
  return 'other';
}

function detectTestFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    /(^|\/)(tests?|__tests__|spec|src\/test)\//.test(lower) ||
    /(^|\/)[^/]+\.tests?\//.test(lower) ||
    /\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/.test(lower) ||
    /(^|\/)test_[^/]+\.py$/.test(lower) ||
    /_test\.(py|go|rs|c|cc|cpp|cxx)$/.test(lower) ||
    /_unittest\.(c|cc|cpp|cxx)$/.test(lower) ||
    /(tests?|spec)\.(java|kt|cs|cpp|cc|cxx)$/.test(lower) ||
    // Case-sensitive checks prevent false positives on `Audit.java`, `Commit.java`, `Unit.cs`, `Split.cpp`!
    /IT\.(java|kt)$/.test(relPath) ||
    /(^|\/)Test[A-Z][^/]*\.(java|kt)$/.test(relPath)
  );
}

function parsePorcelainV2StatusCode(xy: string): GitFileStatus {
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  if (xy.includes('R')) return 'renamed';
  if (xy !== '..' && xy.trim().length > 0) return 'modified';
  return 'clean';
}

function sliceAfterNthSpace(str: string, spaces: number): string {
  let seen = 0;
  for (let idx = 0; idx < str.length; idx++) {
    if (str.charCodeAt(idx) === 32) {
      seen++;
      if (seen === spaces) return str.slice(idx + 1);
    }
  }
  return '';
}

/**
 * Pure filesystem upward walk (~0.03ms, ZERO child processes) to locate enclosing `.git` root
 * and compute monorepo subdirectory prefix (`gitSubPrefix`).
 */
function findEnclosingGitRootSync(canonicalWorkspaceRoot: string): { gitTopLevel: string; gitSubPrefix: string } | null {
  let cursor = canonicalWorkspaceRoot;
  while (true) {
    if (fs.existsSync(path.join(cursor, '.git'))) {
      let realTop = cursor;
      try {
        realTop = fs.realpathSync.native(cursor);
      } catch {
        realTop = cursor;
      }
      const rel = toPosixPath(path.relative(realTop, canonicalWorkspaceRoot));
      const escaped = rel === '..' || rel.startsWith('../');
      const gitSubPrefix = rel && !escaped ? `${rel.replace(/\/+$/, '')}/` : '';
      return { gitTopLevel: realTop, gitSubPrefix };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function normalizeStatusKey(relPosix: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? relPosix.toLowerCase() : relPosix;
}

/**
 * Scans workspace files safely inside `PathGuard` and overlays `git status` using a SINGLE
 * `git status --porcelain=v2 --branch -z` subprocess (0 subprocesses in non-Git folders!).
 */
export async function inspectWorkspaceFiles(
  workspaceRootInput: string,
  maxFiles = 2_500,
): Promise<WorkspaceSnapshotSummary> {
  const guard = new PathGuard(workspaceRootInput);
  const root = guard.workspaceRoot;

  let isGitRepo = false;
  let hasInitialCommit = false;
  let branchName: string | null = null;
  let gitWarning: string | undefined;
  const gitStatusMap = new Map<string, { relPosix: string; status: GitFileStatus }>();

  const gitCtx = findEnclosingGitRootSync(root);
  if (gitCtx) {
    const statusRes = await runCommandSafe(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.quotepath=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.sshCommand=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '-uall',
      ],
      {
        cwd: root,
        timeoutMs: 3_500,
      },
    );

    if (statusRes.exitCode === 0) {
      isGitRepo = true;
      hasInitialCommit = true;
      const { gitSubPrefix } = gitCtx;
      const caseInsensitiveOs = process.platform === 'win32' || process.platform === 'darwin';
      const normSubPrefix = caseInsensitiveOs ? gitSubPrefix.toLowerCase() : gitSubPrefix;
      const tokens = statusRes.stdout.split('\0');

      for (let i = 0; i < tokens.length; i++) {
        const entry = tokens[i];
        if (!entry) continue;

        if (entry.startsWith('# ')) {
          if (entry.startsWith('# branch.oid ')) {
            const oid = entry.slice('# branch.oid '.length).trim();
            if (oid === '(initial)') {
              hasInitialCommit = false;
            }
          } else if (entry.startsWith('# branch.head ')) {
            const head = entry.slice('# branch.head '.length).trim();
            branchName = head === '(detached)' ? 'HEAD' : head || 'HEAD';
          }
          continue;
        }

        let rawPath = '';
        let fileStatus: GitFileStatus = 'clean';

        if (entry.startsWith('? ')) {
          rawPath = toPosixPath(entry.slice(2));
          fileStatus = 'untracked';
        } else if (entry.startsWith('1 ')) {
          const xy = entry.slice(2, 4);
          rawPath = toPosixPath(sliceAfterNthSpace(entry, 8));
          fileStatus = parsePorcelainV2StatusCode(xy);
        } else if (entry.startsWith('2 ')) {
          const xy = entry.slice(2, 4);
          rawPath = toPosixPath(sliceAfterNthSpace(entry, 9));
          fileStatus = xy.includes('D') ? 'deleted' : 'renamed';
          // Porcelain v2 `2` records are followed by an extra NUL-terminated original path token
          i++;
        } else if (entry.startsWith('u ')) {
          rawPath = toPosixPath(sliceAfterNthSpace(entry, 10));
          fileStatus = 'modified';
        } else {
          continue;
        }

        let relPosix = rawPath;
        if (gitSubPrefix) {
          const cmpRaw = caseInsensitiveOs ? rawPath.toLowerCase() : rawPath;
          if (!cmpRaw.startsWith(normSubPrefix)) continue;
          relPosix = rawPath.slice(gitSubPrefix.length);
        }
        if (relPosix && !isSensitivePath(relPosix)) {
          gitStatusMap.set(normalizeStatusKey(relPosix), { relPosix, status: fileStatus });
        }
      }
    } else {
      const reason = redactSecretsAndPaths((statusRes.stderr || '').trim().split(/\r?\n/)[0] || '');
      if (reason) {
        gitWarning = `Git status unavailable (${reason}); degraded to filesystem-only workspace scan.`;
      } else if (statusRes.timedOut) {
        gitWarning = 'Git status timed out (>3.5s); degraded to filesystem-only workspace scan.';
      }
    }
  }

  const gitignore = new GitignoreMatcher(root);
  const collected: WorkspaceFileNode[] = [];
  const collectedKeySet = new Set<string>();
  const walk = (dirAbs: string) => {
    if (collected.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (collected.length >= maxFiles) break;
      if (dirent.isSymbolicLink()) continue;
      const fullAbs = path.join(dirAbs, dirent.name);
      const relPosix = toPosixPath(path.relative(root, fullAbs));
      if (dirent.isDirectory()) {
        if (gitignore.isIgnored(relPosix, true)) continue;
        gitignore.loadNestedGitignore(relPosix);
        walk(fullAbs);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (gitignore.isIgnored(relPosix, false)) continue;
      if (isSensitivePath(relPosix)) continue;
      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(fullAbs);
        sizeBytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      const normKey = normalizeStatusKey(relPosix);
      collectedKeySet.add(normKey);
      collected.push({
        relativePath: relPosix,
        fileUri: toFileUri(fullAbs),
        sizeBytes,
        mtimeMs,
        gitStatus: gitStatusMap.get(normKey)?.status ?? 'clean',
        language: classifyLanguage(relPosix),
        isTestFile: detectTestFile(relPosix),
      });
    }
  };

  walk(root);

  // Include deleted tracked files AND any changed files skipped by `maxFiles` cap so reviewers never miss active changes
  for (const [normKey, { relPosix, status }] of gitStatusMap.entries()) {
    if (collectedKeySet.has(normKey)) continue;
    if (isSensitivePath(relPosix)) continue;
    const abs = path.join(root, relPosix);
    if (status === 'deleted') {
      collectedKeySet.add(normKey);
      collected.push({
        relativePath: relPosix,
        fileUri: toFileUri(abs),
        sizeBytes: 0,
        mtimeMs: 0,
        gitStatus: 'deleted',
        language: classifyLanguage(relPosix),
        isTestFile: detectTestFile(relPosix),
      });
    } else if (!gitignore.isIgnored(relPosix, false)) {
      try {
        const st = fs.lstatSync(abs);
        if (!st.isSymbolicLink() && st.isFile()) {
          collectedKeySet.add(normKey);
          collected.push({
            relativePath: relPosix,
            fileUri: toFileUri(abs),
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
            gitStatus: status,
            language: classifyLanguage(relPosix),
            isTestFile: detectTestFile(relPosix),
          });
        }
      } catch {
        // File vanished concurrently
      }
    }
  }

  // Sort changed files first, then alphabetically
  collected.sort((a, b) => {
    const aChanged = a.gitStatus !== 'clean' ? 0 : 1;
    const bChanged = b.gitStatus !== 'clean' ? 0 : 1;
    if (aChanged !== bChanged) return aChanged - bChanged;
    return a.relativePath.localeCompare(b.relativePath);
  });

  const changedFilesCount = collected.filter((f) => f.gitStatus !== 'clean').length;

  return {
    workspaceRoot: toPosixPath(root),
    workspaceName: path.basename(root) || toPosixPath(root),
    isGitRepo,
    hasInitialCommit,
    branchName,
    ...(gitWarning ? { gitWarning } : {}),
    totalFilesScanned: collected.length,
    changedFilesCount,
    files: collected,
  };
}

/**
 * Returns unified diff preview for a single validated workspace file (capped to 64 KiB).
 * Covers BOTH staged + unstaged changes (`git diff HEAD`), safely skips binary files without OOM,
 * and scrubs accidental secrets before returning text.
 */
export async function getSingleFileUnifiedDiff(
  workspaceRootInput: string,
  relativePathInput: string,
): Promise<{ relativePath: string; diffText: string; truncated: boolean }> {
  const guard = new PathGuard(workspaceRootInput);
  const resolved = guard.resolvePath(relativePathInput);

  let diffText = '';
  if (findEnclosingGitRootSync(guard.workspaceRoot)) {
    // Try `git diff HEAD` first so BOTH staged and unstaged edits are captured;
    // disable fsmonitor, ext-diff, and textconv so a malicious repo's `.git/config` can NEVER execute arbitrary commands!
    const baseGitFlags = [
      '--no-optional-locks',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.sshCommand=false',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
    ];
    let res = await runCommandSafe('git', [...baseGitFlags, 'HEAD', '--', resolved.relativePath], {
      cwd: guard.workspaceRoot,
      timeoutMs: 3_000,
      maxOutputBytes: 128 * 1024,
    });
    if (res.exitCode !== 0 || !res.stdout) {
      const cachedRes = await runCommandSafe('git', [...baseGitFlags, '--cached', '--', resolved.relativePath], {
        cwd: guard.workspaceRoot,
        timeoutMs: 3_000,
        maxOutputBytes: 128 * 1024,
      });
      if (cachedRes.exitCode === 0 && cachedRes.stdout) {
        res = cachedRes;
      } else {
        res = await runCommandSafe('git', [...baseGitFlags, '--', resolved.relativePath], {
          cwd: guard.workspaceRoot,
          timeoutMs: 3_000,
          maxOutputBytes: 128 * 1024,
        });
      }
    }
    diffText = res.stdout;
  }
  if (!diffText && !resolved.exists) {
    diffText = `[File deleted from working tree: ${resolved.relativePath}]`;
  } else if (!diffText && resolved.exists) {
    // Untracked or non-git file preview fallback: read ONLY the first 16 KiB to avoid OOM on large binaries!
    const stat = fs.statSync(resolved.absolutePath);
    if (stat.isFile()) {
      const previewBytes = Math.min(stat.size, 16 * 1024);
      const buf = Buffer.alloc(previewBytes);
      let actualRead = 0;
      if (previewBytes > 0) {
        const fd = fs.openSync(resolved.absolutePath, 'r');
        try {
          actualRead = fs.readSync(fd, buf, 0, previewBytes, 0);
        } finally {
          fs.closeSync(fd);
        }
      }
      const slice = buf.subarray(0, actualRead);
      if (slice.includes(0)) {
        diffText = `[Binary file — ${stat.size.toLocaleString()} bytes; unified text diff unavailable]`;
      } else {
        const raw =
          stat.size > previewBytes
            ? truncateUtf8Clean(slice.toString('utf8'), Math.max(1, actualRead - 4))
            : slice.toString('utf8');
        diffText = `--- /dev/null\n+++ b/${resolved.relativePath}\n${raw
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n')}${stat.size > previewBytes ? '\n... [Preview capped at 16 KiB]' : ''}`;
      }
    }
  }

  const sanitized = redactSecretsAndPaths(diffText, { redactPaths: false });
  const maxChars = 64 * 1024;
  const truncated = sanitized.length > maxChars;
  return {
    relativePath: resolved.relativePath,
    diffText: truncated
      ? `${sanitized.slice(0, maxChars)}\n... [Diff truncated — use chunked reader for full file]`
      : sanitized,
    truncated,
  };
}
