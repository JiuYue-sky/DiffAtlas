import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openNativeFileView } from '../kit/ui-shell/host-bridge.js';
import { usePluginShell } from '../kit/ui-shell/usePluginShell.js';
import type { PersistedUiPreferences, PluginUiLocale, RecentTargetRecord } from '../kit/types.js';
import type { WorkspaceFileNode, WorkspaceSnapshotSummary } from '../core/git-workspace.js';
import type { DiffImpactReport, ImpactGraphNode, ImpactTier } from '../core/impact-analyzer.js';
import type { CheckpointRecord, RollbackExecutionResult, RollbackPreviewResult } from '../core/snapshot-engine.js';
import { DIFFATLAS_IDENTITY } from '../shared/identity.js';
import { FileTreeView } from './components/FileTreeView.js';
import { ImpactGraphSvg } from './components/ImpactGraphSvg.js';
import { getUiStrings } from './i18n.js';

interface ServerTimingMetrics {
  resolveWsMs: number;
  scanMs: number;
  impactMs: number;
  checkpointsMs: number;
  totalMs: number;
  cacheHit: boolean;
}

interface WorkbenchStructuredData extends Record<string, unknown> {
  serverVersion?: string;
  workspace?: WorkspaceSnapshotSummary | null;
  impact?: DiffImpactReport | null;
  checkpoints?: CheckpointRecord[];
  recentWorkspaces?: RecentTargetRecord[];
  preferences?: PersistedUiPreferences;
  workspaceTruncated?: boolean;
  _truncatedForTrajectory?: boolean;
  serverTiming?: ServerTimingMetrics;
  generatedAt?: string;
}

type WorkbenchTab = 'impact' | 'files' | 'timemachine' | 'diagnostics';

const VALID_TABS: readonly WorkbenchTab[] = ['impact', 'files', 'timemachine', 'diagnostics'];
const DEFAULT_PREVIEW_RATIO = 42;
const MIN_PREVIEW_RATIO = 20;
const MAX_PREVIEW_RATIO = 80;

function clampPreviewRatio(val: number): number {
  if (!Number.isFinite(val)) return DEFAULT_PREVIEW_RATIO;
  return Math.max(MIN_PREVIEW_RATIO, Math.min(MAX_PREVIEW_RATIO, Math.round(val)));
}

function isWorkbenchTab(val: string | undefined): val is WorkbenchTab {
  return Boolean(val && (VALID_TABS as readonly string[]).includes(val));
}

function formatClockTime(isoOrDate?: string | Date): string {
  const d = isoOrDate ? new Date(isoOrDate) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function App(): React.ReactElement {
  const [workbench, setWorkbench] = useState<WorkbenchStructuredData | null>(null);
  const [locale, setLocale] = useState<PluginUiLocale>('en');
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('impact');
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [onlyChanged, setOnlyChanged] = useState<boolean>(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [hasAttachedContext, setHasAttachedContext] = useState<boolean>(false);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [simulatedTarget, setSimulatedTarget] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [lastSyncedClock, setLastSyncedClock] = useState<{ kind: 'sync' | 'sim'; clock: string } | null>(null);
  const [inlinePreview, setInlinePreview] = useState<{ path: string; content: string } | null>(null);
  const [previewRatio, setPreviewRatio] = useState<number>(DEFAULT_PREVIEW_RATIO);
  const [isResizingPreview, setIsResizingPreview] = useState<boolean>(false);
  const splitBodyRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startY: number; startRatio: number; containerHeight: number; latestRatio: number } | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreviewResult | null>(null);
  const [allowConflictOverride, setAllowConflictOverride] = useState<boolean>(false);
  const [busyAction, setBusyAction] = useState<boolean>(false);
  const lastHydratedStampRef = useRef<string | null>(null);
  const restoredPrefsRef = useRef<boolean>(false);
  const refreshSeqRef = useRef<number>(0);
  const lastWorkspaceRootRef = useRef<string | null>(null);
  const workspaceCacheRef = useRef<Map<string, WorkbenchStructuredData>>(new Map());
  const mountTimeRef = useRef<number>(performance.now());
  const [uiConnectMs, setUiConnectMs] = useState<number | null>(null);
  const [firstDataMs, setFirstDataMs] = useState<number | null>(null);

  const t = useMemo(() => getUiStrings(locale), [locale]);

  const resetTransientSelectionIfWorkspaceChanged = useCallback((nextWsRoot: string | null | undefined) => {
    if (!nextWsRoot) return;
    if (lastWorkspaceRootRef.current && lastWorkspaceRootRef.current !== nextWsRoot) {
      setSelectedPaths(new Set());
      setSelectedGraphNodeId(null);
      setSimulatedTarget(null);
      setInlinePreview(null);
      setRollbackPreview(null);
    }
    lastWorkspaceRootRef.current = nextWsRoot;
  }, []);

  const cacheWorkspacePayload = useCallback((payload: WorkbenchStructuredData) => {
    const wsKey = payload.workspace?.workspaceRoot ?? payload.impact?.workspaceRoot;
    if (wsKey) {
      workspaceCacheRef.current.set(wsKey, payload);
    }
  }, []);

  const shell = usePluginShell<WorkbenchStructuredData>({
    appName: DIFFATLAS_IDENTITY.displayName,
    appVersion: DIFFATLAS_IDENTITY.version,
    onStructuredResult: (data) => {
      if (data && ('workspace' in data || 'impact' in data || 'checkpoints' in data || '_truncatedForTrajectory' in data)) {
        const incomingRoot = data.workspace?.workspaceRoot ?? data.impact?.workspaceRoot;
        resetTransientSelectionIfWorkspaceChanged(incomingRoot);
        setWorkbench((prev) => {
          const merged: WorkbenchStructuredData = {
            workspace: data.workspace !== undefined ? data.workspace : prev?.workspace ?? null,
            impact: data.impact !== undefined ? data.impact : prev?.impact ?? null,
            checkpoints: data.checkpoints ?? prev?.checkpoints ?? [],
            recentWorkspaces: data.recentWorkspaces ?? prev?.recentWorkspaces ?? [],
            preferences: data.preferences ?? prev?.preferences,
            workspaceTruncated: Boolean(data.workspaceTruncated),
            _truncatedForTrajectory: Boolean(data._truncatedForTrajectory),
            serverTiming: data.serverTiming ?? prev?.serverTiming,
            generatedAt: data.generatedAt ?? new Date().toISOString(),
          };
          cacheWorkspacePayload(merged);
          return merged;
        });
        setFirstDataMs((prev) => prev ?? Math.round(performance.now() - mountTimeRef.current));
        setLastSyncedClock({ kind: 'sync', clock: formatClockTime(data.generatedAt) });
      }
    },
  });

  // Restore saved preferences once via effect (clean lifecycle without referencing `shell` inside its own init)
  useEffect(() => {
    const prefs = workbench?.preferences;
    if (!prefs || restoredPrefsRef.current) return;
    restoredPrefsRef.current = true;
    if (prefs.themeOverride) {
      shell.setThemeOverride(prefs.themeOverride);
    }
    if (prefs.locale === 'zh-CN' || prefs.locale === 'en') {
      setLocale(prefs.locale);
    }
    if (isWorkbenchTab(prefs.activeTab)) {
      setActiveTab(prefs.activeTab);
    }
    if (typeof prefs.previewRatio === 'number') {
      setPreviewRatio(clampPreviewRatio(prefs.previewRatio));
    }
  }, [workbench?.preferences, shell.setThemeOverride]);

  useEffect(() => {
    if (shell.isConnected && uiConnectMs === null) {
      setUiConnectMs(Math.round(performance.now() - mountTimeRef.current));
    }
  }, [shell.isConnected, uiConnectMs]);

  const refreshState = useCallback(
    async (explicitWorkspace?: string, targetFiles?: string[], forceRefresh = false) => {
      if (!shell.client) return;
      const reqSeq = ++refreshSeqRef.current;
      // Instant optimistic render from in-memory cache when switching recent workspaces!
      if (explicitWorkspace && (!targetFiles || targetFiles.length === 0)) {
        const cached = workspaceCacheRef.current.get(explicitWorkspace);
        if (cached) {
          resetTransientSelectionIfWorkspaceChanged(explicitWorkspace);
          setWorkbench(cached);
        }
      }
      setBusyAction(true);
      const res = await shell.client.callTool<WorkbenchStructuredData>('app_get_workbench_state', {
        ...(explicitWorkspace ? { workspacePath: explicitWorkspace } : {}),
        ...(targetFiles && targetFiles.length > 0 ? { targetFiles } : {}),
        ...(forceRefresh ? { forceRefresh: true } : {}),
      });
      // Discard out-of-order stale response if user switched workspace again while in flight
      if (reqSeq !== refreshSeqRef.current) return;
      setBusyAction(false);
      if (res.ok && res.data) {
        const nextRoot = res.data.workspace?.workspaceRoot ?? res.data.impact?.workspaceRoot;
        resetTransientSelectionIfWorkspaceChanged(nextRoot);
        cacheWorkspacePayload(res.data);
        setWorkbench(res.data);
        setFirstDataMs((prev) => prev ?? Math.round(performance.now() - mountTimeRef.current));
        setLastSyncedClock({ kind: 'sync', clock: formatClockTime(res.data.generatedAt) });
      } else if (res.error) {
        setStatusBanner(t.errRefreshFailed(res.error));
      }
    },
    [shell.client, cacheWorkspacePayload, resetTransientSelectionIfWorkspaceChanged, t],
  );

  // Fast auto-bootstrap ONLY when no host `open_workbench` call is already delivering `toolresult`
  useEffect(() => {
    if (!shell.isConnected || !shell.client) return;
    if (!workbench && !shell.isToolRunning) {
      const timer = setTimeout(() => {
        void refreshState(undefined, undefined, false);
      }, 120);
      return () => clearTimeout(timer);
    }
    if (workbench && (workbench._truncatedForTrajectory || workbench.workspaceTruncated)) {
      const stamp = workbench.generatedAt ?? 'initial';
      if (lastHydratedStampRef.current !== stamp) {
        lastHydratedStampRef.current = stamp;
        const wsRoot = workbench.workspace?.workspaceRoot ?? workbench.impact?.workspaceRoot;
        void refreshState(wsRoot, undefined, false);
      }
    }
    return undefined;
  }, [shell.isConnected, shell.client, shell.isToolRunning, workbench, refreshState]);

  const workspace = workbench?.workspace ?? null;
  const impact = workbench?.impact ?? null;
  const checkpoints = workbench?.checkpoints ?? [];
  const recentWorkspaces = workbench?.recentWorkspaces ?? [];
  const activeWorkspaceRoot = workspace?.workspaceRoot ?? impact?.workspaceRoot ?? null;
  const activeWorkspaceName = workspace?.workspaceName ?? impact?.workspaceName ?? t.loadingWorkspace;

  const lastSyncedLabel = lastSyncedClock
    ? lastSyncedClock.kind === 'sim'
      ? t.simulatedAt(lastSyncedClock.clock)
      : t.syncedAt(lastSyncedClock.clock)
    : null;

  const impactTierMap = useMemo(() => {
    const map = new Map<string, ImpactTier>();
    for (const node of impact?.nodes ?? []) {
      map.set(node.id, node.tier);
    }
    return map;
  }, [impact]);

  const filteredFiles = useMemo(() => {
    if (!workspace) return [];
    const q = filterQuery.trim().toLowerCase();
    return workspace.files.filter((f) => {
      if (onlyChanged && f.gitStatus === 'clean') return false;
      if (q && !f.relativePath.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [workspace, filterQuery, onlyChanged]);

  const selectedGraphNode = useMemo(() => {
    if (!impact || !selectedGraphNodeId) return null;
    return impact.nodes.find((n) => n.id === selectedGraphNodeId) ?? null;
  }, [impact, selectedGraphNodeId]);

  const selectedNodeEdges = useMemo(() => {
    if (!impact || !selectedGraphNodeId) return [];
    return impact.edges.filter((e) => e.from === selectedGraphNodeId || e.to === selectedGraphNodeId);
  }, [impact, selectedGraphNodeId]);

  const handleSelectTab = (tab: WorkbenchTab) => {
    setActiveTab(tab);
    if (shell.client) {
      void shell.client.callTool('app_save_preferences', { activeTab: tab });
    }
  };

  const persistPreviewRatio = useCallback(
    (ratio: number) => {
      if (shell.client) {
        void shell.client.callTool('app_save_preferences', { previewRatio: clampPreviewRatio(ratio) });
      }
    },
    [shell.client],
  );

  const handleSplitterPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = splitBodyRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.height <= 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Fallback safely if pointer capture is unsupported
    }
    dragStateRef.current = {
      startY: e.clientY,
      startRatio: previewRatio,
      containerHeight: rect.height,
      latestRatio: previewRatio,
    };
    setIsResizingPreview(true);
  };

  const handleSplitterPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const deltaY = drag.startY - e.clientY; // Dragging upward increases bottom preview ratio
    const deltaPct = (deltaY / drag.containerHeight) * 100;
    const next = clampPreviewRatio(drag.startRatio + deltaPct);
    drag.latestRatio = next;
    setPreviewRatio(next);
  };

  const finishSplitterDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    dragStateRef.current = null;
    setIsResizingPreview(false);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      // Ignore release errors
    }
    if (drag.latestRatio !== drag.startRatio) {
      persistPreviewRatio(drag.latestRatio);
    }
  };

  const handleSplitterKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = clampPreviewRatio(previewRatio + 5);
    else if (e.key === 'ArrowDown') next = clampPreviewRatio(previewRatio - 5);
    else if (e.key === 'Home') next = MAX_PREVIEW_RATIO;
    else if (e.key === 'End') next = MIN_PREVIEW_RATIO;
    if (next !== null) {
      e.preventDefault();
      setPreviewRatio(next);
      persistPreviewRatio(next);
    }
  };

  const handleResetPreviewRatio = () => {
    setPreviewRatio(DEFAULT_PREVIEW_RATIO);
    persistPreviewRatio(DEFAULT_PREVIEW_RATIO);
  };

  const handleToggleLocale = () => {
    const nextLocale: PluginUiLocale = locale === 'en' ? 'zh-CN' : 'en';
    setLocale(nextLocale);
    if (shell.client) {
      void shell.client.callTool('app_save_preferences', { locale: nextLocale });
    }
  };

  const toggleSelectPath = (relPath: string) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const openFileUriOrInline = async (relPath: string, fileUri: string) => {
    const res = await openNativeFileView(shell.rawApp, fileUri);
    if (res.openedNative) {
      setStatusBanner(t.bannerOpenedFileView(relPath));
      return;
    }
    setStatusBanner(res.detail ?? t.bannerInlineFallback(relPath));
    if (shell.client && activeWorkspaceRoot) {
      const diffRes = await shell.client.callTool<{ relativePath: string; diffText: string }>('app_get_file_diff', {
        workspacePath: activeWorkspaceRoot,
        relativePath: relPath,
      });
      if (diffRes.ok && diffRes.data?.diffText) {
        setInlinePreview({ path: relPath, content: diffRes.data.diffText });
        return;
      }
      const chunkRes = await shell.client.readFileChunked({
        workspaceRoot: activeWorkspaceRoot,
        targetPath: relPath,
        encoding: 'utf8',
        maxTotalBytes: 128 * 1024,
      });
      if (chunkRes.ok && chunkRes.text !== undefined) {
        setInlinePreview({ path: relPath, content: chunkRes.text });
      }
    }
  };

  const handlePreviewDiffInline = async (relPath: string) => {
    if (!shell.client || !activeWorkspaceRoot) return;
    setBusyAction(true);
    const diffRes = await shell.client.callTool<{ relativePath: string; diffText: string }>('app_get_file_diff', {
      workspacePath: activeWorkspaceRoot,
      relativePath: relPath,
    });
    setBusyAction(false);
    if (diffRes.ok && diffRes.data) {
      setInlinePreview({
        path: relPath,
        content: diffRes.data.diffText || t.noUnstagedDiff,
      });
    } else {
      setStatusBanner(t.errDiffFailed(diffRes.error));
    }
  };

  const handleSimulateImpact = async (relPath: string) => {
    if (!shell.client || !activeWorkspaceRoot) return;
    const reqSeq = ++refreshSeqRef.current;
    setBusyAction(true);
    setSimulatedTarget(relPath);
    const res = await shell.client.callTool<{ impact: DiffImpactReport; generatedAt: string }>('app_analyze_impact', {
      workspacePath: activeWorkspaceRoot,
      targetFiles: [relPath],
    });
    if (reqSeq !== refreshSeqRef.current) return;
    setBusyAction(false);
    if (res.ok && res.data?.impact) {
      setWorkbench((prev) => ({ ...(prev ?? {}), impact: res.data!.impact, generatedAt: res.data!.generatedAt }));
      setSelectedGraphNodeId(relPath);
      setActiveTab('impact');
      setLastSyncedClock({ kind: 'sim', clock: formatClockTime(res.data.generatedAt) });
      setStatusBanner(t.bannerSimulated(relPath));
    } else if (res.error) {
      setStatusBanner(t.errSimFailed(res.error));
    }
  };

  const handleAttachContextPaths = async (pathsToAttach: readonly string[]) => {
    if (!shell.rawApp || !shell.capabilities.canUpdateModelContext || !activeWorkspaceRoot) return;
    try {
      if (pathsToAttach.length === 0) {
        await shell.rawApp.updateModelContext({ content: [] });
        setHasAttachedContext(false);
        setStatusBanner(t.bannerClearedContext);
        return;
      }
      const sanitizeCtxToken = (s: string, maxLen: number) =>
        s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').replace(/`/g, "'").replace(/\r?\n/g, ' ').trim().slice(0, maxLen);
      const md = [
        `[DiffAtlas Selected Context — Workspace: ${sanitizeCtxToken(activeWorkspaceName, 80)}]`,
        `Selected files (${pathsToAttach.length}):`,
        ...pathsToAttach.map((p) => `- ${sanitizeCtxToken(p, 200)}`),
      ].join('\n');
      await shell.rawApp.updateModelContext({
        content: [{ type: 'text', text: md }],
      });
      setHasAttachedContext(true);
      setStatusBanner(t.bannerAttachedContext(pathsToAttach.length));
    } catch (err) {
      setStatusBanner(t.errAttachFailed(err instanceof Error ? err.message : String(err)));
    }
  };

  const handleClearContextAndSelection = async () => {
    setSelectedPaths(new Set());
    await handleAttachContextPaths([]);
  };

  const handleAttachBlastRadiusContext = async () => {
    if (!impact) return;
    const bundle = Array.from(
      new Set([
        ...impact.changedFiles,
        ...impact.directImpactedFiles,
        ...impact.recommendedTests.map((tItem) => tItem.testFile),
      ]),
    ).slice(0, 20);
    setSelectedPaths(new Set(bundle));
    await handleAttachContextPaths(bundle);
  };

  const handleThemeCycle = async () => {
    const order: Array<'system' | 'light' | 'dark'> = ['system', 'dark', 'light'];
    const next = order[(order.indexOf(shell.themeOverride) + 1) % order.length] ?? 'system';
    shell.setThemeOverride(next);
    if (shell.client) {
      await shell.client.callTool('app_save_preferences', { themeOverride: next });
    }
  };

  const handlePreviewRollback = async (checkpointId: string, onlyPaths?: string[]) => {
    if (!shell.client || !activeWorkspaceRoot) return;
    setBusyAction(true);
    setAllowConflictOverride(false);
    const res = await shell.client.callTool<RollbackPreviewResult>('app_preview_rollback', {
      workspacePath: activeWorkspaceRoot,
      checkpointId,
      ...(onlyPaths ? { onlyPaths } : {}),
    });
    setBusyAction(false);
    if (res.ok && res.data) {
      setRollbackPreview(res.data);
    } else {
      setStatusBanner(t.errPreviewRollbackFailed(res.error));
    }
  };

  const handleConfirmRollback = async () => {
    if (!shell.client || !activeWorkspaceRoot || !rollbackPreview) return;
    setBusyAction(true);
    const res = await shell.client.callTool<RollbackExecutionResult>('app_restore_checkpoint', {
      workspacePath: activeWorkspaceRoot,
      checkpointId: rollbackPreview.checkpointId,
      ...(rollbackPreview.onlyPaths && rollbackPreview.onlyPaths.length > 0
        ? { onlyPaths: rollbackPreview.onlyPaths }
        : {}),
      allowOverwriteConflicts: allowConflictOverride,
      humanConfirmed: true,
    });
    setBusyAction(false);
    if (res.ok && res.data) {
      setStatusBanner(res.data.message);
      if (res.data.status === 'RESTORED' || res.data.status === 'NOOP') {
        setRollbackPreview(null);
        await refreshState(activeWorkspaceRoot, undefined, true);
      }
    } else {
      setStatusBanner(t.errRollbackFailed(res.error));
    }
  };

  return (
    <div className={`da-shell ${inlinePreview ? 'has-preview' : ''}`} lang={locale}>
      <header className="da-header" style={{ flexShrink: 0 }}>
        <div className="da-brand">
          <span className="da-title">DiffAtlas</span>
          <span className="da-badge">
            {shell.capabilities.isConversationSurface ? t.surfaceAux : t.surfaceGlobal}
          </span>
          <span className="da-badge">{t.themeValue[shell.theme]}</span>
          {lastSyncedLabel && <span className="da-sync-pill">{lastSyncedLabel}</span>}
        </div>

        <div className="da-toolbar">
          <div className="da-tabs" role="tablist">
            <button
              type="button"
              className={`da-tab ${activeTab === 'impact' ? 'active' : ''}`}
              onClick={() => handleSelectTab('impact')}
            >
              {t.tabImpact((impact?.directImpactedFiles.length ?? 0) + (impact?.indirectImpactedFiles.length ?? 0))}
            </button>
            <button
              type="button"
              className={`da-tab ${activeTab === 'files' ? 'active' : ''}`}
              onClick={() => handleSelectTab('files')}
            >
              {t.tabFiles(workspace?.totalFilesScanned ?? 0)}
            </button>
            <button
              type="button"
              className={`da-tab ${activeTab === 'timemachine' ? 'active' : ''}`}
              onClick={() => handleSelectTab('timemachine')}
            >
              {t.tabTimeMachine(checkpoints.length)}
            </button>
            <button
              type="button"
              className={`da-tab ${activeTab === 'diagnostics' ? 'active' : ''}`}
              onClick={() => handleSelectTab('diagnostics')}
            >
              {t.tabProbe}
            </button>
          </div>

          <button
            type="button"
            className="da-btn"
            title={t.langButtonTitle}
            onClick={handleToggleLocale}
          >
            {t.langButton}
          </button>
          <button type="button" className="da-btn" onClick={() => void handleThemeCycle()}>
            {t.themeButton(t.themeValue[shell.themeOverride])}
          </button>
          <button
            type="button"
            className="da-btn"
            disabled={!shell.client || busyAction}
            onClick={() => {
              setSimulatedTarget(null);
              void refreshState(activeWorkspaceRoot ?? undefined, undefined, true);
            }}
          >
            {busyAction || shell.isToolRunning ? t.syncingBtn : t.refreshBtn}
          </button>
        </div>
      </header>

      <div ref={splitBodyRef} className={`da-split-body ${isResizingPreview ? 'is-dragging' : ''}`}>
        <div className="da-upper-pane">
      {statusBanner && (
        <div className="da-notice">
          <span>{statusBanner}</span>
          <button type="button" className="da-btn" onClick={() => setStatusBanner(null)}>
            {t.dismissBtn}
          </button>
        </div>
      )}

      {workspace?.gitWarning && (
        <div className="da-notice">
          <span>{workspace.gitWarning}</span>
        </div>
      )}

      {impact?.unbornGitRepo && (
        <div className="da-notice">
          <span>{t.unbornGitBanner(impact.changedFiles.length)}</span>
        </div>
      )}

      {impact?.scopeDriftWarning && <div className="da-drift-banner">{impact.scopeDriftWarning}</div>}

      {(shell.connectionError || shell.toolError) && (
        <div className="da-card" style={{ borderColor: 'var(--da-danger)' }}>
          <strong>{t.bridgeErrorPrefix}</strong> {shell.connectionError ?? shell.toolError}
        </div>
      )}

      {/* Summary KPI Grid */}
      <div className="da-meta-grid">
        <div className="da-stat">
          <div className="da-stat-label">{t.kpiWorkspace}</div>
          <div className="da-stat-val da-mono">{activeWorkspaceName}</div>
        </div>
        <div className="da-stat">
          <div className="da-stat-label">{t.kpiBlastRadius}</div>
          <div className="da-stat-val">
            {impact
              ? t.kpiBlastSummary(
                  impact.changedFiles.length,
                  impact.directImpactedFiles.length,
                  impact.indirectImpactedFiles.length,
                )
              : '—'}
          </div>
        </div>
        <div className="da-stat">
          <div className="da-stat-label">{t.kpiRecommendedTests}</div>
          <div className="da-stat-val">{t.kpiFilesCount(impact?.recommendedTests.length ?? 0)}</div>
        </div>
        <div className="da-stat">
          <div className="da-stat-label">{t.kpiTimeMachine}</div>
          <div className="da-stat-val">{t.kpiCheckpointsCount(checkpoints.length)}</div>
        </div>
      </div>

      {recentWorkspaces.length > 1 && (
        <div className="da-card" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>{t.recentWorkspacesLabel}</span>
          {recentWorkspaces.map((rw) => (
            <button
              key={rw.path}
              type="button"
              className="da-btn"
              onClick={() => {
                setSimulatedTarget(null);
                setSelectedPaths(new Set());
                setSelectedGraphNodeId(null);
                setInlinePreview(null);
                setRollbackPreview(null);
                void refreshState(rw.path);
              }}
            >
              {rw.label}
            </button>
          ))}
        </div>
      )}

      {/* TAB 1: DETERMINISTIC IMPACT GRAPH & EVIDENCE CHAIN */}
      {activeTab === 'impact' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <strong>{t.depGraphTitle}</strong>
                {simulatedTarget && (
                  <span className="da-badge da-badge-warn">{t.whatIfBadge(simulatedTarget)}</span>
                )}
                {impact && (
                  <span className="da-badge">
                    {t.graphStatsBadge(impact.totalIndexedCodeFiles, impact.totalGraphEdges, impact.scanDurationMs)}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {simulatedTarget && (
                  <button
                    type="button"
                    className="da-btn"
                    onClick={() => {
                      setSimulatedTarget(null);
                      void refreshState(activeWorkspaceRoot ?? undefined);
                    }}
                  >
                    {t.resetToGitDiff}
                  </button>
                )}
                {shell.capabilities.canUpdateModelContext && impact && impact.changedFiles.length > 0 && (
                  <button
                    type="button"
                    className="da-btn da-btn-primary"
                    onClick={() => void handleAttachBlastRadiusContext()}
                  >
                    {t.attachBlastRadiusBtn}
                  </button>
                )}
                {shell.capabilities.canUpdateModelContext && (hasAttachedContext || selectedPaths.size > 0) && (
                  <button
                    type="button"
                    className="da-btn"
                    onClick={() => void handleClearContextAndSelection()}
                  >
                    {t.clearContextPillBtn}
                  </button>
                )}
              </div>
            </div>

            {!workbench ? (
              <div className="da-empty-graph">{t.loadingGraphState}</div>
            ) : (
              <ImpactGraphSvg
                nodes={impact?.nodes ?? []}
                edges={impact?.edges ?? []}
                selectedNodeId={selectedGraphNodeId}
                strings={t}
                onSelectNode={(node: ImpactGraphNode) => setSelectedGraphNodeId(node.id)}
              />
            )}

            {/* Selected Node Evidence Panel */}
            {selectedGraphNode && (
              <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong className="da-mono">{selectedGraphNode.id}</strong>
                    <span className="da-badge">{t.tierLabels[selectedGraphNode.tier] ?? selectedGraphNode.tier}</span>
                    {selectedGraphNode.isTestFile && <span className="da-badge da-badge-ok">{t.treeTestBadge}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button
                      type="button"
                      className="da-btn"
                      onClick={() => void handleSimulateImpact(selectedGraphNode.id)}
                    >
                      {t.simulateImpactBtn}
                    </button>
                    <button
                      type="button"
                      className="da-btn"
                      onClick={() => void handlePreviewDiffInline(selectedGraphNode.id)}
                    >
                      {t.diffBtn}
                    </button>
                    <button
                      type="button"
                      className="da-btn da-btn-primary"
                      onClick={() => void openFileUriOrInline(selectedGraphNode.id, selectedGraphNode.fileUri)}
                    >
                      {t.openFileViewBtn}
                    </button>
                  </div>
                </div>

                {selectedNodeEdges.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--da-text-tertiary)' }}>
                    {t.noDirectEdges}
                  </div>
                ) : (
                  <div className="da-file-list" style={{ maxHeight: 170 }}>
                    {selectedNodeEdges.map((edge, i) => (
                      <div key={`${edge.from}:${edge.line}:${i}`} className="da-evidence-row">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span className={edge.confidence === 'high' ? 'da-badge da-badge-ok' : 'da-badge da-badge-warn'}>
                            {edge.confidence.toUpperCase()} · {edge.kind}
                          </span>
                          <span className="da-mono">
                            {edge.from}:{edge.line} → {edge.to}
                          </span>
                        </div>
                        <code className="da-mono" style={{ color: 'var(--da-text-secondary)' }}>
                          {edge.snippet}
                        </code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Recommended Test Files */}
          <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <strong>{t.recommendedTestsTitle(impact?.recommendedTests.length ?? 0)}</strong>
            {!impact || impact.recommendedTests.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--da-text-tertiary)' }}>
                {t.noRecommendedTests}
              </div>
            ) : (
              <div className="da-file-list" style={{ maxHeight: 180 }}>
                {impact.recommendedTests.map((tEntry) => (
                  <div key={tEntry.testFile} className="da-file-row">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className={tEntry.confidence === 'high' ? 'da-badge da-badge-ok' : 'da-badge da-badge-warn'}>
                          {tEntry.confidence} · {tEntry.reason}
                        </span>
                        <span className="da-mono" style={{ fontWeight: 600 }}>
                          {tEntry.testFile}
                        </span>
                      </div>
                      {tEntry.evidence && (
                        <span className="da-mono" style={{ color: 'var(--da-text-tertiary)' }}>
                          {tEntry.evidence}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="da-btn da-btn-primary"
                      onClick={() => void openFileUriOrInline(tEntry.testFile, tEntry.fileUri)}
                    >
                      {t.fileViewShortBtn}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Low-Confidence Dynamic / Unresolved Warnings */}
          {impact && impact.lowConfidenceWarnings.length > 0 && (
            <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <strong>{t.lowConfTitle(impact.lowConfidenceWarnings.length)}</strong>
              <div className="da-file-list" style={{ maxHeight: 160 }}>
                {impact.lowConfidenceWarnings.map((w, idx) => (
                  <div key={`${w.sourceFile}:${w.line}:${idx}`} className="da-evidence-row">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="da-badge da-badge-warn">{w.kind}</span>
                      <span className="da-mono">
                        {w.sourceFile}:{w.line}
                      </span>
                    </div>
                    <span style={{ fontSize: 11.5, color: 'var(--da-text-secondary)' }}>{w.note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: WORKSPACE FILE TREE & CONTEXT SELECTOR */}
      {activeTab === 'files' && (
        <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="search"
              className="da-input"
              style={{ flex: 1, minWidth: 160 }}
              placeholder={t.filterPlaceholder}
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
              {t.changedOnlyLabel}
            </label>

            {shell.capabilities.canUpdateModelContext && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {selectedPaths.size > 0 && (
                  <button
                    type="button"
                    className="da-btn da-btn-primary"
                    onClick={() => void handleAttachContextPaths(Array.from(selectedPaths))}
                  >
                    {t.attachFilesBtn(selectedPaths.size)}
                  </button>
                )}
                <button
                  type="button"
                  className="da-btn"
                  onClick={() => void handleClearContextAndSelection()}
                >
                  {selectedPaths.size > 0 ? t.clearSelectionAndPillBtn : t.clearContextPillBtn}
                </button>
              </div>
            )}
          </div>

          <FileTreeView
            files={filteredFiles}
            impactTierMap={impactTierMap}
            canSelectForContext={shell.capabilities.canUpdateModelContext}
            selectedPaths={selectedPaths}
            strings={t}
            onToggleSelect={toggleSelectPath}
            onOpenFileView={(f: WorkspaceFileNode) => void openFileUriOrInline(f.relativePath, f.fileUri)}
            onPreviewDiff={(f: WorkspaceFileNode) => void handlePreviewDiffInline(f.relativePath)}
            onSimulateImpact={(p: string) => void handleSimulateImpact(p)}
          />
        </div>
      )}

      {/* TAB 3: AGENT TIME MACHINE (HUMAN-ONLY ROLLBACK) */}
      {activeTab === 'timemachine' && (
        <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--da-text-secondary)' }}>
            {t.timeMachineIntro}
          </div>

          {rollbackPreview && (
            <div className="da-card" style={{ borderColor: 'var(--da-accent)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                <strong>
                  {t.confirmRollbackTitle(rollbackPreview.checkpointLabel, rollbackPreview.checkpointId)}
                </strong>
                <span className="da-badge da-badge-warn">
                  {rollbackPreview.onlyPaths && rollbackPreview.onlyPaths.length > 0
                    ? t.singleFileScopeBadge(rollbackPreview.onlyPaths.join(', '))
                    : t.fullCheckpointScopeBadge}
                </span>
              </div>
              <div className="da-file-list" style={{ marginBottom: 8 }}>
                {rollbackPreview.files.map((fp) => (
                  <div key={fp.relativePath} className="da-file-row">
                    <div className="da-file-left">
                      <span
                        className={
                          fp.disposition === 'CONFLICT_HUMAN_MODIFIED'
                            ? 'da-badge da-badge-danger'
                            : fp.disposition.startsWith('READY_')
                              ? 'da-badge da-badge-ok'
                              : 'da-badge'
                        }
                      >
                        {t.dispositionLabels[fp.disposition] ?? fp.disposition}
                      </span>
                      <span className="da-mono">{fp.relativePath}</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--da-text-secondary)' }}>{fp.reason}</span>
                  </div>
                ))}
              </div>

              {rollbackPreview.hasConflicts && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    marginBottom: 8,
                    color: 'var(--da-danger)',
                    fontWeight: 600,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={allowConflictOverride}
                    onChange={(e) => setAllowConflictOverride(e.target.checked)}
                  />
                  {t.overrideConflictsLabel}
                </label>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="da-btn da-btn-danger"
                  disabled={busyAction || (rollbackPreview.hasConflicts && !allowConflictOverride)}
                  onClick={() => void handleConfirmRollback()}
                >
                  {t.confirmRestoreBtn}
                </button>
                <button type="button" className="da-btn" onClick={() => setRollbackPreview(null)}>
                  {t.cancelBtn}
                </button>
              </div>
            </div>
          )}

          {checkpoints.length === 0 ? (
            <div style={{ padding: 14, color: 'var(--da-text-tertiary)', textAlign: 'center' }}>
              {t.noCheckpointsYet}
            </div>
          ) : (
            <div className="da-file-list">
              {checkpoints.map((cp) => (
                <div key={cp.id} className="da-file-row">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span
                        className={
                          cp.kind === 'pre_rollback_backup' ? 'da-badge da-badge-warn' : 'da-badge da-badge-ok'
                        }
                      >
                        {cp.kind === 'pre_rollback_backup' ? t.undoBackupBadge : t.agentTurnBadge}
                      </span>
                      {cp.modelName && <span className="da-badge">{cp.modelName}</span>}
                      <strong>{cp.label}</strong>
                    </div>
                    <span className="da-mono" style={{ color: 'var(--da-text-tertiary)' }}>
                      {t.checkpointFilesMeta(cp.id, cp.files.length, cp.files.map((f) => f.relativePath).join(', '))}
                    </span>
                    {cp.files.length > 1 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 3 }}>
                        {cp.files.slice(0, 8).map((f) => (
                          <button
                            key={f.relativePath}
                            type="button"
                            className="da-btn"
                            style={{ padding: '2px 6px', fontSize: 11 }}
                            disabled={busyAction}
                            title={t.singleFileRollbackTooltip(f.relativePath)}
                            onClick={() => void handlePreviewRollback(cp.id, [f.relativePath])}
                          >
                            ↺ {f.relativePath.split('/').pop()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="da-btn"
                    disabled={busyAction}
                    onClick={() => void handlePreviewRollback(cp.id)}
                  >
                    {t.previewTurnRollbackBtn}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB 4: HOST PROBE & DIAGNOSTICS */}
      {activeTab === 'diagnostics' && (
        <div className="da-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>{t.probeTitle}</strong>
          <div>{t.probeConnected(shell.isConnected)}</div>
          <div>{t.probeThemeSync(shell.theme)}</div>
          <div>{t.probePluginLang}</div>
          <div>{t.probeCapServerTools(shell.capabilities.canCallServerTools)}</div>
          <div>{t.probeCapUpdateContext(shell.capabilities.canUpdateModelContext)}</div>
          <div>{t.probeCapMessage(shell.capabilities.canSendMessage)}</div>
          <div>
            {t.probeEngineStats(
              impact?.totalIndexedCodeFiles ?? 0,
              impact?.totalGraphEdges ?? 0,
              impact?.scanDurationMs ?? 0,
            )}
          </div>
          <div>
            {t.probeLatencyBreakdown(
              uiConnectMs,
              firstDataMs,
              workbench?.serverTiming?.totalMs ?? null,
              workbench?.serverTiming
                ? `ws=${workbench.serverTiming.resolveWsMs}ms · git+fs=${workbench.serverTiming.scanMs}ms · impact=${workbench.serverTiming.impactMs}ms · cp=${workbench.serverTiming.checkpointsMs}ms · cache=${workbench.serverTiming.cacheHit ? 'HIT' : 'MISS'}`
                : 'n/a',
            )}
          </div>
          <div>
            {t.probeHostPlatform(shell.hostContext?.locale ?? 'default', shell.hostContext?.platform ?? 'web')}
          </div>
        </div>
      )}
        </div>

        {/* Docked Resizable Inline Diff / Fallback Preview Drawer */}
        {inlinePreview && (
          <>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t.previewResizeHint}
              aria-valuemin={MIN_PREVIEW_RATIO}
              aria-valuemax={MAX_PREVIEW_RATIO}
              aria-valuenow={previewRatio}
              tabIndex={0}
              title={t.previewResizeHint}
              className={`da-split-handle ${isResizingPreview ? 'active' : ''}`}
              onPointerDown={handleSplitterPointerDown}
              onPointerMove={handleSplitterPointerMove}
              onPointerUp={finishSplitterDrag}
              onPointerCancel={finishSplitterDrag}
              onLostPointerCapture={finishSplitterDrag}
              onDoubleClick={handleResetPreviewRatio}
              onKeyDown={handleSplitterKeyDown}
            >
              <span className="da-split-grip" />
            </div>
            <div
              className="da-card da-preview-drawer"
              style={{ height: `${previewRatio}%` }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <strong className="da-mono">{t.inlinePreviewTitle(inlinePreview.path)}</strong>
                  <span className="da-badge">{previewRatio}%</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {previewRatio !== DEFAULT_PREVIEW_RATIO && (
                    <button type="button" className="da-btn" onClick={handleResetPreviewRatio}>
                      {t.previewResetBtn}
                    </button>
                  )}
                  <button type="button" className="da-btn" onClick={() => setInlinePreview(null)}>
                    {t.closePreviewBtn}
                  </button>
                </div>
              </div>
              <pre className="da-diff-box da-diff-box-fill">{inlinePreview.content}</pre>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
