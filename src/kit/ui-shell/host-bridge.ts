import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type App,
  type McpUiHostCapabilities,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { z } from 'zod';
import { BoundedConcurrencyQueue, MAX_APP_CONCURRENT_REQUESTS } from '../concurrency-queue.js';
import type { ChunkEncoding, ChunkSliceResponse } from '../types.js';

const ToggleAuxPaneResultSchema = z
  .object({
    isError: z.boolean().optional(),
  })
  .passthrough();

export interface SurfaceCapabilities {
  canCallServerTools: boolean;
  canUpdateModelContext: boolean;
  canSendMessage: boolean;
  canOpenExternalLinks: boolean;
  /** Heuristic: `global` sidebar surface lacks conversation capabilities (`message` & `updateModelContext`) */
  isConversationSurface: boolean;
}

export function deriveSurfaceCapabilities(caps: McpUiHostCapabilities | undefined): SurfaceCapabilities {
  const canCallServerTools = Boolean(caps?.serverTools);
  const canUpdateModelContext = Boolean(caps?.updateModelContext);
  const canSendMessage = Boolean(caps?.message);
  const canOpenExternalLinks = Boolean(caps?.openLinks);
  return {
    canCallServerTools,
    canUpdateModelContext,
    canSendMessage,
    canOpenExternalLinks,
    isConversationSurface: canUpdateModelContext || canSendMessage,
  };
}

/**
 * Applies Antigravity / MCP Apps host theme, CSS variables, and fonts onto `document.documentElement`.
 */
export function syncHostThemeAndStyles(
  ctx: McpUiHostContext | undefined,
  themeOverride?: 'system' | 'light' | 'dark',
): 'light' | 'dark' {
  const mode = themeOverride ?? 'system';
  const effectiveTheme: 'light' | 'dark' =
    mode !== 'system'
      ? mode
      : ctx?.theme === 'light'
        ? 'light'
        : 'dark';

  applyDocumentTheme(effectiveTheme);
  document.documentElement.setAttribute('data-theme', effectiveTheme);
  document.documentElement.setAttribute('data-theme-override', mode);

  if (ctx?.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx?.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  return effectiveTheme;
}

export interface NativeFileViewResult {
  openedNative: boolean;
  fallbackReason?: 'host_returned_error' | 'method_not_supported' | 'not_connected';
  detail?: string;
}

/**
 * Invokes Antigravity's `com.google.antigravity/toggle-aux-pane` extension (`tabType: "fileView"`),
 * gracefully degrading on `global` views (`isError: true`) and third-party MCP hosts (`-32601`).
 */
export async function openNativeFileView(app: App | null, fileUri: string): Promise<NativeFileViewResult> {
  if (!app) {
    return { openedNative: false, fallbackReason: 'not_connected', detail: 'App bridge is not connected.' };
  }
  try {
    const result = await app.request(
      {
        method: 'com.google.antigravity/toggle-aux-pane',
        params: {
          tabType: 'fileView',
          uri: fileUri,
        },
      },
      ToggleAuxPaneResultSchema,
    );
    if (result?.isError) {
      return {
        openedNative: false,
        fallbackReason: 'host_returned_error',
        detail: 'Current view has no side pane (e.g. Global Sidebar view); showing inline preview instead.',
      };
    }
    return { openedNative: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      openedNative: false,
      fallbackReason: 'method_not_supported',
      detail: message.includes('-32601')
        ? 'Host does not implement toggle-aux-pane (-32601); showing inline preview instead.'
        : `Native fileView unavailable (${message}); showing inline preview instead.`,
    };
  }
}

/**
 * Shared client wrapper around `app.callServerTool` enforcing `<= 3` concurrent in-flight requests
 * and supporting multi-chunk reassembly for both UTF-8 text and binary assets.
 */
export class AppServerClient {
  private readonly app: App;
  private readonly queue = new BoundedConcurrencyQueue(MAX_APP_CONCURRENT_REQUESTS);

  constructor(app: App) {
    this.app = app;
  }

  public async callTool<T extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<{ ok: boolean; data?: T; error?: string }> {
    return this.queue.run(async () => {
      try {
        const res = await this.app.callServerTool(
          { name, arguments: args },
          { timeout: timeoutMs },
        );
        if (res.isError) {
          const errText =
            res.content?.find((c) => c.type === 'text' && 'text' in c)?.text ?? 'Server tool returned error';
          return { ok: false, error: String(errText) };
        }
        return {
          ok: true,
          data: (res.structuredContent ?? {}) as T,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  /**
   * Streams a large file across bounded `app_read_chunk` slices (`<= 3` concurrent calls).
   */
  public async readFileChunked(params: {
    workspaceRoot?: string;
    targetPath: string;
    encoding?: ChunkEncoding;
    maxTotalBytes?: number;
  }): Promise<{ ok: boolean; text?: string; bytes?: Uint8Array; totalBytes?: number; truncated?: boolean; error?: string }> {
    const requestedEncoding = params.encoding ?? 'utf8';
    const maxTotalBytes = params.maxTotalBytes ?? 2 * 1024 * 1024;
    const sliceSize = 256 * 1024;
    // Always fetch wire slices as exact base64 bytes so multi-byte UTF-8 characters (e.g. CJK/emoji)
    // split across a 256 KiB chunk boundary are decoded once cleanly via TextDecoder with zero mojibake!
    const wireEncoding: ChunkEncoding = 'base64';

    const first = await this.callTool<ChunkSliceResponse>('app_read_chunk', {
      workspaceRoot: params.workspaceRoot,
      targetPath: params.targetPath,
      byteOffset: 0,
      byteLength: sliceSize,
      encoding: wireEncoding,
    });

    if (!first.ok || !first.data) {
      return { ok: false, error: first.error ?? 'Failed to read initial chunk.' };
    }

    const totalBytes = first.data.totalBytes;
    const targetReadBytes = Math.min(totalBytes, maxTotalBytes);
    const slices: ChunkSliceResponse[] = [first.data];

    if (!first.data.eof && first.data.byteLength < targetReadBytes) {
      const offsets: number[] = [];
      for (let offset = first.data.byteLength; offset < targetReadBytes; offset += sliceSize) {
        offsets.push(offset);
      }
      const rest = await Promise.all(
        offsets.map((offset) =>
          this.callTool<ChunkSliceResponse>('app_read_chunk', {
            workspaceRoot: params.workspaceRoot,
            targetPath: params.targetPath,
            byteOffset: offset,
            byteLength: Math.min(sliceSize, targetReadBytes - offset),
            encoding: wireEncoding,
          }),
        ),
      );
      for (const r of rest) {
        if (!r.ok || !r.data) {
          return { ok: false, error: r.error ?? 'Chunk transfer interrupted.' };
        }
        slices.push(r.data);
      }
    }

    slices.sort((a, b) => a.byteOffset - b.byteOffset);

    const decodedParts = slices.map((s) => {
      const binStr = atob(s.data);
      const arr = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) {
        arr[i] = binStr.charCodeAt(i);
      }
      return arr;
    });
    const combinedLen = decodedParts.reduce((acc, p) => acc + p.byteLength, 0);
    const merged = new Uint8Array(combinedLen);
    let cursor = 0;
    for (const part of decodedParts) {
      merged.set(part, cursor);
      cursor += part.byteLength;
    }

    if (requestedEncoding === 'utf8') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
      return {
        ok: true,
        text,
        totalBytes,
        truncated: totalBytes > maxTotalBytes,
      };
    }

    return {
      ok: true,
      bytes: merged,
      totalBytes,
      truncated: totalBytes > maxTotalBytes,
    };
  }
}
