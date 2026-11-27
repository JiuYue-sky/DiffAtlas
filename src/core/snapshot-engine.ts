import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PathGuard, isSensitivePath, sanitizeUntrustedIdentifier, toPosixPath } from '../kit/path-guard.js';
import { appendAuditLogSync, atomicWriteFileSync, computeWorkspaceId } from '../kit/runtime-paths.js';

/** Skip snapshotting single files > 5 MiB so synchronous PreToolUse stays < 50ms */
export const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
/** Default LRU retention limits per workspace */
export const DEFAULT_MAX_CHECKPOINTS = 50;
export const DEFAULT_MAX_WORKSPACE_BLOBS_BYTES = 200 * 1024 * 1024;

export type CheckpointKind = 'agent_turn' | 'pre_rollback_backup';

export type SkippedSnapshotReason = 'TOO_LARGE' | 'SENSITIVE_BLOCKED' | 'NOT_REGULAR_FILE';

export interface SnapshotFileEntry {
  /** Workspace-relative POSIX path (e.g. `src/index.ts`) */
  relativePath: string;
  /** Whether the file existed BEFORE the first edit in this checkpoint */
  existedBefore: boolean;
  /** Deepest parent directory (workspace-relative POSIX, `""` for root) that ALREADY existed prior to file creation */
  preExistingParentRelPath?: string;
  /** SHA-256 of pre-edit bytes (`null` when `existedBefore === false` or skipped) */
  preSha256: string | null;
  /** Byte size before edit */
  preBytes: number;
  /** POSIX file permission mode bits (e.g. 0o755) preserved across rollback on macOS/Linux */
  preMode?: number;
  /** Latest SHA-256 recorded by `PostToolUse` after the Agent's edit (`null` if deleted or not yet recorded) */
  postSha256: string | null;
  /** Whether the file existed after the Agent's latest edit in this checkpoint */
  postExisted: boolean | null;
  /** Tool call IDs that touched this file within the checkpoint */
  toolCallIds: string[];
  /** Last tool name (e.g. `write_file`, `edit_file`) */
  lastToolName: string;
  /** Populated when file was intentionally not snapshotted */
  skippedReason?: SkippedSnapshotReason;
  /** Timestamp of first pre-edit capture */
  firstCapturedAt: string;
  /** Timestamp of latest post-edit update */
  updatedAt: string;
}

export interface CheckpointRecord {
  /** Unique checkpoint ID (e.g. `cp_20261126_001500_a1b2c3`) */
  id: string;
  /** Grouping key combining conversationId + modelName + prompt hash */
  turnKey: string;
  conversationId: string;
  /** Optional model identifier from Hook payload (triggers automatic split on mid-turn model switch!) */
  modelName?: string;
  /** Latest stepIdx captured inside this checkpoint */
  lastStepIdx?: number;
  kind: CheckpointKind;
  /** Sanitized short user prompt or backup label */
  label: string;
  createdAt: string;
  updatedAt: string;
  files: SnapshotFileEntry[];
}

export interface WorkspaceSnapshotIndex {
  schemaVersion: 1;
  workspaceId: string;
  workspaceRoot: string;
  updatedAt: string;
  checkpoints: CheckpointRecord[];
}

/**
 * Exhaustive state machine disposition for each file during rollback evaluation.
 */
export type RollbackFileDisposition =
  | 'NOOP_ALREADY_MATCHES'
  | 'READY_CLEAN_RESTORE'
  | 'READY_CLEAN_DELETE_CREATED'
  | 'CONFLICT_HUMAN_MODIFIED'
  | 'SKIPPED_UNTRACKED'
  | 'ERROR_MISSING_BLOB';

export interface RollbackFilePlan {
  relativePath: string;
  disposition: RollbackFileDisposition;
  existedBefore: boolean;
  preExistingParentRelPath?: string;
  preMode?: number;
  targetPreSha256: string | null;
  latestTrackedPostSha256: string | null;
  currentDiskSha256: string | null;
  currentDiskExists: boolean;
  reason: string;
}

export interface RollbackPreviewResult extends Record<string, unknown> {
  checkpointId: string;
  checkpointLabel: string;
  /** Echoes requested single-file/subset filter so UI Confirm restores ONLY the previewed subset! */
  onlyPaths?: string[];
  canRestoreCleanly: boolean;
  hasConflicts: boolean;
  hasMissingBlobs: boolean;
  actionableCount: number;
  conflictCount: number;
  files: RollbackFilePlan[];
}

export interface RollbackExecutionOptions {
  /** Optional subset of workspace-relative paths to restore (defaults to all files from target checkpoint onward) */
  onlyPaths?: string[];
  /** Must be `true` to overwrite files in `CONFLICT_HUMAN_MODIFIED` state */
  allowOverwriteConflicts?: boolean;
}

export type RollbackExecutionStatus =
  | 'RESTORED'
  | 'NOOP'
  | 'BLOCKED_CONFLICT'
  | 'ERROR_MISSING_BLOB'
  | 'ERROR_NOT_FOUND';

export interface RollbackExecutionResult extends Record<string, unknown> {
  status: RollbackExecutionStatus;
  checkpointId: string;
  backupCheckpointId: string | null;
  restoredPaths: string[];
  deletedCreatedPaths: string[];
  skippedPaths: string[];
  conflicts: RollbackFilePlan[];
  preview: RollbackPreviewResult | null;
  message: string;
}

export interface PreToolCaptureInput {
  workspaceRoot: string;
  targetPath: string;
  toolName: string;
  toolCallId?: string;
  conversationId?: string;
  lastUserInput?: string;
  modelName?: string;
  stepIdx?: number;
  /** Optional clock override for deterministic unit testing */
  nowMs?: number;
}

export interface PreToolCaptureOutcome {
  captured: boolean;
  checkpointId?: string;
  relativePath?: string;
  skippedReason?: SkippedSnapshotReason | 'OUTSIDE_WORKSPACE';
  durationMs: number;
}

export interface SnapshotEngineLimits {
  maxFileBytes?: number;
  maxCheckpoints?: number;
  maxWorkspaceBlobBytes?: number;
  /** Idle window (ms) after which identical prompts (e.g., repeated "继续") open a fresh checkpoint (default: 30,000ms) */
  turnIdleSplitMs?: number;
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFileSync(
  absPath: string,
  maxBytes: number = MAX_SNAPSHOT_FILE_BYTES,
): { exists: boolean; isFile: boolean; size: number; sha256: string | null; tooLarge?: boolean } {
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      return { exists: true, isFile: false, size: st.size, sha256: null };
    }
    if (st.size > maxBytes) {
      return { exists: true, isFile: true, size: st.size, sha256: null, tooLarge: true };
    }
    const buf = fs.readFileSync(absPath);
    return { exists: true, isFile: true, size: buf.length, sha256: sha256Buffer(buf) };
  } catch {
    return { exists: false, isFile: false, size: 0, sha256: null };
  }
}

function buildTurnKey(
  conversationId: string,
  lastUserInput: string | undefined,
  modelName: string | undefined,
): string {
  const conv = (conversationId || 'local').slice(0, 36);
  const modelTag = (modelName || 'default').trim().toLowerCase().slice(0, 32);
  const promptDigest = crypto
    .createHash('sha256')
    .update((lastUserInput ?? 'manual').trim())
    .digest('hex')
    .slice(0, 12);
  return `${conv}:${modelTag}:${promptDigest}`;
}

/**
 * Deterministic Snapshot & Rollback State Machine (`SnapEngine`).
 *
 * Key guarantees:
 * 1. Content-addressed SHA-256 blob deduplication under `${PLUGIN_DATA}/snapshots/<workspaceId>/blobs/`.
 * 2. Preserves FIRST `preState` within a turn while updating LATEST `postState` across multi-step edits.
 * 3. Exact 3-way conflict detection (`currentDiskSha256` vs `latestTrackedPostSha256` vs `targetPreSha256`).
 * 4. Mandatory Undo-of-Undo backup checkpoint (`pre_rollback_backup`) written BEFORE any disk restore/delete.
 * 5. Stale-safe lockfile + atomic index rename + LRU quota eviction (50 turns / 200 MiB).
 */
export class SnapshotEngine {
  private readonly snapshotsRoot: string;
  private readonly auditLogPath: string;
  private readonly maxFileBytes: number;
  private readonly maxCheckpoints: number;
  private readonly maxWorkspaceBlobBytes: number;
  private readonly turnIdleSplitMs: number;

  constructor(dataDir: string, auditLogPath: string, limits: SnapshotEngineLimits = {}) {
    this.snapshotsRoot = path.join(dataDir, 'snapshots');
    this.auditLogPath = auditLogPath;
    this.maxFileBytes = limits.maxFileBytes ?? MAX_SNAPSHOT_FILE_BYTES;
    this.maxCheckpoints = limits.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.maxWorkspaceBlobBytes = limits.maxWorkspaceBlobBytes ?? DEFAULT_MAX_WORKSPACE_BLOBS_BYTES;
    this.turnIdleSplitMs = limits.turnIdleSplitMs ?? 30_000;
    fs.mkdirSync(this.snapshotsRoot, { recursive: true });
  }

  private getWorkspaceDir(workspaceId: string): string {
    return path.join(this.snapshotsRoot, workspaceId);
  }

  private getIndexPath(workspaceId: string): string {
    return path.join(this.getWorkspaceDir(workspaceId), 'index.json');
  }

  private getBlobPath(workspaceId: string, sha256: string): string {
    return path.join(this.getWorkspaceDir(workspaceId), 'blobs', sha256.slice(0, 2), `${sha256}.blob`);
  }

  private withWorkspaceLock<T>(workspaceId: string, fn: () => T): T {
    const wsDir = this.getWorkspaceDir(workspaceId);
    fs.mkdirSync(wsDir, { recursive: true });
    const lockPath = path.join(wsDir, 'index.lock');
    const staleThresholdMs = 3_000;
    let acquired = false;

    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid}:${Date.now()}`);
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > staleThresholdMs) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock vanished concurrently
        }
        // Brief spin-free pause via SharedArrayBuffer Atomics.wait (supported in Node >= 20 worker/main)
        try {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 15);
        } catch {
          // Ignore if unavailable
        }
      }
    }

    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore
        }
      }
    }
  }

  private readIndex(workspaceId: string, canonicalWorkspaceRoot: string): WorkspaceSnapshotIndex {
    const indexPath = this.getIndexPath(workspaceId);
    try {
      if (fs.existsSync(indexPath)) {
        const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as WorkspaceSnapshotIndex;
        if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.checkpoints)) {
          return parsed;
        }
      }
    } catch {
      // Corrupted index recovers cleanly with empty list rather than crashing
    }
    return {
      schemaVersion: 1,
      workspaceId,
      workspaceRoot: canonicalWorkspaceRoot,
      updatedAt: new Date().toISOString(),
      checkpoints: [],
    };
  }

  private writeIndex(index: WorkspaceSnapshotIndex): void {
    index.updatedAt = new Date().toISOString();
    atomicWriteFileSync(this.getIndexPath(index.workspaceId), JSON.stringify(index, null, 2));
  }

  private writeBlobIfMissing(workspaceId: string, buf: Buffer): string {
    const hash = sha256Buffer(buf);
    const blobPath = this.getBlobPath(workspaceId, hash);
    if (!fs.existsSync(blobPath)) {
      atomicWriteFileSync(blobPath, buf);
    }
    return hash;
  }

  private readBlobVerified(workspaceId: string, expectedSha256: string): Buffer | null {
    const blobPath = this.getBlobPath(workspaceId, expectedSha256);
    if (!fs.existsSync(blobPath)) return null;
    try {
      const buf = fs.readFileSync(blobPath);
      if (sha256Buffer(buf) !== expectedSha256) return null;
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Enforces LRU checkpoint retention (`maxCheckpoints` & `maxWorkspaceBlobBytes`)
   * and garbage-collects unreferenced content-addressed blobs.
   * Uses O(files) in-memory byte accounting so the common non-evicting PreToolUse path performs ZERO directory scans!
   */
  private enforceQuotaSync(index: WorkspaceSnapshotIndex): void {
    let evictedCount = 0;
    while (index.checkpoints.length > this.maxCheckpoints) {
      // Checkpoints stored newest-first -> pop oldest from tail
      index.checkpoints.pop();
      evictedCount++;
    }

    const collectReferencedSizes = (): Map<string, number> => {
      const refs = new Map<string, number>();
      for (const cp of index.checkpoints) {
        for (const f of cp.files) {
          if (f.preSha256 && !refs.has(f.preSha256)) {
            refs.set(f.preSha256, f.preBytes);
          }
        }
      }
      return refs;
    };

    let refMap = collectReferencedSizes();
    let referencedBytes = 0;
    for (const sz of refMap.values()) referencedBytes += sz;

    while (referencedBytes > this.maxWorkspaceBlobBytes && index.checkpoints.length > 1) {
      index.checkpoints.pop();
      evictedCount++;
      refMap = collectReferencedSizes();
      referencedBytes = 0;
      for (const sz of refMap.values()) referencedBytes += sz;
    }

    // Fast path: when zero checkpoints were evicted, no existing blobs became orphaned!
    if (evictedCount === 0) return;

    const blobsRoot = path.join(this.getWorkspaceDir(index.workspaceId), 'blobs');
    let totalBytes = referencedBytes;
    if (fs.existsSync(blobsRoot)) {
      let diskRemainingBytes = 0;
      for (const prefixDir of fs.readdirSync(blobsRoot)) {
        const subDir = path.join(blobsRoot, prefixDir);
        let st;
        try {
          st = fs.statSync(subDir);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        for (const name of fs.readdirSync(subDir)) {
          if (!name.endsWith('.blob')) continue;
          const hash = name.slice(0, -'.blob'.length);
          const fullPath = path.join(subDir, name);
          if (!refMap.has(hash)) {
            try {
              fs.unlinkSync(fullPath);
            } catch {
              // Ignore
            }
          } else {
            try {
              diskRemainingBytes += fs.statSync(fullPath).size;
            } catch {
              // Ignore
            }
          }
        }
      }
      totalBytes = diskRemainingBytes;
    }

    appendAuditLogSync(this.auditLogPath, {
      event: 'snapshot_quota_evict',
      actor: 'system',
      workspaceId: index.workspaceId,
      detail: { evictedCheckpoints: evictedCount, remainingCheckpoints: index.checkpoints.length, totalBytes },
    });
  }

  /**
   * Called synchronously from `PreToolUse` BEFORE `write_file` / `edit_file` mutates disk.
   * Designed for `< 50ms` execution.
   */
  public capturePreToolSnapshot(input: PreToolCaptureInput): PreToolCaptureOutcome {
    const start = performance.now();
    let guard: PathGuard;
    try {
      guard = new PathGuard(input.workspaceRoot);
    } catch {
      return {
        captured: false,
        skippedReason: 'OUTSIDE_WORKSPACE',
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    // Resolve with `allowSensitive: true` ONLY to classify whether path is inside workspace vs sensitive
    let resolved;
    try {
      resolved = guard.resolvePath(input.targetPath, { allowSensitive: true });
    } catch {
      // Outside workspace (e.g. brain artifact directory) -> immediately allow without snapshotting
      return {
        captured: false,
        skippedReason: 'OUTSIDE_WORKSPACE',
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    if (resolved.relativePath === '') {
      return {
        captured: false,
        skippedReason: 'NOT_REGULAR_FILE',
        durationMs: Math.round((performance.now() - start) * 100) / 100,
      };
    }

    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    const nowMs = input.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const conversationId = input.conversationId || 'local';
    const cleanModelName = input.modelName?.trim() || undefined;
    const turnKey = buildTurnKey(conversationId, input.lastUserInput, cleanModelName);
    const label = sanitizeUntrustedIdentifier(input.lastUserInput || `${input.toolName} on ${resolved.relativePath}`, 96);
    const toolCallId = input.toolCallId || `step_${input.stepIdx ?? 0}_${nowMs}`;

    let skippedReason: SkippedSnapshotReason | undefined;
    let existedBefore = false;
    let preBytes = 0;

    if (isSensitivePath(resolved.relativePath)) {
      skippedReason = 'SENSITIVE_BLOCKED';
    }

    const checkpointId = this.withWorkspaceLock(workspaceId, () => {
      const index = this.readIndex(workspaceId, guard.workspaceRoot);

      // Reuse newest checkpoint ONLY if it belongs to the exact same `turnKey` (including modelName),
      // is an `agent_turn`, stepIdx did not reset backward, and idle time has not exceeded `turnIdleSplitMs`
      // (prevents mid-turn model switches or repeated short prompts like "继续" from collapsing separate turns!).
      let checkpoint = index.checkpoints[0];
      const prevUpdatedMs = checkpoint ? Date.parse(checkpoint.updatedAt) : NaN;
      const idleExceeded =
        Number.isFinite(prevUpdatedMs) &&
        (nowMs - prevUpdatedMs > this.turnIdleSplitMs || prevUpdatedMs - nowMs > this.turnIdleSplitMs);
      const stepRegressed =
        input.stepIdx !== undefined &&
        checkpoint?.lastStepIdx !== undefined &&
        input.stepIdx < checkpoint.lastStepIdx;

      if (
        !checkpoint ||
        checkpoint.turnKey !== turnKey ||
        checkpoint.kind !== 'agent_turn' ||
        idleExceeded ||
        stepRegressed
      ) {
        checkpoint = {
          id: `cp_${nowMs}_${crypto.randomBytes(3).toString('hex')}`,
          turnKey,
          conversationId,
          ...(cleanModelName ? { modelName: cleanModelName } : {}),
          ...(input.stepIdx !== undefined ? { lastStepIdx: input.stepIdx } : {}),
          kind: 'agent_turn',
          label: label || 'Agent workspace edit',
          createdAt: nowIso,
          updatedAt: nowIso,
          files: [],
        };
        index.checkpoints.unshift(checkpoint);
      } else {
        checkpoint.updatedAt = nowIso;
        if (input.stepIdx !== undefined) {
          checkpoint.lastStepIdx = input.stepIdx;
        }
      }

      const existingEntry = checkpoint.files.find((f) => f.relativePath === resolved.relativePath);
      if (!existingEntry) {
        let preExistingParentRelPath: string | undefined;
        let preMode: number | undefined;
        let fileBuf: Buffer | null = null;

        if (!skippedReason && resolved.exists) {
          try {
            const st = fs.lstatSync(resolved.absolutePath);
            if (!st.isFile() || st.isSymbolicLink()) {
              skippedReason = 'NOT_REGULAR_FILE';
            } else if (st.size > this.maxFileBytes) {
              existedBefore = true;
              preBytes = st.size;
              skippedReason = 'TOO_LARGE';
            } else {
              existedBefore = true;
              if (process.platform !== 'win32') {
                preMode = st.mode & 0o777;
              }
              fileBuf = fs.readFileSync(resolved.absolutePath);
              preBytes = fileBuf.length;
            }
          } catch {
            existedBefore = false;
          }
        }

        if (!existedBefore && !skippedReason) {
          let anc = path.dirname(resolved.absolutePath);
          while (!fs.existsSync(anc)) {
            const relToRoot = path.relative(guard.workspaceRoot, anc);
            if (!relToRoot || relToRoot === '..' || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot)) {
              anc = guard.workspaceRoot;
              break;
            }
            const nextAnc = path.dirname(anc);
            if (nextAnc === anc) break;
            anc = nextAnc;
          }
          const finalRel = toPosixPath(path.relative(guard.workspaceRoot, anc));
          preExistingParentRelPath = finalRel === '..' || finalRel.startsWith('../') ? '' : finalRel;
        }

        const preSha256 = fileBuf ? this.writeBlobIfMissing(workspaceId, fileBuf) : null;
        checkpoint.files.push({
          relativePath: resolved.relativePath,
          existedBefore,
          ...(preExistingParentRelPath !== undefined ? { preExistingParentRelPath } : {}),
          ...(preMode !== undefined ? { preMode } : {}),
          preSha256,
          preBytes,
          postSha256: null,
          postExisted: null,
          toolCallIds: [toolCallId],
          lastToolName: input.toolName,
          ...(skippedReason ? { skippedReason } : {}),
          firstCapturedAt: nowIso,
          updatedAt: nowIso,
        });
        this.enforceQuotaSync(index);
      } else {
        // Fast path on 2nd+ edit of the same file in the same turn: preserve FIRST `preSha256` with zero file/blob I/O!
        existedBefore = existingEntry.existedBefore;
        preBytes = existingEntry.preBytes;
        skippedReason = existingEntry.skippedReason;
        if (!existingEntry.toolCallIds.includes(toolCallId)) {
          existingEntry.toolCallIds.push(toolCallId);
        }
        existingEntry.lastToolName = input.toolName;
        existingEntry.updatedAt = nowIso;
      }

      this.writeIndex(index);
      return checkpoint.id;
    });

    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    appendAuditLogSync(this.auditLogPath, {
      event: 'snapshot_pre',
      actor: 'hook',
      workspaceId,
      detail: {
        checkpointId,
        relativePath: resolved.relativePath,
        existedBefore,
        preBytes,
        skippedReason: skippedReason ?? null,
        durationMs,
      },
    });

    return {
      captured: !skippedReason,
      checkpointId,
      relativePath: resolved.relativePath,
      skippedReason,
      durationMs,
    };
  }

  /**
   * Called synchronously from `PostToolUse` AFTER `write_file` / `edit_file` finishes.
   * Records `postSha256` on the checkpoint entry to enable exact 3-way conflict detection!
   */
  public capturePostToolSnapshot(input: PreToolCaptureInput): { updated: boolean; durationMs: number } {
    const start = performance.now();
    let guard: PathGuard;
    try {
      guard = new PathGuard(input.workspaceRoot);
    } catch {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }

    let resolved;
    try {
      resolved = guard.resolvePath(input.targetPath, { allowSensitive: true });
    } catch {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }

    if (isSensitivePath(resolved.relativePath) || resolved.relativePath === '') {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }

    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    // Respect `this.maxFileBytes` so PostToolUse NEVER reads >5 MiB binaries into RAM!
    const postDisk = hashFileSync(resolved.absolutePath, this.maxFileBytes);
    if (postDisk.tooLarge) {
      return { updated: false, durationMs: Math.round((performance.now() - start) * 100) / 100 };
    }
    const nowIso = new Date(input.nowMs ?? Date.now()).toISOString();

    const updated = this.withWorkspaceLock(workspaceId, () => {
      const index = this.readIndex(workspaceId, guard.workspaceRoot);
      const toolCallId = input.toolCallId;
      for (const cp of index.checkpoints) {
        const match = cp.files.find(
          (f) => f.relativePath === resolved.relativePath && (!toolCallId || f.toolCallIds.includes(toolCallId)),
        );
        if (match) {
          match.postExisted = postDisk.exists && postDisk.isFile;
          match.postSha256 = postDisk.sha256;
          match.updatedAt = nowIso;
          cp.updatedAt = nowIso;
          this.writeIndex(index);
          return true;
        }
      }
      // Fallback: update newest checkpoint touching relativePath
      const newestMatch = index.checkpoints[0]?.files.find((f) => f.relativePath === resolved.relativePath);
      if (newestMatch && index.checkpoints[0]) {
        newestMatch.postExisted = postDisk.exists && postDisk.isFile;
        newestMatch.postSha256 = postDisk.sha256;
        newestMatch.updatedAt = nowIso;
        index.checkpoints[0].updatedAt = nowIso;
        this.writeIndex(index);
        return true;
      }
      return false;
    });

    return {
      updated,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }

  public listCheckpoints(workspaceRootInput: string): CheckpointRecord[] {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    return this.readIndex(workspaceId, guard.workspaceRoot).checkpoints;
  }

  /**
   * Computes the exact rollback plan from current disk state back to BEFORE `checkpointId`
   * (rolling back `checkpointId` and any newer `agent_turn` checkpoints stacked on top of it,
   * OR if `checkpointId` is a `pre_rollback_backup`, restoring directly to that backup!).
   */
  public previewRollback(
    workspaceRootInput: string,
    checkpointId: string,
    onlyPaths?: readonly string[],
  ): RollbackPreviewResult | null {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);
    const index = this.readIndex(workspaceId, guard.workspaceRoot);

    const targetIdx = index.checkpoints.findIndex((cp) => cp.id === checkpointId);
    if (targetIdx === -1) return null;
    const targetCp = index.checkpoints[targetIdx]!;

    // Slice from newest (0) down to targetIdx inclusive, ordered oldest -> newest
    const sliceOldestToNewest = index.checkpoints.slice(0, targetIdx + 1).reverse();

    // If rolling back specifically to a `pre_rollback_backup`, only evaluate that backup's own files;
    // otherwise accumulate earliest `preState` from targetCp forward + latest `postState` up to present!
    const effectiveSequence =
      targetCp.kind === 'pre_rollback_backup' ? [targetCp] : sliceOldestToNewest;

    const normalizedOnlyPaths =
      onlyPaths && onlyPaths.length > 0 ? onlyPaths.map((p) => toPosixPath(p).replace(/^\.\//, '')) : undefined;
    const filterSet = normalizedOnlyPaths ? new Set(normalizedOnlyPaths) : null;

    const perFile = new Map<
      string,
      {
        baselineEntry: SnapshotFileEntry;
        latestPostSha256: string | null;
        latestPostExisted: boolean | null;
      }
    >();

    for (const cp of effectiveSequence) {
      for (const entry of cp.files) {
        if (filterSet && !filterSet.has(entry.relativePath)) continue;
        const existing = perFile.get(entry.relativePath);
        if (!existing) {
          perFile.set(entry.relativePath, {
            baselineEntry: entry,
            latestPostSha256: entry.postSha256,
            latestPostExisted: entry.postExisted,
          });
        } else if (entry.postSha256 !== null || entry.postExisted !== null) {
          existing.latestPostSha256 = entry.postSha256;
          existing.latestPostExisted = entry.postExisted;
        }
      }
    }

    const plans: RollbackFilePlan[] = [];
    for (const [relativePath, info] of perFile.entries()) {
      const { baselineEntry, latestPostSha256, latestPostExisted } = info;
      if (baselineEntry.skippedReason) {
        plans.push({
          relativePath,
          disposition: 'SKIPPED_UNTRACKED',
          existedBefore: baselineEntry.existedBefore,
          targetPreSha256: null,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: null,
          currentDiskExists: false,
          reason: `File was skipped during capture (${baselineEntry.skippedReason}).`,
        });
        continue;
      }

      const resolved = guard.resolvePath(relativePath);
      const disk = hashFileSync(resolved.absolutePath, this.maxFileBytes);

      // Verify blob integrity when `existedBefore === true`
      if (baselineEntry.existedBefore) {
        if (!baselineEntry.preSha256 || !this.readBlobVerified(workspaceId, baselineEntry.preSha256)) {
          plans.push({
            relativePath,
            disposition: 'ERROR_MISSING_BLOB',
            existedBefore: true,
            targetPreSha256: baselineEntry.preSha256,
            latestTrackedPostSha256: latestPostSha256,
            currentDiskSha256: disk.sha256,
            currentDiskExists: disk.exists,
            reason: 'Snapshot blob is missing or failed SHA-256 verification.',
          });
          continue;
        }
      }

      // Case 1: Disk already matches target baseline!
      if (!baselineEntry.existedBefore && !disk.exists) {
        plans.push({
          relativePath,
          disposition: 'NOOP_ALREADY_MATCHES',
          existedBefore: false,
          targetPreSha256: null,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: null,
          currentDiskExists: false,
          reason: 'File is already absent on disk.',
        });
        continue;
      }
      if (baselineEntry.existedBefore && disk.exists && disk.sha256 === baselineEntry.preSha256) {
        plans.push({
          relativePath,
          disposition: 'NOOP_ALREADY_MATCHES',
          existedBefore: true,
          targetPreSha256: baselineEntry.preSha256,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: disk.sha256,
          currentDiskExists: true,
          reason: 'Current disk content already matches checkpoint baseline.',
        });
        continue;
      }

      // Case 2: 3-Way Human-Edit Conflict Check!
      const matchesLatestAgentState =
        latestPostExisted === false
          ? !disk.exists
          : latestPostSha256 !== null && disk.exists && disk.sha256 === latestPostSha256;

      if (!matchesLatestAgentState) {
        plans.push({
          relativePath,
          disposition: 'CONFLICT_HUMAN_MODIFIED',
          existedBefore: baselineEntry.existedBefore,
          ...(baselineEntry.preExistingParentRelPath !== undefined
            ? { preExistingParentRelPath: baselineEntry.preExistingParentRelPath }
            : {}),
          ...(baselineEntry.preMode !== undefined ? { preMode: baselineEntry.preMode } : {}),
          targetPreSha256: baselineEntry.preSha256,
          latestTrackedPostSha256: latestPostSha256,
          currentDiskSha256: disk.sha256,
          currentDiskExists: disk.exists,
          reason:
            latestPostSha256 === null
              ? 'Post-tool hash was not recorded; file may contain manual changes.'
              : 'File was modified on disk after the Agent edit (manual edit detected).',
        });
        continue;
      }

      // Case 3: Clean restore or clean delete of Agent-created file
      plans.push({
        relativePath,
        disposition: baselineEntry.existedBefore ? 'READY_CLEAN_RESTORE' : 'READY_CLEAN_DELETE_CREATED',
        existedBefore: baselineEntry.existedBefore,
        ...(baselineEntry.preExistingParentRelPath !== undefined
          ? { preExistingParentRelPath: baselineEntry.preExistingParentRelPath }
          : {}),
        ...(baselineEntry.preMode !== undefined ? { preMode: baselineEntry.preMode } : {}),
        targetPreSha256: baselineEntry.preSha256,
        latestTrackedPostSha256: latestPostSha256,
        currentDiskSha256: disk.sha256,
        currentDiskExists: disk.exists,
        reason: baselineEntry.existedBefore
          ? 'Ready to restore pre-edit file content.'
          : 'Ready to remove file created during Agent turn (current bytes backed up first).',
      });
    }

    const conflictCount = plans.filter((p) => p.disposition === 'CONFLICT_HUMAN_MODIFIED').length;
    const hasMissingBlobs = plans.some((p) => p.disposition === 'ERROR_MISSING_BLOB');
    const actionableCount = plans.filter(
      (p) =>
        p.disposition === 'READY_CLEAN_RESTORE' ||
        p.disposition === 'READY_CLEAN_DELETE_CREATED' ||
        p.disposition === 'CONFLICT_HUMAN_MODIFIED',
    ).length;

    return {
      checkpointId: targetCp.id,
      checkpointLabel: targetCp.label,
      ...(normalizedOnlyPaths ? { onlyPaths: normalizedOnlyPaths } : {}),
      canRestoreCleanly: !hasMissingBlobs && conflictCount === 0,
      hasConflicts: conflictCount > 0,
      hasMissingBlobs,
      actionableCount,
      conflictCount,
      files: plans,
    };
  }

  /**
   * Executes a human-confirmed rollback (`visibility: ["app"]` only!).
   * Enforces:
   * 1. Conflict gate unless `allowOverwriteConflicts === true`.
   * 2. Mandatory Undo-of-Undo backup checkpoint BEFORE mutating any workspace file.
   * 3. Atomic file writes and audit logging.
   */
  public restoreCheckpoint(
    workspaceRootInput: string,
    checkpointId: string,
    options: RollbackExecutionOptions = {},
  ): RollbackExecutionResult {
    const guard = new PathGuard(workspaceRootInput);
    const workspaceId = computeWorkspaceId(guard.workspaceRoot);

    return this.withWorkspaceLock(workspaceId, () => {
      const preview = this.previewRollback(guard.workspaceRoot, checkpointId, options.onlyPaths);
      if (!preview) {
        return {
          status: 'ERROR_NOT_FOUND',
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts: [],
          preview: null,
          message: `Checkpoint "${checkpointId}" was not found.`,
        };
      }

      if (preview.hasMissingBlobs) {
        return {
          status: 'ERROR_MISSING_BLOB',
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts: [],
          preview,
          message: 'Rollback aborted: one or more snapshot blobs failed integrity verification.',
        };
      }

      const conflicts = preview.files.filter((f) => f.disposition === 'CONFLICT_HUMAN_MODIFIED');
      if (conflicts.length > 0 && options.allowOverwriteConflicts !== true) {
        appendAuditLogSync(this.auditLogPath, {
          event: 'rollback_blocked_conflict',
          actor: 'app',
          workspaceId,
          detail: { checkpointId, conflictPaths: conflicts.map((c) => c.relativePath) },
        });
        return {
          status: 'BLOCKED_CONFLICT',
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: [],
          conflicts,
          preview,
          message: `Rollback paused: ${conflicts.length} file(s) have manual edits since the Agent turn. Review conflicts to confirm.`,
        };
      }

      const actionable = preview.files.filter(
        (f) =>
          f.disposition === 'READY_CLEAN_RESTORE' ||
          f.disposition === 'READY_CLEAN_DELETE_CREATED' ||
          (f.disposition === 'CONFLICT_HUMAN_MODIFIED' && options.allowOverwriteConflicts === true),
      );

      if (actionable.length === 0) {
        return {
          status: 'NOOP',
          checkpointId,
          backupCheckpointId: null,
          restoredPaths: [],
          deletedCreatedPaths: [],
          skippedPaths: preview.files.map((f) => f.relativePath),
          conflicts: [],
          preview,
          message: 'Workspace already matches the selected checkpoint.',
        };
      }

      // STEP 1: Mandatory Undo-of-Undo safety backup of current disk state BEFORE touching workspace!
      const nowIso = new Date().toISOString();
      const backupCpId = `cp_backup_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
      const index = this.readIndex(workspaceId, guard.workspaceRoot);
      const backupEntries: SnapshotFileEntry[] = [];

      const maxUndoBackupBytes = Math.max(this.maxFileBytes * 4, 20 * 1024 * 1024);

      for (const plan of actionable) {
        const resolved = guard.resolvePath(plan.relativePath);
        let existedNow = false;
        let curSha: string | null = null;
        let curBytes = 0;
        let curMode: number | undefined;

        if (fs.existsSync(resolved.absolutePath)) {
          const curStat = fs.lstatSync(resolved.absolutePath);
          if (!curStat.isSymbolicLink() && curStat.isFile()) {
            if (curStat.size > maxUndoBackupBytes) {
              return {
                status: 'ERROR_MISSING_BLOB',
                checkpointId,
                backupCheckpointId: null,
                restoredPaths: [],
                deletedCreatedPaths: [],
                skippedPaths: [],
                conflicts,
                preview,
                message: `Rollback aborted safely: current disk file "${plan.relativePath}" (${curStat.size} bytes) exceeds safe Undo-backup limit.`,
              };
            }
            const curBuf = fs.readFileSync(resolved.absolutePath);
            existedNow = true;
            curBytes = curBuf.length;
            if (process.platform !== 'win32') {
              curMode = curStat.mode & 0o777;
            }
            curSha = this.writeBlobIfMissing(workspaceId, curBuf);
          }
        }

        backupEntries.push({
          relativePath: plan.relativePath,
          existedBefore: existedNow,
          ...(curMode !== undefined ? { preMode: curMode } : {}),
          preSha256: curSha,
          preBytes: curBytes,
          postSha256: plan.targetPreSha256,
          postExisted: plan.existedBefore,
          toolCallIds: ['app_restore_checkpoint'],
          lastToolName: 'app_restore_checkpoint',
          firstCapturedAt: nowIso,
          updatedAt: nowIso,
        });
      }

      const backupCheckpoint: CheckpointRecord = {
        id: backupCpId,
        turnKey: `backup:${backupCpId}`,
        conversationId: 'human-ui',
        kind: 'pre_rollback_backup',
        label: `Undo backup before restoring "${preview.checkpointLabel}"`,
        createdAt: nowIso,
        updatedAt: nowIso,
        files: backupEntries,
      };

      index.checkpoints.unshift(backupCheckpoint);

      // STEP 2: Apply atomic restore / deletion inside PathGuard sandbox
      const restoredPaths: string[] = [];
      const deletedCreatedPaths: string[] = [];

      for (const plan of actionable) {
        const resolved = guard.resolvePath(plan.relativePath);
        if (plan.existedBefore && plan.targetPreSha256) {
          const blobBuf = this.readBlobVerified(workspaceId, plan.targetPreSha256);
          if (!blobBuf) {
            throw new Error(`Unexpected missing blob for ${plan.relativePath}`);
          }
          atomicWriteFileSync(resolved.absolutePath, blobBuf, plan.preMode);
          restoredPaths.push(plan.relativePath);
        } else if (!plan.existedBefore) {
          try {
            const st = fs.lstatSync(resolved.absolutePath);
            if (!st.isSymbolicLink() && st.isFile()) {
              fs.unlinkSync(resolved.absolutePath);
            }
          } catch {
            // Already deleted
          }
          // Prune ONLY newly-created empty parent directories down to `preExistingParentRelPath`
          // using canonical relative containment (safe on case-sensitive Linux, macOS NFD/NFC, and Windows roots!)
          const stopBoundaryAbs =
            plan.preExistingParentRelPath && plan.preExistingParentRelPath.length > 0
              ? path.resolve(guard.workspaceRoot, plan.preExistingParentRelPath)
              : guard.workspaceRoot;
          let parentDir = path.dirname(resolved.absolutePath);
          while (true) {
            const relFromStop = path.relative(stopBoundaryAbs, parentDir);
            if (
              !relFromStop ||
              relFromStop === '..' ||
              relFromStop.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relFromStop)
            ) {
              break;
            }
            try {
              const entries = fs.readdirSync(parentDir);
              if (entries.length > 0) break;
              fs.rmdirSync(parentDir);
              const nextParent = path.dirname(parentDir);
              if (nextParent === parentDir) break;
              parentDir = nextParent;
            } catch {
              break;
            }
          }
          deletedCreatedPaths.push(plan.relativePath);
        }
      }

      // Also update `postSha256` on newer checkpoints for restored files so subsequent previews know current state
      for (const cp of index.checkpoints) {
        if (cp.id === backupCpId) continue;
        for (const f of cp.files) {
          const restoredPlan = actionable.find((a) => a.relativePath === f.relativePath);
          if (restoredPlan) {
            f.postExisted = restoredPlan.existedBefore;
            f.postSha256 = restoredPlan.targetPreSha256;
          }
        }
      }

      this.enforceQuotaSync(index);
      this.writeIndex(index);

      const skippedPaths = preview.files
        .filter((f) => f.disposition === 'SKIPPED_UNTRACKED' || f.disposition === 'NOOP_ALREADY_MATCHES')
        .map((f) => f.relativePath);

      appendAuditLogSync(this.auditLogPath, {
        event: 'rollback_completed',
        actor: 'app',
        workspaceId,
        detail: {
          checkpointId,
          backupCheckpointId: backupCpId,
          restoredPaths,
          deletedCreatedPaths,
          overwroteConflicts: conflicts.length > 0,
        },
      });

      return {
        status: 'RESTORED',
        checkpointId,
        backupCheckpointId: backupCpId,
        restoredPaths,
        deletedCreatedPaths,
        skippedPaths,
        conflicts,
        preview,
        message: `Restored ${restoredPaths.length} file(s) and cleaned ${deletedCreatedPaths.length} Agent-created file(s). Pre-rollback safety backup saved as ${backupCpId}.`,
      };
    });
  }
}
