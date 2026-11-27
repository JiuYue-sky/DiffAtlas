import type { PluginUiLocale } from '../kit/types.js';
import type { GitFileStatus } from '../core/git-workspace.js';
import type { ImpactTier } from '../core/impact-analyzer.js';
import type { RollbackFileDisposition } from '../core/snapshot-engine.js';

export interface UiStrings {
  surfaceAux: string;
  surfaceGlobal: string;
  themeValue: Record<'light' | 'dark' | 'system', string>;
  syncedAt: (clock: string) => string;
  simulatedAt: (clock: string) => string;
  tabImpact: (count: number) => string;
  tabFiles: (count: number) => string;
  tabTimeMachine: (count: number) => string;
  tabProbe: string;
  themeButton: (modeLabel: string) => string;
  langButton: string;
  langButtonTitle: string;
  refreshBtn: string;
  syncingBtn: string;
  dismissBtn: string;
  loadingWorkspace: string;
  loadingGraphState: string;
  unbornGitBanner: (count: number) => string;
  bridgeErrorPrefix: string;
  kpiWorkspace: string;
  kpiBlastRadius: string;
  kpiBlastSummary: (chg: number, hop1: number, hop2: number) => string;
  kpiRecommendedTests: string;
  kpiFilesCount: (n: number) => string;
  kpiTimeMachine: string;
  kpiCheckpointsCount: (n: number) => string;
  recentWorkspacesLabel: string;
  depGraphTitle: string;
  whatIfBadge: (path: string) => string;
  graphStatsBadge: (files: number, edges: number, ms: number) => string;
  resetToGitDiff: string;
  attachBlastRadiusBtn: string;
  simulateImpactBtn: string;
  diffBtn: string;
  openFileViewBtn: string;
  fileViewShortBtn: string;
  noDirectEdges: string;
  recommendedTestsTitle: (n: number) => string;
  noRecommendedTests: string;
  lowConfTitle: (n: number) => string;
  filterPlaceholder: string;
  changedOnlyLabel: string;
  attachFilesBtn: (n: number) => string;
  clearContextPillBtn: string;
  clearSelectionAndPillBtn: string;
  inlinePreviewTitle: (path: string) => string;
  previewResizeHint: string;
  previewResetBtn: string;
  closePreviewBtn: string;
  noUnstagedDiff: string;
  timeMachineIntro: string;
  confirmRollbackTitle: (label: string, id: string) => string;
  singleFileScopeBadge: (paths: string) => string;
  fullCheckpointScopeBadge: string;
  overrideConflictsLabel: string;
  confirmRestoreBtn: string;
  cancelBtn: string;
  noCheckpointsYet: string;
  undoBackupBadge: string;
  agentTurnBadge: string;
  checkpointFilesMeta: (id: string, count: number, list: string) => string;
  singleFileRollbackTooltip: (path: string) => string;
  previewTurnRollbackBtn: string;
  probeTitle: string;
  probeConnected: (yes: boolean) => string;
  probeThemeSync: (theme: string) => string;
  probePluginLang: string;
  probeCapServerTools: (yes: boolean) => string;
  probeCapUpdateContext: (yes: boolean) => string;
  probeCapMessage: (yes: boolean) => string;
  probeEngineStats: (files: number, edges: number, ms: number) => string;
  probeLatencyBreakdown: (uiConnectMs: number | null, firstDataMs: number | null, serverTotalMs: number | null, detail: string) => string;
  probeHostPlatform: (locale: string, platform: string) => string;
  columnTitles: Record<ImpactTier, string>;
  tierLabels: Record<ImpactTier, string>;
  gitStatusLabels: Record<GitFileStatus, string>;
  dispositionLabels: Record<RollbackFileDisposition, string>;
  graphEmptyState: string;
  graphOverflowMore: (extra: number) => string;
  treeNoMatch: string;
  treeRootFolder: string;
  treeChangedCount: (n: number) => string;
  treeTestBadge: string;
  treeSimulateTooltip: string;
  bannerOpenedFileView: (path: string) => string;
  bannerInlineFallback: (path: string) => string;
  bannerSimulated: (path: string) => string;
  bannerClearedContext: string;
  bannerAttachedContext: (n: number) => string;
  errRefreshFailed: (msg: string) => string;
  errDiffFailed: (msg?: string) => string;
  errSimFailed: (msg: string) => string;
  errAttachFailed: (msg: string) => string;
  errPreviewRollbackFailed: (msg?: string) => string;
  errRollbackFailed: (msg?: string) => string;
}

const EN_STRINGS: UiStrings = {
  surfaceAux: 'Aux Pane',
  surfaceGlobal: 'Global Sidebar',
  themeValue: { system: 'system', light: 'light', dark: 'dark' },
  syncedAt: (clock) => `Synced ${clock}`,
  simulatedAt: (clock) => `Simulated ${clock}`,
  tabImpact: (n) => `Impact (${n})`,
  tabFiles: (n) => `Files (${n})`,
  tabTimeMachine: (n) => `Time Machine (${n})`,
  tabProbe: 'Probe',
  themeButton: (m) => `Theme: ${m}`,
  langButton: '中文',
  langButtonTitle: 'Switch DiffAtlas UI to Chinese (isolated to this plugin only)',
  refreshBtn: 'Refresh',
  syncingBtn: 'Syncing…',
  dismissBtn: 'Dismiss',
  loadingWorkspace: 'Loading…',
  loadingGraphState: 'Scanning workspace files and dependency graph…',
  unbornGitBanner: (n) =>
    `Initial Git repository (no HEAD commit yet): all ${n} untracked files appear as Hop 0. Run an initial git commit to track incremental diffs, or click "Impact" on any file to simulate its 1–2 hop blast radius.`,
  bridgeErrorPrefix: 'Bridge / Tool Error:',
  kpiWorkspace: 'Workspace',
  kpiBlastRadius: 'Blast Radius',
  kpiBlastSummary: (c, h1, h2) => `${c} chg · ${h1} 1-hop · ${h2} 2-hop`,
  kpiRecommendedTests: 'Recommended Tests',
  kpiFilesCount: (n) => `${n} file(s)`,
  kpiTimeMachine: 'Time Machine',
  kpiCheckpointsCount: (n) => `${n} checkpoint(s)`,
  recentWorkspacesLabel: 'Recent Workspaces:',
  depGraphTitle: 'Dependency Impact Graph',
  whatIfBadge: (p) => `What-If: ${p}`,
  graphStatsBadge: (f, e, ms) => `${f} files · ${e} edges · ${ms}ms`,
  resetToGitDiff: 'Reset to Git Diff',
  attachBlastRadiusBtn: 'Attach Blast Radius + Tests',
  simulateImpactBtn: 'Simulate Impact',
  diffBtn: 'Diff',
  openFileViewBtn: 'Open fileView',
  fileViewShortBtn: 'fileView',
  noDirectEdges: 'No direct edges within the current subgraph for this node.',
  recommendedTestsTitle: (n) => `Recommended Tests (${n})`,
  noRecommendedTests: 'No affected test files identified for the current selection.',
  lowConfTitle: (n) => `Low-Confidence / Dynamic Imports (${n})`,
  filterPlaceholder: 'Filter files by path (e.g. src/core/impact-analyzer.ts)…',
  changedOnlyLabel: 'Changed only',
  attachFilesBtn: (n) => `Attach ${n} File(s) to Context`,
  clearContextPillBtn: 'Clear Context Pill',
  clearSelectionAndPillBtn: 'Clear Pill & Uncheck',
  inlinePreviewTitle: (p) => `Inline Preview: ${p}`,
  previewResizeHint: 'Drag up/down to resize split ratio · Double-click to reset (42%)',
  previewResetBtn: 'Reset',
  closePreviewBtn: 'Close Preview',
  noUnstagedDiff: '(No unstaged/staged diff; file matches HEAD)',
  timeMachineIntro:
    'Snapshots are captured automatically in <50ms before every Agent file edit via PreToolUse. Rollback is strictly human-confirmed (visibility: ["app"]) with 3-way conflict detection and automatic Undo-of-Undo backup.',
  confirmRollbackTitle: (label, id) => `Confirm Rollback: ${label} (${id})`,
  singleFileScopeBadge: (paths) => `Single-File Scope: ${paths}`,
  fullCheckpointScopeBadge: 'Full Checkpoint Scope',
  overrideConflictsLabel: 'Override manual edit conflicts (current disk state will still be backed up first)',
  confirmRestoreBtn: 'Confirm & Restore Now',
  cancelBtn: 'Cancel',
  noCheckpointsYet: 'No Agent edit checkpoints recorded yet.',
  undoBackupBadge: 'Undo Backup',
  agentTurnBadge: 'Agent Turn',
  checkpointFilesMeta: (id, count, list) => `${id} · ${count} file(s): ${list}`,
  singleFileRollbackTooltip: (p) => `Preview single-file rollback for ${p} only`,
  previewTurnRollbackBtn: 'Preview Turn Rollback',
  probeTitle: 'Host Integration & Engine Diagnostics',
  probeConnected: (yes) => `• MCP App Connected: ${yes ? 'YES' : 'NO'}`,
  probeThemeSync: (t) => `• Host Theme Sync: Active (${t})`,
  probePluginLang: '• Plugin UI Language: English (isolated inside DiffAtlas iframe; host untouched)',
  probeCapServerTools: (yes) => `• Capability serverTools: ${yes ? 'Advertised' : 'Absent'}`,
  probeCapUpdateContext: (yes) =>
    `• Capability updateModelContext: ${yes ? 'Advertised (Context Pill active)' : 'Absent (Global Sidebar — buttons hidden automatically)'}`,
  probeCapMessage: (yes) => `• Capability message: ${yes ? 'Advertised' : 'Absent'}`,
  probeEngineStats: (f, e, ms) => `• Dependency Engine: ${f} indexed files · ${e} edges · last scan ${ms}ms`,
  probeLatencyBreakdown: (cMs, dMs, sMs, detail) =>
    `• Live Latency Telemetry: UI connect ${cMs ?? '—'}ms · First Data ${dMs ?? '—'}ms · Server total ${sMs ?? '—'}ms (${detail})`,
  probeHostPlatform: (loc, plat) => `• Host Locale / Platform: ${loc} / ${plat}`,
  columnTitles: {
    upstream_dependency: 'Upstream Deps',
    changed: 'Changed (Hop 0)',
    direct_impact: 'Direct Impact (1-hop)',
    indirect_impact: 'Indirect (2-hop)',
  },
  tierLabels: {
    upstream_dependency: 'upstream',
    changed: 'Hop 0',
    direct_impact: '1-hop',
    indirect_impact: '2-hop',
  },
  gitStatusLabels: {
    modified: 'modified',
    added: 'added',
    deleted: 'deleted',
    untracked: 'untracked',
    renamed: 'renamed',
    clean: 'clean',
  },
  dispositionLabels: {
    NOOP_ALREADY_MATCHES: 'NOOP_ALREADY_MATCHES',
    READY_CLEAN_RESTORE: 'READY_CLEAN_RESTORE',
    READY_CLEAN_DELETE_CREATED: 'READY_CLEAN_DELETE_CREATED',
    CONFLICT_HUMAN_MODIFIED: 'CONFLICT_HUMAN_MODIFIED',
    SKIPPED_UNTRACKED: 'SKIPPED_UNTRACKED',
    ERROR_MISSING_BLOB: 'ERROR_MISSING_BLOB',
  },
  graphEmptyState:
    'No dependency nodes in current view. Edit a supported source file (TS/JS, Vue/Svelte/Astro, Python, Go, Rust, C/C++, Java/Kotlin, C#) or click "Simulate Impact" on any code file.',
  graphOverflowMore: (extra) => `+${extra} more (see Files tab)`,
  treeNoMatch: 'No matching files found.',
  treeRootFolder: '(root)',
  treeChangedCount: (n) => `${n} changed`,
  treeTestBadge: 'test',
  treeSimulateTooltip: 'Simulate 1-2 hop blast radius for this file',
  bannerOpenedFileView: (p) => `Opened native fileView: ${p}`,
  bannerInlineFallback: (p) => `Showing inline preview for ${p}`,
  bannerSimulated: (p) => `Simulated blast radius for ${p}`,
  bannerClearedContext: 'Cleared DiffAtlas context pill from conversation input.',
  bannerAttachedContext: (n) =>
    `Attached ${n} file(s) as context pill (consumed by your next message; re-attach if needed across turns).`,
  errRefreshFailed: (msg) => `Refresh failed: ${msg}`,
  errDiffFailed: (msg) => msg || 'Unable to load file diff.',
  errSimFailed: (msg) => `Impact simulation failed: ${msg}`,
  errAttachFailed: (msg) => `Failed to attach context pill: ${msg}`,
  errPreviewRollbackFailed: (msg) => msg || 'Failed to preview rollback.',
  errRollbackFailed: (msg) => msg || 'Rollback failed.',
};

const ZH_CN_STRINGS: UiStrings = {
  surfaceAux: '右侧面板',
  surfaceGlobal: '全局侧栏',
  themeValue: { system: '跟随宿主', light: '浅色', dark: '深色' },
  syncedAt: (clock) => `已同步 ${clock}`,
  simulatedAt: (clock) => `已预演 ${clock}`,
  tabImpact: (n) => `影响图 (${n})`,
  tabFiles: (n) => `文件树 (${n})`,
  tabTimeMachine: (n) => `时光机 (${n})`,
  tabProbe: '诊断',
  themeButton: (m) => `主题: ${m}`,
  langButton: 'EN',
  langButtonTitle: '将 DiffAtlas 面板切换为英文（仅限本插件内部生效，不影响宿主与其他插件）',
  refreshBtn: '刷新',
  syncingBtn: '同步中…',
  dismissBtn: '关闭',
  loadingWorkspace: '加载中…',
  loadingGraphState: '正在快速加载工作区与依赖影响图…',
  unbornGitBanner: (n) =>
    `当前仓库尚未执行首次 Git 提交（无 HEAD 基线）：全部 ${n} 个未跟踪文件均显示为 Hop 0。执行首次 git commit 后将仅高亮增量修改；现在也可在文件树点击「影响」单独预演任意模块的 1～2 跳波及范围。`,
  bridgeErrorPrefix: '桥接 / 工具错误：',
  kpiWorkspace: '当前工作区',
  kpiBlastRadius: '变更波及面',
  kpiBlastSummary: (c, h1, h2) => `${c} 改动 · ${h1} 一跳 · ${h2} 二跳`,
  kpiRecommendedTests: '推荐测试',
  kpiFilesCount: (n) => `${n} 个文件`,
  kpiTimeMachine: '时光机快照',
  kpiCheckpointsCount: (n) => `${n} 个恢复点`,
  recentWorkspacesLabel: '最近工作区：',
  depGraphTitle: '确定性文件级依赖影响图',
  whatIfBadge: (p) => `预演目标: ${p}`,
  graphStatsBadge: (f, e, ms) => `${f} 个代码文件 · ${e} 条依赖边 · ${ms}ms`,
  resetToGitDiff: '还原至 Git 改动',
  attachBlastRadiusBtn: '挂入波及模块与测试',
  simulateImpactBtn: '预演影响',
  diffBtn: '查看 Diff',
  openFileViewBtn: '打开源码视图',
  fileViewShortBtn: '源码',
  noDirectEdges: '当前子图中该节点暂无直接依赖连线。',
  recommendedTestsTitle: (n) => `推荐关联测试文件 (${n})`,
  noRecommendedTests: '当前改动范围内暂未识别到受影响的测试文件。',
  lowConfTitle: (n) => `低置信度 / 动态导入提醒 (${n})`,
  filterPlaceholder: '按路径过滤文件（例如 src/core/impact-analyzer.ts）…',
  changedOnlyLabel: '仅看改动',
  attachFilesBtn: (n) => `将已选 ${n} 个文件挂入上下文`,
  clearContextPillBtn: '清空上下文胶囊',
  clearSelectionAndPillBtn: '清空胶囊与勾选',
  inlinePreviewTitle: (p) => `内联只读预览: ${p}`,
  previewResizeHint: '上下拖动调整预览区占比 · 双击恢复默认比例（42%）',
  previewResetBtn: '重置比例',
  closePreviewBtn: '关闭预览',
  noUnstagedDiff: '（当前文件无差异，内容与 HEAD 一致）',
  timeMachineIntro:
    '每次 Agent 修改文件前均由 PreToolUse 在 <50ms 内自动留存本地快照。回滚操作严格归人类专属确认（visibility: ["app"]），内置三方人工修改冲突拦截与回滚前自动备份（Undo-of-Undo）。',
  confirmRollbackTitle: (label, id) => `确认执行回滚：${label} (${id})`,
  singleFileScopeBadge: (paths) => `单文件回滚范围: ${paths}`,
  fullCheckpointScopeBadge: '整轮快照回滚范围',
  overrideConflictsLabel: '强制覆盖人工修改冲突（覆盖前仍会自动备份当前磁盘内容）',
  confirmRestoreBtn: '确认立即恢复',
  cancelBtn: '取消',
  noCheckpointsYet: '当前工作区暂无 Agent 修改快照记录。',
  undoBackupBadge: '回滚前备份',
  agentTurnBadge: 'Agent 轮次',
  checkpointFilesMeta: (id, count, list) => `${id} · 涉及 ${count} 个文件: ${list}`,
  singleFileRollbackTooltip: (p) => `仅预览并恢复单文件 ${p}`,
  previewTurnRollbackBtn: '预览整轮回滚',
  probeTitle: '宿主集成与引擎自检状态',
  probeConnected: (yes) => `• MCP App 通信桥接: ${yes ? '已连接 (YES)' : '未连接 (NO)'}`,
  probeThemeSync: (t) => `• 宿主主题同步: 已激活 (${t})`,
  probePluginLang: '• 插件界面语言: 简体中文（仅在 DiffAtlas 独立沙箱面板内生效，零侵入宿主）',
  probeCapServerTools: (yes) => `• 宿主能力 serverTools: ${yes ? '已声明' : '未提供'}`,
  probeCapUpdateContext: (yes) =>
    `• 宿主能力 updateModelContext: ${yes ? '已声明（上下文胶囊可用）' : '未提供（全局侧栏已自动隐藏会话专属按钮）'}`,
  probeCapMessage: (yes) => `• 宿主能力 message: ${yes ? '已声明' : '未提供'}`,
  probeEngineStats: (f, e, ms) => `• 依赖分析引擎: 已索引 ${f} 个代码文件 · ${e} 条依赖边 · 最近扫描耗时 ${ms}ms`,
  probeLatencyBreakdown: (cMs, dMs, sMs, detail) =>
    `• 实时耗时诊断: 面板握手 ${cMs ?? '—'}ms · 首屏出数 ${dMs ?? '—'}ms · 服务端总计 ${sMs ?? '—'}ms（${detail}）`,
  probeHostPlatform: (loc, plat) => `• 宿主区域 / 平台标识: ${loc} / ${plat}`,
  columnTitles: {
    upstream_dependency: '上游被依赖模块',
    changed: '直接改动 (Hop 0)',
    direct_impact: '1 跳直接波及',
    indirect_impact: '2 跳间接波及',
  },
  tierLabels: {
    upstream_dependency: '上游依赖',
    changed: 'Hop 0',
    direct_impact: '1 跳波及',
    indirect_impact: '2 跳波及',
  },
  gitStatusLabels: {
    modified: '已修改',
    added: '新增',
    deleted: '已删除',
    untracked: '未跟踪',
    renamed: '重命名',
    clean: '未改动',
  },
  dispositionLabels: {
    NOOP_ALREADY_MATCHES: '无需恢复（已一致）',
    READY_CLEAN_RESTORE: '可安全恢复原内容',
    READY_CLEAN_DELETE_CREATED: '可安全清理新建文件',
    CONFLICT_HUMAN_MODIFIED: '人工修改冲突（已拦截）',
    SKIPPED_UNTRACKED: '已跳过',
    ERROR_MISSING_BLOB: '快照块缺失',
  },
  graphEmptyState:
    '当前视图暂无依赖节点。修改任意已支持的代码文件（TS/JS、Vue/Svelte/Astro、Python、Go、Rust、C/C++、Java/Kotlin、C#）或在文件树点击「预演影响」即可查看波及范围。',
  graphOverflowMore: (extra) => `另有 +${extra} 个文件（详见「文件树」页签）`,
  treeNoMatch: '未找到匹配的文件。',
  treeRootFolder: '(根目录)',
  treeChangedCount: (n) => `${n} 处改动`,
  treeTestBadge: '测试',
  treeSimulateTooltip: '预演该文件的 1～2 跳下游波及范围',
  bannerOpenedFileView: (p) => `已在原生源码查看器中打开: ${p}`,
  bannerInlineFallback: (p) => `正在展示内联预览: ${p}`,
  bannerSimulated: (p) => `已完成单文件波及预演: ${p}`,
  bannerClearedContext: '已清空输入框中的 DiffAtlas 上下文胶囊。',
  bannerAttachedContext: (n) => `已将 ${n} 个文件挂入下一轮对话上下文胶囊（发送下一条消息时生效）。`,
  errRefreshFailed: (msg) => `刷新失败：${msg}`,
  errDiffFailed: (msg) => msg || '无法加载文件差异。',
  errSimFailed: (msg) => `影响预演失败：${msg}`,
  errAttachFailed: (msg) => `挂入上下文胶囊失败：${msg}`,
  errPreviewRollbackFailed: (msg) => msg || '回滚预览失败。',
  errRollbackFailed: (msg) => msg || '回滚执行失败。',
};

export function getUiStrings(locale: PluginUiLocale): UiStrings {
  return locale === 'zh-CN' ? ZH_CN_STRINGS : EN_STRINGS;
}
