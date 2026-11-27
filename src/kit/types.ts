/**
 * Shared contracts for Antigravity MCP App plugins (reusable across DiffAtlas & companion plugins).
 * Zero coupling to domain-specific code-analysis or media logic.
 */

export type ToolVisibilitySurface = 'model' | 'app';

export type AntigravityEntrypointType = 'aux_pane' | 'global';

export interface AntigravityEntrypoint {
  type: AntigravityEntrypointType;
  title: string;
}

export interface PluginIdentity {
  /** Lowercase kebab-case plugin identifier (e.g. "diffatlas") */
  id: string;
  /** Brand display name without vendor prefixes (e.g. "DiffAtlas") */
  displayName: string;
  /** Semantic version */
  version: string;
  /** MCP UI resource URI, must begin with "ui://" */
  resourceUri: `ui://${string}`;
  /** Optional env var override for hot-reloading UI HTML during development */
  appHtmlEnvVar: string;
}

export interface PluginRuntimePaths {
  pluginRoot: string;
  dataDir: string;
  stateDir: string;
  auditLogPath: string;
  defaultAppHtmlPath: string;
}

/**
 * Dual-surface response returned by model+app tools:
 * - `summaryMarkdown` goes to `content[0].text` for the LLM / CLI fallback (strictly < 512 KiB).
 * - `structuredContent` goes to the MCP App iframe over postMessage.
 */
export interface DualSurfacePayload<TStructured extends Record<string, unknown>> {
  summaryMarkdown: string;
  structuredContent: TStructured;
  isError?: boolean;
}

export type ChunkEncoding = 'utf8' | 'base64';

export interface ChunkSliceRequest {
  /** Workspace-relative or validated path */
  targetPath: string;
  /** Workspace root directory */
  workspaceRoot?: string;
  /** Byte offset into the file (0-indexed) */
  byteOffset?: number;
  /** Requested byte length per slice (capped by server, default 256 KiB) */
  byteLength?: number;
  /** 'utf8' for source/diff text, 'base64' for binary assets (e.g. .glb/.stl/.png) */
  encoding?: ChunkEncoding;
}

export interface ChunkSliceResponse extends Record<string, unknown> {
  targetPath: string;
  relativePath: string;
  totalBytes: number;
  byteOffset: number;
  byteLength: number;
  eof: boolean;
  encoding: ChunkEncoding;
  data: string;
  sha256: string;
}

export interface RecentTargetRecord {
  path: string;
  label: string;
  lastOpenedAt: string;
  kind: 'workspace' | 'asset';
}

export type PluginUiLocale = 'en' | 'zh-CN';

export interface PersistedUiPreferences {
  themeOverride?: 'system' | 'light' | 'dark';
  locale?: PluginUiLocale;
  activeTab?: string;
  compactMode?: boolean;
  /** Inline preview vertical split ratio percentage (20..80) */
  previewRatio?: number;
  updatedAt: string;
}

export type PathGuardErrorCode =
  | 'ERR_EMPTY_PATH'
  | 'ERR_NUL_BYTE'
  | 'ERR_CONTROL_CHAR'
  | 'ERR_EXTERNAL_URI_BLOCKED'
  | 'ERR_OUTSIDE_WORKSPACE'
  | 'ERR_SYMLINK_ESCAPE'
  | 'ERR_SENSITIVE_FILE_BLOCKED'
  | 'ERR_WORKSPACE_NOT_FOUND';

export class PathGuardError extends Error {
  public readonly code: PathGuardErrorCode;
  public readonly requestedPath: string;

  constructor(code: PathGuardErrorCode, message: string, requestedPath: string) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
    this.requestedPath = requestedPath;
  }
}
