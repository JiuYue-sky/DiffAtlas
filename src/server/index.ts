import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpPluginShell } from '../kit/mcp-shell.js';
import { PathGuard, fromFileUri, toPosixPath } from '../kit/path-guard.js';
import { withTimeoutCircuitBreaker } from '../kit/process-guard.js';
import { getSingleFileUnifiedDiff, inspectWorkspaceFiles } from '../core/git-workspace.js';
import { ImpactAnalyzer, formatImpactReportMarkdown } from '../core/impact-analyzer.js';
import { SnapshotEngine } from '../core/snapshot-engine.js';
import { DIFFATLAS_IDENTITY } from '../shared/identity.js';

function detectWorkspaceFromPluginRoot(pluginRoot: string): string | null {
  // Matches `<workspace>/.agents/plugins/<dir>` (or `.agent`, `_agents`, `_agent`)
  const posix = toPosixPath(pluginRoot);
  const match = /^(.+)\/(?:\.agents?|_agents?)\/plugins\/[^/]+\/?$/.exec(posix);
  if (!match?.[1]) return null;
  const candidate = path.resolve(match[1]);
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory() ? candidate : null;
}

function isSameDirectory(a: string, b: string): boolean {
  const na = toPosixPath(path.resolve(a));
  const nb = toPosixPath(path.resolve(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

interface ComputedWorkspaceBundle {
  workspaceFull: Awaited<ReturnType<typeof inspectWorkspaceFiles>>;
  impact: Awaited<ReturnType<ImpactAnalyzer['analyzeImpact']>>;
  checkpointsFull: ReturnType<SnapshotEngine['listCheckpoints']>;
  scanMs: number;
  impactMs: number;
  checkpointsMs: number;
  computedAtMs: number;
}

export function createDiffAtlasServer(options?: {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  fallbackRoot?: string;
}): {
  shell: McpPluginShell;
  snapshotEngine: SnapshotEngine;
  impactAnalyzer: ImpactAnalyzer;
  prewarm: () => Promise<void>;
} {
  const shell = new McpPluginShell(DIFFATLAS_IDENTITY, options);
  const snapshotEngine = new SnapshotEngine(shell.paths.dataDir, shell.paths.auditLogPath);
  const impactAnalyzer = new ImpactAnalyzer();

  let cachedHostRoot: { value: string | null; expiresAt: number } | null = null;
  const inFlightScans = new Map<string, Promise<ComputedWorkspaceBundle>>();
  const warmScanCache = new Map<string, ComputedWorkspaceBundle>();
  const WARM_CACHE_TTL_MS = 2_500;

  const queryHostWorkspaceRoot = async (): Promise<string | null> => {
    if (cachedHostRoot && Date.now() < cachedHostRoot.expiresAt) {
      return cachedHostRoot.value;
    }
    try {
      const clientCaps = shell.server.server.getClientCapabilities();
      // Do NOT cache `null` before MCP `initialize` has negotiated client capabilities!
      if (!clientCaps) return null;
      if (!clientCaps.roots) {
        cachedHostRoot = { value: null, expiresAt: Date.now() + 60_000 };
        return null;
      }
      const rootsRes = await withTimeoutCircuitBreaker('mcp_list_roots', 250, async () =>
        await shell.server.server.listRoots(),
      );
      for (const root of rootsRes.roots ?? []) {
        const fsPath = fromFileUri(root.uri);
        if (fsPath && fs.existsSync(fsPath) && fs.statSync(fsPath).isDirectory()) {
          cachedHostRoot = { value: fsPath, expiresAt: Date.now() + 60_000 };
          return fsPath;
        }
      }
    } catch {
      // Host does not support roots/list or timed out — fall through cleanly
    }
    cachedHostRoot = { value: null, expiresAt: Date.now() + 60_000 };
    return null;
  };

  const resolveActiveWorkspace = async (explicitWorkspace?: string): Promise<string | null> => {
    const tryCommitCandidate = (candidate: string | null | undefined): string | null => {
      if (!candidate || candidate.trim().length === 0) return null;
      try {
        const guard = new PathGuard(candidate.trim());
        shell.stateStore.recordRecentTarget(guard.workspaceRoot, 'workspace');
        return guard.workspaceRoot;
      } catch {
        return null;
      }
    };

    // 1. Explicit workspacePath argument
    const fromExplicit = tryCommitCandidate(explicitWorkspace);
    if (fromExplicit) return fromExplicit;

    // 2. MCP Client `roots/list` (active workspace advertised by IDE/Agent host)
    const fromHostRoots = tryCommitCandidate(await queryHostWorkspaceRoot());
    if (fromHostRoots) return fromHostRoots;

    // 3. Parent workspace when running from `<workspace>/.agents/plugins/<dir>`
    const fromWorkspacePluginParent = tryCommitCandidate(detectWorkspaceFromPluginRoot(shell.paths.pluginRoot));
    if (fromWorkspacePluginParent) return fromWorkspacePluginParent;

    // 4. Process CWD when invoked from CLI / Cleanroom (specifically NOT the plugin's own install dir!)
    const cwd = process.cwd();
    if (!isSameDirectory(cwd, shell.paths.pluginRoot)) {
      const fromCwd = tryCommitCandidate(cwd);
      if (fromCwd) return fromCwd;
    }

    // 5. Most recent workspace persisted in `${PLUGIN_DATA}/state/recent-targets.json`
    const recent = shell.stateStore.getRecentTargets().find((r) => r.kind === 'workspace' && fs.existsSync(r.path));
    return recent ? tryCommitCandidate(recent.path) : null;
  };

  shell.setDefaultWorkspaceResolver(() => resolveActiveWorkspace());

  const getOrComputeWorkspaceBundle = async (
    activeWorkspace: string,
    targetFiles?: readonly string[],
    forceRefresh = false,
  ): Promise<{ bundle: ComputedWorkspaceBundle; cacheHit: boolean }> => {
    const cacheKey = `${activeWorkspace}::${(targetFiles ?? []).join(',')}`;
    if (!forceRefresh) {
      const cached = warmScanCache.get(cacheKey);
      if (cached && Date.now() - cached.computedAtMs <= WARM_CACHE_TTL_MS) {
        return { bundle: cached, cacheHit: true };
      }
      const existingInFlight = inFlightScans.get(cacheKey);
      if (existingInFlight) {
        return { bundle: await existingInFlight, cacheHit: true };
      }
    }

    const computePromise = (async (): Promise<ComputedWorkspaceBundle> => {
      const tScan0 = performance.now();
      const workspaceFull = await inspectWorkspaceFiles(activeWorkspace, 5_000);
      const scanMs = Math.round((performance.now() - tScan0) * 100) / 100;

      const tImp0 = performance.now();
      const impact = await impactAnalyzer.analyzeImpact(activeWorkspace, {
        targetFiles,
        precomputedWorkspace: workspaceFull,
      });
      const impactMs = Math.round((performance.now() - tImp0) * 100) / 100;

      const tCp0 = performance.now();
      const checkpointsFull = snapshotEngine.listCheckpoints(activeWorkspace);
      const checkpointsMs = Math.round((performance.now() - tCp0) * 100) / 100;

      const result: ComputedWorkspaceBundle = {
        workspaceFull,
        impact,
        checkpointsFull,
        scanMs,
        impactMs,
        checkpointsMs,
        computedAtMs: Date.now(),
      };
      warmScanCache.set(cacheKey, result);
      return result;
    })();

    inFlightScans.set(cacheKey, computePromise);
    try {
      const bundle = await computePromise;
      return { bundle, cacheHit: false };
    } finally {
      if (inFlightScans.get(cacheKey) === computePromise) {
        inFlightScans.delete(cacheKey);
      }
    }
  };

  const buildWorkbenchPayload = async (
    explicitWorkspace?: string,
    targetFiles?: readonly string[],
    forTrajectoryLean = false,
    forceRefresh = false,
  ) => {
    const tTotal0 = performance.now();
    const activeWorkspace = await resolveActiveWorkspace(explicitWorkspace);
    const resolveWsMs = Math.round((performance.now() - tTotal0) * 100) / 100;
    const recentWorkspaces = shell.stateStore.getRecentTargets();
    const preferences = shell.stateStore.getPreferences();

    if (!activeWorkspace) {
      return {
        summaryMarkdown:
          '### DiffAtlas Workbench\n\nNo active workspace selected yet. Pass `workspacePath` or select a recent workspace in the global view.',
        structuredContent: {
          serverVersion: DIFFATLAS_IDENTITY.version,
          workspace: null,
          impact: null,
          checkpoints: [],
          recentWorkspaces,
          preferences,
          workspaceTruncated: false,
          serverTiming: {
            resolveWsMs,
            scanMs: 0,
            impactMs: 0,
            checkpointsMs: 0,
            totalMs: Math.round((performance.now() - tTotal0) * 100) / 100,
            cacheHit: false,
          },
          generatedAt: new Date().toISOString(),
        },
      };
    }

    const { bundle, cacheHit } = await getOrComputeWorkspaceBundle(activeWorkspace, targetFiles, forceRefresh);
    const { workspaceFull, impact, checkpointsFull } = bundle;

    // Keep up to 600 files & 50 checkpoints (our full LRU cap!) in trajectory payload (~120 KiB << 768 KiB cap)
    // so normal workspaces NEVER trigger a redundant second `app_get_workbench_state` round-trip on open!
    const maxTrajFiles = 600;
    const maxTrajCps = 50;
    const workspaceTruncated = forTrajectoryLean && workspaceFull.files.length > maxTrajFiles;
    const checkpointsTruncated = forTrajectoryLean && checkpointsFull.length > maxTrajCps;
    const workspace = workspaceTruncated
      ? { ...workspaceFull, files: workspaceFull.files.slice(0, maxTrajFiles) }
      : workspaceFull;
    const checkpoints = checkpointsTruncated ? checkpointsFull.slice(0, maxTrajCps) : checkpointsFull;

    const summaryMarkdown = [
      formatImpactReportMarkdown(impact),
      `\n- **Time Machine Checkpoints**: ${checkpointsFull.length} recorded in \`PLUGIN_DATA\``,
    ].join('\n');

    return {
      summaryMarkdown,
      structuredContent: {
        serverVersion: DIFFATLAS_IDENTITY.version,
        workspace,
        impact,
        checkpoints,
        recentWorkspaces: shell.stateStore.getRecentTargets(),
        preferences: shell.stateStore.getPreferences(),
        workspaceTruncated: workspaceTruncated || checkpointsTruncated,
        serverTiming: {
          resolveWsMs,
          scanMs: bundle.scanMs,
          impactMs: bundle.impactMs,
          checkpointsMs: bundle.checkpointsMs,
          totalMs: Math.round((performance.now() - tTotal0) * 100) / 100,
          cacheHit,
        },
        generatedAt: new Date().toISOString(),
      },
    };
  };

  // 1. Primary UI Entrypoint (`aux_pane` + `global` + inline) — supports `{}` empty input!
  shell.registerUiTool({
    name: 'open_workbench',
    title: 'DiffAtlas Workbench',
    description:
      'Open the DiffAtlas visual change review, file tree, deterministic dependency impact graph, native fileView launcher, context pill selector, and Time Machine rollback workbench.',
    inputSchema: z.object({
      workspacePath: z.string().optional().describe('Optional workspace root path; defaults to active workspace.'),
      targetFiles: z
        .array(z.string())
        .optional()
        .describe('Optional relative/absolute file paths to simulate blast radius even on a clean working tree.'),
    }),
    entrypoints: [
      { type: 'aux_pane', title: 'DiffAtlas' },
      { type: 'global', title: 'DiffAtlas' },
    ],
    handler: async (args) => await buildWorkbenchPayload(args.workspacePath, args.targetFiles, true),
  });

  // 2. Dual-Surface Deterministic Impact Analyzer (GUI + Headless CLI Markdown fallback)
  shell.registerUiTool({
    name: 'analyze_diff_impact',
    title: 'Analyze Diff Impact & Blast Radius',
    description:
      'Analyze deterministic file-level dependency blast radius (1-2 hops) across TS/JS, Vue/Svelte/Astro, Python, Go, Rust, C/C++, Java/Kotlin, and C#, citing exact file:line import evidence, low-confidence dynamic imports, and recommended tests.',
    inputSchema: z.object({
      workspacePath: z.string().optional().describe('Optional workspace root directory; defaults to active workspace.'),
      targetFiles: z
        .array(z.string())
        .optional()
        .describe('Optional explicit file paths to analyze instead of git status changed files.'),
    }),
    handler: async (args) => {
      const ws = await resolveActiveWorkspace(args.workspacePath);
      if (!ws) {
        return {
          isError: true,
          summaryMarkdown: 'Error: No active workspace could be resolved. Pass `workspacePath`.',
          structuredContent: { error: 'No active workspace resolved.' },
        };
      }
      const impact = await impactAnalyzer.analyzeImpact(ws, { targetFiles: args.targetFiles });
      return {
        summaryMarkdown: formatImpactReportMarkdown(impact),
        structuredContent: {
          serverVersion: DIFFATLAS_IDENTITY.version,
          impact,
          generatedAt: new Date().toISOString(),
        },
      };
    },
  });

  // 3. CLI & Model-visible checkpoint listing tool
  shell.registerUiTool({
    name: 'list_checkpoints',
    title: 'List Time Machine Checkpoints',
    description:
      'List local PreToolUse file snapshots available for human-confirmed rollback in the DiffAtlas workbench.',
    inputSchema: z.object({
      workspacePath: z.string().optional(),
    }),
    handler: async (args) => {
      const ws = await resolveActiveWorkspace(args.workspacePath);
      if (!ws) {
        return {
          summaryMarkdown: 'No active workspace found.',
          structuredContent: { checkpoints: [] },
        };
      }
      const checkpoints = snapshotEngine.listCheckpoints(ws);
      const lines =
        checkpoints.length === 0
          ? ['_No checkpoints recorded for this workspace yet._']
          : checkpoints.slice(0, 20).map(
              (cp) =>
                `- **\`${cp.id}\`** (${cp.kind === 'pre_rollback_backup' ? 'Safety Backup' : 'Agent Turn'}) — ${cp.label} · ${cp.files.length} file(s) · \`${cp.createdAt}\``,
            );
      return {
        summaryMarkdown: `### DiffAtlas Checkpoints (${checkpoints.length})\n\n${lines.join('\n')}\n\n> Rollback is human-exclusive via the DiffAtlas side-pane UI.`,
        structuredContent: {
          workspaceRoot: ws,
          checkpoints,
        },
      };
    },
  });

  // 4. App-Only (`visibility: ["app"]`) refresh & workspace switch
  shell.registerAppOnlyTool({
    name: 'app_get_workbench_state',
    title: 'Refresh Workbench State',
    description: 'App-only live state refresh for workspace files, git status, impact graph, and checkpoints.',
    inputSchema: z.object({
      workspacePath: z.string().optional(),
      targetFiles: z.array(z.string()).optional(),
      forceRefresh: z.boolean().optional(),
    }),
    handler: async (args) => {
      const payload = await buildWorkbenchPayload(args.workspacePath, args.targetFiles, false, Boolean(args.forceRefresh));
      return payload.structuredContent;
    },
  });

  // 5. App-Only (`visibility: ["app"]`) interactive what-if impact analysis on selected files
  shell.registerAppOnlyTool({
    name: 'app_analyze_impact',
    title: 'Analyze Impact Graph (App Only)',
    description: 'App-only deterministic impact calculation for arbitrary selected files or active git diff.',
    inputSchema: z.object({
      workspacePath: z.string(),
      targetFiles: z.array(z.string()).optional(),
    }),
    handler: async (args) => {
      const impact = await impactAnalyzer.analyzeImpact(args.workspacePath, { targetFiles: args.targetFiles });
      return { impact, generatedAt: new Date().toISOString() };
    },
  });

  // 6. App-Only (`visibility: ["app"]`) unified diff preview
  shell.registerAppOnlyTool({
    name: 'app_get_file_diff',
    title: 'Get Single File Unified Diff',
    description: 'App-only unified git diff or read-only source preview guarded by PathGuard.',
    inputSchema: z.object({
      workspacePath: z.string(),
      relativePath: z.string(),
    }),
    handler: async (args) => await getSingleFileUnifiedDiff(args.workspacePath, args.relativePath),
  });

  // 7. App-Only (`visibility: ["app"]`) 3-way rollback conflict preview
  shell.registerAppOnlyTool({
    name: 'app_preview_rollback',
    title: 'Preview Checkpoint Rollback Plan',
    description: 'App-only 3-way conflict check before human rollback confirmation.',
    inputSchema: z.object({
      workspacePath: z.string(),
      checkpointId: z.string(),
      onlyPaths: z.array(z.string()).optional(),
    }),
    handler: (args) => {
      const preview = snapshotEngine.previewRollback(args.workspacePath, args.checkpointId, args.onlyPaths);
      if (!preview) {
        throw new Error(`Checkpoint "${args.checkpointId}" not found.`);
      }
      return preview;
    },
  });

  // 8. App-Only (`visibility: ["app"]`) Human-Exclusive Checkpoint Restore (with Undo-of-Undo backup!)
  shell.registerAppOnlyTool({
    name: 'app_restore_checkpoint',
    title: 'Restore Checkpoint (Human UI Only)',
    description:
      'Strictly App-only checkpoint restore with 3-way human-edit conflict gate and automatic Undo-of-Undo backup.',
    inputSchema: z.object({
      workspacePath: z.string(),
      checkpointId: z.string(),
      onlyPaths: z.array(z.string()).optional(),
      allowOverwriteConflicts: z.boolean().optional(),
      humanConfirmed: z.literal(true),
    }),
    handler: (args) => {
      const result = snapshotEngine.restoreCheckpoint(args.workspacePath, args.checkpointId, {
        onlyPaths: args.onlyPaths,
        allowOverwriteConflicts: args.allowOverwriteConflicts,
      });
      if (result.status === 'RESTORED') {
        warmScanCache.clear();
      }
      return result;
    },
  });

  /**
   * 100% passive local warm-up: pre-reads UI HTML + default workspace scan into RAM
   * WITHOUT emitting any unsolicited server-to-client JSON-RPC requests (`roots/list`)
   * and WITHOUT competing with Antigravity's initial `initialize` / `tools/list` registration!
   */
  const prewarm = async (): Promise<void> => {
    try {
      shell.prewarmUiHtml();
      const passiveCandidate =
        detectWorkspaceFromPluginRoot(shell.paths.pluginRoot) ??
        shell.stateStore.getRecentTargets().find((r) => r.kind === 'workspace' && fs.existsSync(r.path))?.path ??
        null;
      if (passiveCandidate) {
        const guard = new PathGuard(passiveCandidate);
        await getOrComputeWorkspaceBundle(guard.workspaceRoot, undefined, false);
      }
    } catch {
      // Best-effort background warm-up; never throw
    }
  };

  return { shell, snapshotEngine, impactAnalyzer, prewarm };
}

// Entrypoint execution when invoked directly via `node dist/server/index.mjs` (handles symlinks & Windows casing)
function checkIsDirectEntry(): boolean {
  if (typeof process === 'undefined' || !Array.isArray(process.argv) || !process.argv[1]) {
    return false;
  }
  const argPath = process.argv[1];
  try {
    const resolvedUrl = pathToFileURL(fs.realpathSync.native(argPath)).href;
    if (resolvedUrl === import.meta.url) return true;
  } catch {
    // Fallback below if path does not exist or virtual
  }
  const lower = argPath.toLowerCase();
  return lower.endsWith('index.mjs') || lower.endsWith('index.ts');
}

if (checkIsDirectEntry()) {
  const { shell, prewarm } = createDiffAtlasServer();
  shell
    .startStdio()
    .then(() => {
      // Wait 500ms so Antigravity finishes `initialize` + `tools/list` with zero contention, then passively prewarm RAM cache
      setTimeout(() => {
        void prewarm();
      }, 500).unref();
    })
    .catch((err) => {
      process.stderr.write(`[DiffAtlas MCP Fatal] ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
