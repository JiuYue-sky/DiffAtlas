import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@modelcontextprotocol/ext-apps/react';
import type { McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import {
  AppServerClient,
  deriveSurfaceCapabilities,
  syncHostThemeAndStyles,
  type SurfaceCapabilities,
} from './host-bridge.js';

export interface UsePluginShellOptions<TStructured> {
  appName: string;
  appVersion: string;
  onStructuredResult?: (structured: TStructured) => void;
}

export interface PluginShellState<TStructured> {
  isConnected: boolean;
  connectionError: string | null;
  toolError: string | null;
  theme: 'light' | 'dark';
  themeOverride: 'system' | 'light' | 'dark';
  setThemeOverride: (next: 'system' | 'light' | 'dark') => void;
  hostContext: McpUiHostContext | undefined;
  capabilities: SurfaceCapabilities;
  toolInputArgs: Record<string, unknown> | null;
  latestResult: TStructured | null;
  isToolRunning: boolean;
  cancelledReason: string | null;
  client: AppServerClient | null;
  rawApp: ReturnType<typeof useApp>['app'];
}

/**
 * Shared React MCP App lifecycle hook for DiffAtlas and companion Antigravity MCP App plugins.
 * Guarantees:
 * - Event listeners (`toolinput`, `toolresult`, `toolcancelled`, `hostcontextchanged`) are attached BEFORE `connect()`.
 * - Live host theme & style token sync on initial connect and `hostcontextchanged`.
 * - Dynamic capability detection (`updateModelContext`, `message`, `serverTools`).
 */
export function usePluginShell<TStructured extends Record<string, unknown>>(
  options: UsePluginShellOptions<TStructured>,
): PluginShellState<TStructured> {
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>(undefined);
  const [themeOverride, setThemeOverride] = useState<'system' | 'light' | 'dark'>('system');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [toolInputArgs, setToolInputArgs] = useState<Record<string, unknown> | null>(null);
  const [latestResult, setLatestResult] = useState<TStructured | null>(null);
  const [isToolRunning, setIsToolRunning] = useState<boolean>(false);
  const [cancelledReason, setCancelledReason] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);

  const callbackRef = useRef(options.onStructuredResult);
  callbackRef.current = options.onStructuredResult;

  const { app, isConnected, error } = useApp({
    appInfo: {
      name: options.appName,
      version: options.appVersion,
    },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.addEventListener('toolinput', (params) => {
        setIsToolRunning(true);
        setCancelledReason(null);
        setToolError(null);
        setToolInputArgs((params.arguments ?? {}) as Record<string, unknown>);
      });

      createdApp.addEventListener('toolresult', (params) => {
        setIsToolRunning(false);
        if (params.isError) {
          const msg =
            params.content?.find((c) => c.type === 'text' && 'text' in c)?.text ?? 'Tool execution returned an error.';
          setToolError(String(msg));
          return;
        }
        setToolError(null);
        if (params.structuredContent) {
          const typed = params.structuredContent as TStructured;
          setLatestResult(typed);
          callbackRef.current?.(typed);
        }
      });

      createdApp.addEventListener('toolcancelled', (params) => {
        setIsToolRunning(false);
        setCancelledReason(params.reason ?? 'Cancelled by host');
      });

      createdApp.addEventListener('hostcontextchanged', (ctxPatch) => {
        setHostContext((prev) => {
          const mergedStyles =
            prev?.styles || ctxPatch.styles
              ? {
                  ...(prev?.styles ?? {}),
                  ...(ctxPatch.styles ?? {}),
                  ...(prev?.styles?.variables || ctxPatch.styles?.variables
                    ? {
                        variables: {
                          ...(prev?.styles?.variables ?? {}),
                          ...(ctxPatch.styles?.variables ?? {}),
                        },
                      }
                    : {}),
                  ...(prev?.styles?.css || ctxPatch.styles?.css
                    ? {
                        css: {
                          ...(prev?.styles?.css ?? {}),
                          ...(ctxPatch.styles?.css ?? {}),
                        },
                      }
                    : {}),
                }
              : undefined;
          return {
            ...(prev ?? {}),
            ...ctxPatch,
            ...(mergedStyles ? { styles: mergedStyles } : {}),
          } as McpUiHostContext;
        });
      });
    },
  });

  useEffect(() => {
    if (!app || !isConnected) return;
    const initialCtx = app.getHostContext();
    setHostContext(initialCtx);
  }, [app, isConnected]);

  useEffect(() => {
    const applied = syncHostThemeAndStyles(hostContext, themeOverride);
    setTheme(applied);
  }, [hostContext, themeOverride]);

  const capabilities = useMemo(
    () => deriveSurfaceCapabilities(isConnected && app ? app.getHostCapabilities() : undefined),
    [app, isConnected, hostContext],
  );

  const client = useMemo(() => (app && isConnected ? new AppServerClient(app) : null), [app, isConnected]);

  return {
    isConnected,
    connectionError: error ? error.message : null,
    toolError,
    theme,
    themeOverride,
    setThemeOverride,
    hostContext,
    capabilities,
    toolInputArgs,
    latestResult,
    isToolRunning,
    cancelledReason,
    client,
    rawApp: app,
  };
}
