import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PersistedUiPreferences,
  PluginIdentity,
  PluginRuntimePaths,
  RecentTargetRecord,
} from './types.js';
import { redactSecretsAndPaths, stripWindowsLongPathPrefix, toPosixPath } from './path-guard.js';

function isUnexpandedTemplateVar(val: string | undefined): boolean {
  if (!val) return true;
  const trimmed = val.trim();
  return trimmed.length === 0 || trimmed.includes('${PLUGIN_');
}

/**
 * Resolves `PLUGIN_ROOT` and `PLUGIN_DATA` consistently across:
 * 1. Global / Marketplace installed plugins (`PLUGIN_ROOT` + `PLUGIN_DATA` injected by Antigravity)
 * 2. Workspace-scoped `.agents/plugins/<id>/` plugins (where `PLUGIN_DATA` may be unset in hooks)
 * 3. CLI / Cleanroom test runs (`--plugin-root=...`, `--data-dir=...`)
 */
export function resolvePluginRuntimePaths(
  identity: PluginIdentity,
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  fallbackRoot: string = process.cwd(),
): PluginRuntimePaths {
  let cliPluginRoot: string | undefined;
  let cliDataDir: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith('--plugin-root=')) {
      cliPluginRoot = arg.slice('--plugin-root='.length);
    } else if (arg.startsWith('--data-dir=')) {
      cliDataDir = arg.slice('--data-dir='.length);
    }
  }

  const rawPluginRoot = !isUnexpandedTemplateVar(cliPluginRoot)
    ? cliPluginRoot!
    : !isUnexpandedTemplateVar(env.PLUGIN_ROOT)
      ? env.PLUGIN_ROOT!
      : fallbackRoot;

  const pluginRoot = stripWindowsLongPathPrefix(path.resolve(rawPluginRoot));

  const rawDataDir = !isUnexpandedTemplateVar(cliDataDir)
    ? cliDataDir!
    : !isUnexpandedTemplateVar(env.PLUGIN_DATA)
      ? env.PLUGIN_DATA!
      : path.join(os.homedir(), '.gemini', 'antigravity-plugin-data', identity.id);

  const dataDir = stripWindowsLongPathPrefix(path.resolve(rawDataDir));
  const stateDir = path.join(dataDir, 'state');
  const auditLogPath = path.join(dataDir, 'audit.jsonl');

  const envHtmlOverride = env[identity.appHtmlEnvVar];
  const defaultAppHtmlPath =
    envHtmlOverride && envHtmlOverride.trim().length > 0
      ? stripWindowsLongPathPrefix(path.resolve(envHtmlOverride.trim()))
      : path.join(pluginRoot, 'dist', 'ui', 'app.html');

  fs.mkdirSync(stateDir, { recursive: true });

  return {
    pluginRoot,
    dataDir,
    stateDir,
    auditLogPath,
    defaultAppHtmlPath,
  };
}

/**
 * Crash-safe atomic file write via unique sibling temp file + rename.
 * Handles transient Windows NTFS EPERM/EACCES rename contention with brief synchronous backoff
 * and preserves POSIX file mode bits (e.g. executable `+x`) on macOS/Linux when specified.
 */
export function atomicWriteFileSync(targetPath: string, content: string | Buffer, mode?: number): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmpPath, content, mode !== undefined && process.platform !== 'win32' ? { mode } : undefined);
  if (mode !== undefined && process.platform !== 'win32') {
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      // Best-effort permission restoration
    }
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      // Fallback on Windows if target is briefly held by antivirus indexer
      if (attempt === 4) {
        try {
          fs.copyFileSync(tmpPath, targetPath);
          if (mode !== undefined && process.platform !== 'win32') {
            try {
              fs.chmodSync(targetPath, mode);
            } catch {
              // Ignore
            }
          }
          fs.unlinkSync(tmpPath);
          return;
        } catch {
          // Clean up below
        }
      } else {
        try {
          const sab = new SharedArrayBuffer(4);
          Atomics.wait(new Int32Array(sab), 0, 0, 8 * (attempt + 1));
        } catch {
          // Ignore if SharedArrayBuffer is unavailable
        }
      }
    }
  }
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // Ignore cleanup errors
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface AuditEventRecord {
  timestamp: string;
  event: string;
  actor: 'hook' | 'app' | 'model' | 'system';
  workspaceId?: string;
  detail: Record<string, unknown>;
}

/** 5 MiB cap per audit log file (rotates to `audit.jsonl.1` so `${PLUGIN_DATA}` never bloats disk) */
export const MAX_AUDIT_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Appends a redacted, tamper-evident audit entry to `${PLUGIN_DATA}/audit.jsonl` with automatic 5 MiB rotation.
 */
export function appendAuditLogSync(
  auditLogPath: string,
  entry: Omit<AuditEventRecord, 'timestamp'>,
  maxBytes: number = MAX_AUDIT_LOG_BYTES,
): void {
  try {
    fs.mkdirSync(path.dirname(auditLogPath), { recursive: true });
    try {
      if (fs.existsSync(auditLogPath) && fs.statSync(auditLogPath).size >= maxBytes) {
        const rotatedPath = `${auditLogPath}.1`;
        try {
          if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
        } catch {
          // Ignore old backup unlink failure
        }
        fs.renameSync(auditLogPath, rotatedPath);
      }
    } catch {
      // Ignore rotation contention
    }
    const fullRecord: AuditEventRecord = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    const serialized = redactSecretsAndPaths(JSON.stringify(fullRecord));
    fs.appendFileSync(auditLogPath, `${serialized}\n`, 'utf8');
  } catch {
    // Audit logging must never crash host execution
  }
}

/**
 * Stable 16-hex workspace identifier derived from canonical workspace path.
 */
export function computeWorkspaceId(canonicalWorkspaceRoot: string): string {
  const normalized =
    process.platform === 'win32'
      ? toPosixPath(canonicalWorkspaceRoot).toLowerCase()
      : toPosixPath(canonicalWorkspaceRoot);
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Server-persisted state store replacing browser `localStorage` (which is unavailable/discarded in MCP App iframes).
 */
export class PluginStateStore {
  private readonly recentFilePath: string;
  private readonly preferencesFilePath: string;

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.recentFilePath = path.join(stateDir, 'recent-targets.json');
    this.preferencesFilePath = path.join(stateDir, 'preferences.json');
  }

  public recordRecentTarget(targetPath: string, kind: 'workspace' | 'asset', maxItems = 12): RecentTargetRecord[] {
    const clean = stripWindowsLongPathPrefix(path.resolve(targetPath));
    const posix = toPosixPath(clean);
    const current = this.getRecentTargets();
    // Never record internal `.agents/plugins/<id>` staging directories as user workspaces
    if (kind === 'workspace' && /(?:^|\/)(?:\.agents?|_agents?)\/plugins(?:\/|$)/i.test(posix)) {
      return current;
    }
    const label = path.basename(clean) || posix;
    const normKey = process.platform === 'win32' ? posix.toLowerCase() : posix;

    // Hot-path optimization for <50ms PreToolUse hooks: skip redundant disk rewrite if already #1 within 60s
    const top = current[0];
    if (top && top.kind === kind) {
      const topKey = process.platform === 'win32' ? toPosixPath(top.path).toLowerCase() : toPosixPath(top.path);
      const ageMs = Date.now() - Date.parse(top.lastOpenedAt);
      if (topKey === normKey && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 60_000) {
        return current;
      }
    }

    const filtered = current.filter((item) => {
      const itemKey = process.platform === 'win32' ? toPosixPath(item.path).toLowerCase() : toPosixPath(item.path);
      return itemKey !== normKey;
    });
    const updated: RecentTargetRecord[] = [
      {
        path: posix,
        label,
        kind,
        lastOpenedAt: new Date().toISOString(),
      },
      ...filtered,
    ].slice(0, maxItems);
    atomicWriteFileSync(this.recentFilePath, JSON.stringify(updated, null, 2));
    return updated;
  }

  public getRecentTargets(): RecentTargetRecord[] {
    try {
      if (!fs.existsSync(this.recentFilePath)) return [];
      const raw = JSON.parse(fs.readFileSync(this.recentFilePath, 'utf8'));
      return Array.isArray(raw) ? (raw as RecentTargetRecord[]) : [];
    } catch {
      return [];
    }
  }

  public getPreferences(): PersistedUiPreferences {
    try {
      if (!fs.existsSync(this.preferencesFilePath)) {
        return { themeOverride: 'system', compactMode: false, updatedAt: new Date().toISOString() };
      }
      return JSON.parse(fs.readFileSync(this.preferencesFilePath, 'utf8')) as PersistedUiPreferences;
    } catch {
      return { themeOverride: 'system', compactMode: false, updatedAt: new Date().toISOString() };
    }
  }

  public savePreferences(patch: Partial<Omit<PersistedUiPreferences, 'updatedAt'>>): PersistedUiPreferences {
    const merged: PersistedUiPreferences = {
      ...this.getPreferences(),
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    atomicWriteFileSync(this.preferencesFilePath, JSON.stringify(merged, null, 2));
    return merged;
  }
}
