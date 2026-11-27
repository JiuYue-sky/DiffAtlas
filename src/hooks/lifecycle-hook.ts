/**
 * Ultra-fast (<50ms) synchronous Lifecycle Hook for DiffAtlas (`PreToolUse` & `PostToolUse`).
 *
 * Design rules (`hooks.md` & Charter §4.4 / §6 Risk #3 & #7):
 * 1. Bundled into a single zero-npm-dependency CJS file (`dist/hooks/lifecycle-hook.cjs`) for fast cold start.
 * 2. Hard 3.5s internal fail-open watchdog (`installHookFailOpenWatchdog`) well inside `hooks.json` `timeout: 5`.
 * 3. Any malformed JSON, missing path, or filesystem exception logs locally and outputs `{"decision":"allow"}` (or `{}` for `PostToolUse`), NEVER stalling the Agent loop.
 */

import path from 'node:path';
import { fromFileUri, toPosixPath } from '../kit/path-guard.js';
import { installHookFailOpenWatchdog } from '../kit/process-guard.js';
import {
  PluginStateStore,
  appendAuditLogSync,
  resolvePluginRuntimePaths,
} from '../kit/runtime-paths.js';
import { SnapshotEngine } from '../core/snapshot-engine.js';
import { DIFFATLAS_IDENTITY } from '../shared/identity.js';

const MAX_HOOK_STDIN_BYTES = 2 * 1024 * 1024;

interface HookStdinPayload {
  hookEventName?: string;
  conversationId?: string;
  workspacePaths?: string[];
  cwd?: string;
  modelName?: string;
  lastUserInput?: string;
  stepIdx?: number;
  error?: string;
  toolCall?: {
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
}

function readStdinAsync(maxBytes = MAX_HOOK_STDIN_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };

    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (totalBytes + buf.length > maxBytes) {
        const remaining = Math.max(0, maxBytes - totalBytes);
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        totalBytes = maxBytes;
        process.stdin.pause();
        finish();
        return;
      }
      chunks.push(buf);
      totalBytes += buf.length;
    });
    process.stdin.on('end', () => finish());
    process.stdin.on('error', (err) => finish(err instanceof Error ? err : new Error(String(err))));
    process.stdin.resume();
  });
}

function extractTargetPathFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  // Skip brain artifact writes (when ArtifactMetadata is explicitly set)
  if (args.ArtifactMetadata && typeof args.ArtifactMetadata === 'object') {
    return null;
  }
  const candidates = [
    args.Path,
    args.TargetFile,
    args.AbsolutePath,
    args.FilePath,
    args.path,
    args.filePath,
    args.targetFile,
    args.file_path,
    args.target_file,
  ];
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) {
      const trimmed = cand.trim();
      if (trimmed.toLowerCase().startsWith('file://')) {
        const converted = fromFileUri(trimmed);
        if (converted) return converted;
      }
      return trimmed;
    }
  }
  return null;
}

function normalizeDirKey(dirPath: string): string {
  const posix = toPosixPath(path.resolve(dirPath));
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

function emitHookResponseAndExit(eventName: string | undefined): never {
  if (eventName === 'PostToolUse') {
    process.stdout.write('{}\n');
  } else {
    process.stdout.write('{"decision":"allow"}\n');
  }
  process.exit(0);
}

async function main(): Promise<void> {
  let detectedEventName: string | undefined = 'PreToolUse';

  const cancelWatchdog = installHookFailOpenWatchdog(3_500, () => {
    emitHookResponseAndExit(detectedEventName);
  });

  try {
    // Async stdin read avoids EAGAIN on macOS/Linux non-blocking Go pipes AND allows the 3.5s watchdog to fire!
    const rawStdin = (await readStdinAsync()).trim();
    if (!rawStdin) {
      cancelWatchdog();
      emitHookResponseAndExit('PreToolUse');
    }

    const payload = JSON.parse(rawStdin) as HookStdinPayload;
    detectedEventName = payload.hookEventName ?? 'PreToolUse';

    const targetPath = extractTargetPathFromArgs(payload.toolCall?.args);
    if (!targetPath) {
      cancelWatchdog();
      emitHookResponseAndExit(detectedEventName);
    }

    const pluginRootKey = process.env.PLUGIN_ROOT ? normalizeDirKey(process.env.PLUGIN_ROOT) : null;
    const isPluginSelfDir = (p: string): boolean => {
      if (pluginRootKey && normalizeDirKey(p) === pluginRootKey) return true;
      return /(?:^|\/)(?:\.agents?|_agents?)\/plugins\/diffatlas(?:\/|$)/i.test(toPosixPath(p));
    };

    // Determine workspace root(s): deduplicate and prefer deepest matching workspace root first
    // so multi-root & nested workspaces always capture under the most specific owning workspace!
    const rawRoots = [
      ...(Array.isArray(payload.workspacePaths) ? payload.workspacePaths : []),
      ...(payload.cwd ? [payload.cwd] : []),
    ]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => {
        const trimmed = p.trim();
        return trimmed.toLowerCase().startsWith('file://') ? (fromFileUri(trimmed) ?? trimmed) : trimmed;
      })
      .filter((p) => !isPluginSelfDir(p));

    const seenRootKeys = new Set<string>();
    const candidateRoots = rawRoots
      .filter((r) => {
        const key = normalizeDirKey(r);
        if (seenRootKeys.has(key)) return false;
        seenRootKeys.add(key);
        return true;
      })
      .sort((a, b) => path.resolve(b).length - path.resolve(a).length);

    if (candidateRoots.length === 0) {
      cancelWatchdog();
      emitHookResponseAndExit(detectedEventName);
    }

    // If tool supplied a relative path, anchor it to `payload.cwd` (when valid) so multi-root loops never misroute it
    const rawCwd = payload.cwd?.trim();
    const resolvedCwd = rawCwd && rawCwd.toLowerCase().startsWith('file://') ? (fromFileUri(rawCwd) ?? rawCwd) : rawCwd;
    const effectiveCwd = resolvedCwd && !isPluginSelfDir(resolvedCwd) ? resolvedCwd : undefined;
    const effectiveTargetPath =
      !path.isAbsolute(targetPath) && effectiveCwd ? path.resolve(effectiveCwd, targetPath) : targetPath;

    const runtimePaths = resolvePluginRuntimePaths(DIFFATLAS_IDENTITY);
    const engine = new SnapshotEngine(runtimePaths.dataDir, runtimePaths.auditLogPath);
    const toolName = payload.toolCall?.name ?? 'file_edit';

    for (const root of candidateRoots) {
      if (detectedEventName === 'PostToolUse') {
        // Skip recording postSha256 if the tool step itself failed (`payload.error` non-empty)
        if (!payload.error) {
          const res = engine.capturePostToolSnapshot({
            workspaceRoot: root,
            targetPath: effectiveTargetPath,
            toolName,
            toolCallId: payload.toolCall?.id,
            conversationId: payload.conversationId,
            modelName: payload.modelName,
            lastUserInput: payload.lastUserInput,
            stepIdx: payload.stepIdx,
          });
          if (res.updated) break;
        }
      } else {
        const res = engine.capturePreToolSnapshot({
          workspaceRoot: root,
          targetPath: effectiveTargetPath,
          toolName,
          toolCallId: payload.toolCall?.id,
          conversationId: payload.conversationId,
          modelName: payload.modelName,
          lastUserInput: payload.lastUserInput,
          stepIdx: payload.stepIdx,
        });
        if (res.captured) {
          new PluginStateStore(runtimePaths.stateDir).recordRecentTarget(root, 'workspace');
        }
        if (res.captured || res.skippedReason !== 'OUTSIDE_WORKSPACE') {
          break;
        }
      }
    }
  } catch (err) {
    try {
      const runtimePaths = resolvePluginRuntimePaths(DIFFATLAS_IDENTITY);
      appendAuditLogSync(runtimePaths.auditLogPath, {
        event: 'hook_fail_open_warning',
        actor: 'hook',
        detail: {
          hookEventName: detectedEventName ?? 'unknown',
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      // Never throw inside fail-open handler
    }
  } finally {
    cancelWatchdog();
  }

  emitHookResponseAndExit(detectedEventName);
}

void main();
