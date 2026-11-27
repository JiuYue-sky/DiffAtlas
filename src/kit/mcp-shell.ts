import fs from 'node:fs';
import {
  McpServer,
  type CallToolResult,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readSafeFileChunk } from './chunk-channel.js';
import { PathGuard, redactSecretsAndPaths } from './path-guard.js';
import { withTimeoutCircuitBreaker } from './process-guard.js';
import { PluginStateStore, resolvePluginRuntimePaths } from './runtime-paths.js';
import {
  AntigravityEntrypoint,
  DualSurfacePayload,
  PathGuardError,
  PluginIdentity,
  PluginRuntimePaths,
  ToolVisibilitySurface,
} from './types.js';

/** Strict 512 KiB ceiling on model-visible text results */
export const MAX_MODEL_TEXT_BYTES = 512 * 1024;
/** Safe 768 KiB ceiling on combined trajectory `CallToolResult` (`content` + `structuredContent`; host drops at 1 MiB) */
export const MAX_TRAJECTORY_TOTAL_BYTES = 768 * 1024;
/** Hard 10 MiB MCP Apps HTML resource ceiling */
export const MAX_UI_HTML_BYTES = 10 * 1024 * 1024;

export interface ModelAppToolRegistration<TSchema extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  /** Optional Antigravity surfaces (`aux_pane`, `global`) */
  entrypoints?: readonly AntigravityEntrypoint[];
  /** Defaults to `['model', 'app']` */
  visibility?: readonly ToolVisibilitySurface[];
  /** Per-call execution circuit-breaker timeout (default: 10,000ms) */
  timeoutMs?: number;
  handler: (
    args: z.infer<TSchema>,
    ctx: ServerContext,
  ) => Promise<DualSurfacePayload<Record<string, unknown>>> | DualSurfacePayload<Record<string, unknown>>;
}

export interface AppOnlyToolRegistration<TSchema extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  inputSchema: TSchema;
  timeoutMs?: number;
  handler: (
    args: z.infer<TSchema>,
    ctx: ServerContext,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Slices a UTF-8 string to at most `maxBytes` without splitting a multi-byte UTF-8 codepoint
 * (guarantees zero `\uFFFD` replacement characters on CJK / emoji boundaries).
 */
export function truncateUtf8Clean(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes);
  // Walk back past UTF-8 continuation bytes (10xxxxxx)
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  // Check if `buf[end]` is the start of a multi-byte sequence that would be cut off at `maxBytes`
  if (end < buf.length && end < maxBytes) {
    const lead = buf[end]!;
    const seqLen =
      (lead & 0xf8) === 0xf0 ? 4 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xe0) === 0xc0 ? 2 : 1;
    if (end + seqLen <= maxBytes) {
      end += seqLen;
    }
  }
  return buf.subarray(0, end).toString('utf8');
}

function clampModelText(markdown: string): string {
  const redacted = redactSecretsAndPaths(markdown);
  const byteLen = Buffer.byteLength(redacted, 'utf8');
  if (byteLen <= MAX_MODEL_TEXT_BYTES) {
    return redacted;
  }
  const truncated = truncateUtf8Clean(redacted, MAX_MODEL_TEXT_BYTES - 256);
  return `${truncated}\n\n...[Output truncated at 512 KiB trajectory safety boundary; inspect full data in MCP App UI]...`;
}

/**
 * Enforces the 768 KiB trajectory safety ceiling on combined `content` + `structuredContent`
 * so Antigravity never silently drops `ontoolresult` above its 1 MiB trajectory cap.
 */
export function enforceTrajectoryBudget(
  clampedText: string,
  structuredContent: Record<string, unknown>,
  maxTotalBytes = MAX_TRAJECTORY_TOTAL_BYTES,
): Record<string, unknown> {
  const textBytes = Buffer.byteLength(clampedText, 'utf8');
  const structuredJson = JSON.stringify(structuredContent);
  const totalBytes = textBytes + Buffer.byteLength(structuredJson, 'utf8');
  if (totalBytes <= maxTotalBytes) {
    return structuredContent;
  }
  return {
    _truncatedForTrajectory: true,
    _originalBytes: totalBytes,
    serverVersion: structuredContent.serverVersion,
    generatedAt: structuredContent.generatedAt ?? new Date().toISOString(),
    notice:
      'Initial payload exceeded 768 KiB trajectory safety budget; UI will hydrate full state via app-only tool.',
  };
}

function formatSafeToolError(err: unknown): CallToolResult {
  const rawMsg =
    err instanceof PathGuardError
      ? `[${err.code}] ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  const safeMsg = redactSecretsAndPaths(rawMsg);
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${safeMsg}` }],
    structuredContent: {
      error: safeMsg,
      code: err instanceof PathGuardError ? err.code : 'ERR_INTERNAL',
    },
  };
}

/**
 * Reusable Stdio MCP App Server shell for DiffAtlas and companion Antigravity MCP App plugins.
 *
 * Responsibilities:
 * 1. Serves single-file `ui://` HTML with live env-var hot-reload (e.g., `DIFFATLAS_APP_HTML`).
 * 2. Registers Dual-Surface (`model` + `app`) tools with Antigravity `aux_pane` / `global` entrypoints.
 * 3. Registers `visibility: ["app"]` tools hidden from the LLM (`app_read_chunk`, `app_get_recent_targets`, `app_save_preferences`).
 * 4. Wraps every tool invocation in `withTimeoutCircuitBreaker` + secret/PII output redaction.
 */
export class McpPluginShell {
  public readonly identity: PluginIdentity;
  public readonly paths: PluginRuntimePaths;
  public readonly stateStore: PluginStateStore;
  public readonly server: McpServer;
  private defaultWorkspaceResolver?: () => Promise<string | null> | string | null;
  private cachedHtmlBundle: { path: string; mtimeMs: number; size: number; text: string } | null = null;

  constructor(
    identity: PluginIdentity,
    options?: {
      argv?: readonly string[];
      env?: NodeJS.ProcessEnv;
      fallbackRoot?: string;
    },
  ) {
    this.identity = identity;
    this.paths = resolvePluginRuntimePaths(
      identity,
      options?.argv,
      options?.env,
      options?.fallbackRoot,
    );
    this.stateStore = new PluginStateStore(this.paths.stateDir);
    this.server = new McpServer(
      {
        name: identity.id,
        version: identity.version,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    );

    this.registerUiHtmlResource();
    this.registerSharedAppOnlyTools();
  }

  private registerUiHtmlResource(): void {
    registerAppResource(
      this.server,
      `${this.identity.displayName} Workbench`,
      this.identity.resourceUri,
      {
        description: `Self-contained MCP App UI for ${this.identity.displayName}`,
        mimeType: RESOURCE_MIME_TYPE,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
      async () => {
        const htmlPath = this.paths.defaultAppHtmlPath;
        if (!fs.existsSync(htmlPath)) {
          throw new Error(
            `UI bundle missing at ${redactSecretsAndPaths(htmlPath)}. Run "npm run build" first.`,
          );
        }
        const stat = fs.statSync(htmlPath);
        if (stat.size === 0 || stat.size > MAX_UI_HTML_BYTES) {
          throw new Error(`Invalid UI bundle byte size (${stat.size} bytes).`);
        }
        let htmlText: string;
        if (
          this.cachedHtmlBundle &&
          this.cachedHtmlBundle.path === htmlPath &&
          this.cachedHtmlBundle.mtimeMs === stat.mtimeMs &&
          this.cachedHtmlBundle.size === stat.size
        ) {
          htmlText = this.cachedHtmlBundle.text;
        } else {
          htmlText = fs.readFileSync(htmlPath, 'utf8');
          this.cachedHtmlBundle = { path: htmlPath, mtimeMs: stat.mtimeMs, size: stat.size, text: htmlText };
        }
        return {
          contents: [
            {
              uri: this.identity.resourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: htmlText,
              _meta: {
                ui: {
                  prefersBorder: false,
                },
              },
            },
          ],
        };
      },
    );
  }

  public setDefaultWorkspaceResolver(resolver: () => Promise<string | null> | string | null): void {
    this.defaultWorkspaceResolver = resolver;
  }

  /**
   * Pre-loads the single-file UI HTML into RAM after stdio startup so the first `resources/read`
   * responds in <1ms without blocking initial MCP `initialize` handshake.
   */
  public prewarmUiHtml(): void {
    try {
      const htmlPath = this.paths.defaultAppHtmlPath;
      if (!fs.existsSync(htmlPath)) return;
      const stat = fs.statSync(htmlPath);
      if (stat.size === 0 || stat.size > MAX_UI_HTML_BYTES) return;
      const htmlText = fs.readFileSync(htmlPath, 'utf8');
      this.cachedHtmlBundle = { path: htmlPath, mtimeMs: stat.mtimeMs, size: stat.size, text: htmlText };
    } catch {
      // Best-effort prewarm only
    }
  }

  /**
   * Registers a Dual-Surface tool (model + app) pointing at this plugin's `ui://` resource.
   */
  public registerUiTool<TSchema extends z.ZodType>(reg: ModelAppToolRegistration<TSchema>): void {
    const meta: Record<string, unknown> = {
      ui: {
        resourceUri: this.identity.resourceUri,
        ...(reg.visibility ? { visibility: [...reg.visibility] } : {}),
      },
    };
    if (reg.entrypoints && reg.entrypoints.length > 0) {
      meta['com.google.antigravity/ui'] = {
        entrypoints: reg.entrypoints.map((ep) => ({
          type: ep.type,
          title: ep.title,
        })),
      };
    }

    registerAppTool(
      this.server,
      reg.name,
      {
        title: reg.title,
        description: reg.description,
        inputSchema: reg.inputSchema as StandardSchemaWithJSON,
        _meta: meta as { ui: { resourceUri: string } },
      },
      async (args: unknown, ctx: ServerContext) => {
        try {
          const res = await withTimeoutCircuitBreaker(
            reg.name,
            reg.timeoutMs ?? 10_000,
            async () => await reg.handler(args as z.infer<TSchema>, ctx),
          );
          const clampedText = clampModelText(res.summaryMarkdown);
          const safeStructured = enforceTrajectoryBudget(clampedText, res.structuredContent);
          return {
            isError: res.isError ?? false,
            content: [{ type: 'text', text: clampedText }],
            structuredContent: safeStructured,
          };
        } catch (err) {
          return formatSafeToolError(err);
        }
      },
    );
  }

  /**
   * Registers an App-Only (`visibility: ["app"]`) tool strictly hidden from the LLM.
   */
  public registerAppOnlyTool<TSchema extends z.ZodType>(reg: AppOnlyToolRegistration<TSchema>): void {
    registerAppTool(
      this.server,
      reg.name,
      {
        title: reg.title,
        description: reg.description,
        inputSchema: reg.inputSchema as StandardSchemaWithJSON,
        _meta: {
          ui: {
            resourceUri: this.identity.resourceUri,
            visibility: ['app'],
          },
        },
      },
      async (args: unknown, ctx: ServerContext) => {
        try {
          const structured = await withTimeoutCircuitBreaker(
            reg.name,
            reg.timeoutMs ?? 8_000,
            async () => await reg.handler(args as z.infer<TSchema>, ctx),
          );
          return {
            content: [{ type: 'text', text: 'OK' }],
            structuredContent: structured,
          };
        } catch (err) {
          return formatSafeToolError(err);
        }
      },
    );
  }

  private registerSharedAppOnlyTools(): void {
    this.registerAppOnlyTool({
      name: 'app_read_chunk',
      title: 'Read Safe File Chunk',
      description: 'App-only bounded byte slice reader (utf8 or base64) guarded by PathGuard.',
      inputSchema: z.object({
        workspaceRoot: z.string().optional(),
        targetPath: z.string(),
        byteOffset: z.number().int().min(0).optional(),
        byteLength: z.number().int().min(1).max(512 * 1024).optional(),
        encoding: z.enum(['utf8', 'base64']).optional(),
      }),
      handler: async (args) => {
        const resolvedDefault = this.defaultWorkspaceResolver ? await this.defaultWorkspaceResolver() : null;
        const wsRoot = args.workspaceRoot?.trim() || resolvedDefault || process.cwd();
        const guard = new PathGuard(wsRoot);
        return readSafeFileChunk(guard, {
          workspaceRoot: guard.workspaceRoot,
          targetPath: args.targetPath,
          byteOffset: args.byteOffset,
          byteLength: args.byteLength,
          encoding: args.encoding,
        });
      },
    });

    this.registerAppOnlyTool({
      name: 'app_get_recent_targets',
      title: 'Get Recent Targets & Preferences',
      description: 'App-only state loader for global view startup and persisted UI preferences.',
      inputSchema: z.object({}),
      handler: () => ({
        recentTargets: this.stateStore.getRecentTargets(),
        preferences: this.stateStore.getPreferences(),
      }),
    });

    this.registerAppOnlyTool({
      name: 'app_save_preferences',
      title: 'Save UI Preferences',
      description: 'App-only persistence for theme/tab/layout settings in PLUGIN_DATA.',
      inputSchema: z.object({
        themeOverride: z.enum(['system', 'light', 'dark']).optional(),
        locale: z.enum(['en', 'zh-CN']).optional(),
        activeTab: z.string().max(64).optional(),
        compactMode: z.boolean().optional(),
        previewRatio: z.number().min(20).max(80).optional(),
      }),
      handler: (args) => ({
        preferences: this.stateStore.savePreferences(args),
      }),
    });
  }

  public async startStdio(): Promise<StdioServerTransport> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    return transport;
  }
}
