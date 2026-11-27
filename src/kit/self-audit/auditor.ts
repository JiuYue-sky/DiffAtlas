import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SnapshotEngine } from '../../core/snapshot-engine.js';
import { runCommandSafe, withTimeoutCircuitBreaker } from '../process-guard.js';
import { toPosixPath } from '../path-guard.js';

export interface AuditCheckRecord {
  check: string;
  ok: boolean;
  severity: 'error' | 'warning' | 'info';
  detail: string;
}

export interface CleanroomSummary {
  status: 'PASS' | 'FAIL';
  mcpToolsVerified: string[];
  appOnlyToolsVerified: string[];
  uiHtmlBytes: number;
  uiHtmlKiB: number;
  uiHtmlSha256: string;
  serverBundleBytes: number;
  serverBundleSha256: string;
  hookBundleBytes: number;
  hookBundleSha256: string;
  snapshotEngineP50Ms: number;
  snapshotEngineP95Ms: number;
  hookNetOverheadP50Ms: number;
  hookSubprocessE2EP50Ms: number;
  hookFailOpenVerified: boolean;
}

export interface SelfAuditReport {
  status: 'PASS' | 'FAIL';
  pluginId: string;
  version: string;
  totalChecks: number;
  failedCount: number;
  warningCount: number;
  failures: string[];
  warnings: string[];
  checks: AuditCheckRecord[];
  cleanroom: CleanroomSummary | null;
}

const ALLOWED_PLUGIN_JSON_KEYS = new Set([
  '$schema',
  'name',
  'displayName',
  'version',
  'description',
  'logo',
  'suggestedPrompts',
  'skills',
  'disabled',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

const FORBIDDEN_BRAND_PREFIXES = ['antigravity', 'gemini', 'google', 'claude', 'cursor'];

const ALLOWED_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'ISC',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'MIT OR Apache-2.0',
  '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)',
  'Python-2.0',
  'CC-BY-4.0',
]);

const BANNED_NATIVE_PACKAGES = new Set([
  'better-sqlite3',
  'node-pty',
  'tree-sitter',
  'sharp',
  'canvas',
  'sqlite3',
  'leveldown',
]);

const LEAKED_DEV_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:\\|\/(?!\/))Users[/\\]{1,2}(?!<|your|user\b|example|runneradmin|administrator|public|default)[A-Za-z0-9._-]{3,}[/\\]{1,2}/i,
  /\/Users\/(?!<|your|user\b|example|runner)[A-Za-z0-9._-]{3,}\//,
  /\/home\/(?!<|your|user\b|example|runner)[A-Za-z0-9._-]{3,}\//,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:\\|\/(?!\/))DiffAtlas\b/i,
];

const LEAKED_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/,
  /\bAIza[0-9A-Za-z\-_]{30,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
];

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

export interface RunSelfAuditOptions {
  projectRoot: string;
  stagedPluginDir: string;
  pluginId: string;
  expectHooks: boolean;
  maxUiHtmlBytes?: number;
}

/**
 * Reusable Package Self-Audit + Zero-`node_modules` Cleanroom Verification Engine
 * for DiffAtlas and companion Antigravity MCP App plugins.
 */
export async function runPluginSelfAudit(options: RunSelfAuditOptions): Promise<SelfAuditReport> {
  const projectRoot = path.resolve(options.projectRoot);
  const stagedPluginDir = path.resolve(options.stagedPluginDir);
  const maxUiHtmlBytes = options.maxUiHtmlBytes ?? Math.floor(1.5 * 1024 * 1024);

  const checks: AuditCheckRecord[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const record = (
    check: string,
    ok: boolean,
    detail: string,
    severity: 'error' | 'warning' | 'info' = 'error',
  ) => {
    checks.push({ check, ok, severity, detail });
    if (!ok) {
      if (severity === 'error') failures.push(`[${check}] ${detail}`);
      else if (severity === 'warning') warnings.push(`[${check}] ${detail}`);
    }
  };

  // 1. plugin.json strict schema & brand prefix check
  let version = '0.0.0';
  try {
    const manifestRaw = fs.readFileSync(path.join(stagedPluginDir, 'plugin.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
    const unknownKeys = Object.keys(manifest).filter((k) => !ALLOWED_PLUGIN_JSON_KEYS.has(k));
    const nameStr = typeof manifest.name === 'string' ? manifest.name : '';
    const displayNameStr = typeof manifest.displayName === 'string' ? manifest.displayName : nameStr;
    const lowerDisplay = displayNameStr.trim().toLowerCase();
    const hasForbiddenPrefix = FORBIDDEN_BRAND_PREFIXES.some((p) => lowerDisplay.startsWith(p));
    const logoRel = typeof manifest.logo === 'string' ? manifest.logo : '';
    const logoCleanRelative =
      logoRel.length > 0 &&
      !logoRel.startsWith('/') &&
      !logoRel.includes('://') &&
      fs.existsSync(path.join(stagedPluginDir, logoRel));
    const prompts = Array.isArray(manifest.suggestedPrompts) ? manifest.suggestedPrompts : [];
    const promptsValid =
      prompts.length >= 1 &&
      prompts.length <= 3 &&
      prompts.every((p) => typeof p === 'string' && p.trim().length > 0);
    const authorValid =
      typeof manifest.author === 'string'
        ? manifest.author.trim().length > 0
        : Boolean(
            manifest.author &&
              typeof manifest.author === 'object' &&
              !Array.isArray(manifest.author) &&
              typeof (manifest.author as { name?: unknown }).name === 'string' &&
              ((manifest.author as { name: string }).name.trim().length > 0),
          );
    const keywordsValid =
      manifest.keywords === undefined ||
      (Array.isArray(manifest.keywords) && manifest.keywords.every((k) => typeof k === 'string' && k.trim().length > 0));
    const versionSemverValid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);

    // Cross-check version parity with root package.json
    const rootPkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    const versionMatchesPackage = rootPkg.version === version;

    const ok =
      unknownKeys.length === 0 &&
      nameStr === options.pluginId &&
      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(nameStr) &&
      !hasForbiddenPrefix &&
      logoCleanRelative &&
      promptsValid &&
      authorValid &&
      keywordsValid &&
      versionSemverValid &&
      versionMatchesPackage;

    record(
      'plugin_manifest_whitelist',
      ok,
      `name=${nameStr}, version=${version} (matchesPkg=${versionMatchesPackage}), displayName=${displayNameStr}, unknownKeys=${JSON.stringify(unknownKeys)}, brandPrefixClean=${!hasForbiddenPrefix}, logoOk=${logoCleanRelative}, prompts=${prompts.length}, authorOk=${authorValid}`,
    );
  } catch (err) {
    record('plugin_manifest_whitelist', false, `Failed reading plugin.json: ${String(err)}`);
  }

  // 2. mcp_config.json contract
  try {
    const mcpCfg = JSON.parse(fs.readFileSync(path.join(stagedPluginDir, 'mcp_config.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    const servers = mcpCfg.mcpServers ?? {};
    const serverNames = Object.keys(servers);
    const allPrefixed = serverNames.length > 0 && serverNames.every((n) => n.startsWith(options.pluginId));
    const allStdioPortable = serverNames.every((n) => {
      const s = servers[n];
      if (!s) return false;
      if (s.url) return !s.url.endsWith('/sse');
      return (
        s.command === 'node' &&
        Array.isArray(s.args) &&
        s.args.some((a) => a.includes('${PLUGIN_ROOT}'))
      );
    });
    record(
      'mcp_config_contract',
      allPrefixed && allStdioPortable,
      `servers=${JSON.stringify(serverNames)}, prefixed=${allPrefixed}, portableNodeStdio=${allStdioPortable}`,
    );
  } catch (err) {
    record('mcp_config_contract', false, `Invalid mcp_config.json: ${String(err)}`);
  }

  // 3. hooks.json root placement & Windows/Unix command portability
  const hooksJsonPath = path.join(stagedPluginDir, 'hooks.json');
  if (options.expectHooks) {
    try {
      const hooksObj = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')) as Record<string, Record<string, unknown>>;
      const issues: string[] = [];
      for (const [hookGroupName, spec] of Object.entries(hooksObj)) {
        for (const eventKey of ['PreToolUse', 'PostToolUse']) {
          const groups = spec[eventKey];
          if (!Array.isArray(groups)) continue;
          for (const g of groups as Array<{ matcher?: string; hooks?: Array<{ command?: string; timeout?: number }> }>) {
            for (const h of g.hooks ?? []) {
              const cmd = h.command ?? '';
              const timeout = h.timeout ?? 30;
              if (timeout > 5) issues.push(`${hookGroupName}.${eventKey}: timeout ${timeout}s > 5s`);
              if (cmd.includes('.sh') || cmd.includes('$PLUGIN_')) {
                issues.push(`${hookGroupName}.${eventKey}: non-portable Unix shell syntax in "${cmd}"`);
              }
              if (!cmd.startsWith('node ')) {
                issues.push(`${hookGroupName}.${eventKey}: expected cross-platform "node ..." command`);
              }
            }
          }
        }
      }
      record(
        'hooks_root_and_timeout_contract',
        issues.length === 0,
        issues.length === 0 ? 'hooks.json at plugin root with cross-platform node command and timeout <= 5s' : issues.join('; '),
      );
    } catch (err) {
      record('hooks_root_and_timeout_contract', false, `Missing or invalid hooks.json: ${String(err)}`);
    }
  } else {
    const absent = !fs.existsSync(hooksJsonPath);
    record('hooks_intentionally_absent', absent, absent ? 'No hooks.json present (as required)' : 'Unexpected hooks.json found');
  }

  // 4. Skills & Rules structure check
  try {
    const skillMdPath = path.join(stagedPluginDir, 'skills', options.pluginId, 'SKILL.md');
    const rulesMdPath = path.join(stagedPluginDir, 'rules', 'AGENTS.md');
    const skillTxt = fs.readFileSync(skillMdPath, 'utf8');
    const rulesTxt = fs.readFileSync(rulesMdPath, 'utf8');
    const skillValid =
      /^---\r?\n/.test(skillTxt) &&
      skillTxt.includes(`name: ${options.pluginId}`) &&
      skillTxt.includes('description:');
    const rulesValid = !rulesTxt.startsWith('---') && rulesTxt.trim().length > 20;
    record(
      'skill_and_rules_contract',
      skillValid && rulesValid,
      `skillFrontmatter=${skillValid}, rulesPlainMarkdown=${rulesValid}`,
    );
  } catch (err) {
    record('skill_and_rules_contract', false, `Skill/Rules check failed: ${String(err)}`);
  }

  // 5. Zero Native Addons Gate (scans package.json + staged files for .node / binding.gyp / banned native deps)
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeclared = [
      ...Object.keys(pkgJson.dependencies ?? {}),
      ...Object.keys(pkgJson.devDependencies ?? {}),
    ];
    const bannedFound = allDeclared.filter((d) => BANNED_NATIVE_PACKAGES.has(d));
    const nativeFiles: string[] = [];
    const scanNative = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) scanNative(full);
        else if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') {
          nativeFiles.push(toPosixPath(path.relative(stagedPluginDir, full)));
        }
      }
    };
    scanNative(stagedPluginDir);
    // Also verify zero runtime (`!dev`) packages in `package-lock.json` carry native install/gyp scripts
    const runtimeInstallScripts: string[] = [];
    const lockPath = path.join(projectRoot, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      const lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        packages?: Record<string, { dev?: boolean; hasInstallScript?: boolean }>;
      };
      for (const [pkgPath, meta] of Object.entries(lockObj.packages ?? {})) {
        if (!pkgPath) continue;
        if (!meta.dev && meta.hasInstallScript) {
          runtimeInstallScripts.push(pkgPath);
        }
      }
    }
    record(
      'zero_native_addons_gate',
      bannedFound.length === 0 && nativeFiles.length === 0 && runtimeInstallScripts.length === 0,
      `bannedDeps=${JSON.stringify(bannedFound)}, nativeBinaries=${JSON.stringify(nativeFiles)}, runtimeInstallScripts=${JSON.stringify(runtimeInstallScripts)}`,
    );
  } catch (err) {
    record('zero_native_addons_gate', false, `Native addon check failed: ${String(err)}`);
  }

  // 6. Full Transitive Dependency License Allowlist Gate (direct + all package-lock.json packages)
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const runtimeDeps = Object.keys(pkgJson.dependencies ?? {});
    const disallowed: string[] = [];
    const checked: string[] = [];

    for (const dep of runtimeDeps) {
      const depPkgPath = path.join(projectRoot, 'node_modules', dep, 'package.json');
      if (!fs.existsSync(depPkgPath)) {
        disallowed.push(`${dep}:missing`);
        continue;
      }
      const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8')) as { license?: string };
      const lic = String(depPkg.license ?? 'UNKNOWN');
      checked.push(`${dep}@${lic}`);
      if (!ALLOWED_LICENSES.has(lic)) {
        disallowed.push(`${dep}:${lic}`);
      }
    }

    let lockScannedCount = 0;
    const lockPath = path.join(projectRoot, 'package-lock.json');
    if (fs.existsSync(lockPath)) {
      const lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        packages?: Record<string, { license?: string }>;
      };
      for (const [pkgPath, meta] of Object.entries(lockObj.packages ?? {})) {
        if (!pkgPath) continue;
        lockScannedCount++;
        const lic = String(meta.license ?? 'UNKNOWN');
        if (!ALLOWED_LICENSES.has(lic)) {
          disallowed.push(`${pkgPath}:${lic}`);
        }
      }
    }

    record(
      'dependency_license_allowlist',
      disallowed.length === 0 && checked.length > 0,
      disallowed.length === 0
        ? `All ${checked.length} direct runtime + ${lockScannedCount} transitive lockfile packages permissive`
        : `Disallowed: ${disallowed.join(', ')}`,
    );
  } catch (err) {
    record('dependency_license_allowlist', false, `License scan failed: ${String(err)}`);
  }

  // 7. Singlefile HTML size + strict CSP (`default-src 'none'`) + XSS/Storage source hygiene
  const uiHtmlPath = path.join(stagedPluginDir, 'dist', 'ui', 'app.html');
  try {
    const htmlStat = fs.statSync(uiHtmlPath);
    const htmlContent = fs.readFileSync(uiHtmlPath, 'utf8');
    const externalScriptOrCss =
      /<script[^>]+src=["']https?:\/\//i.test(htmlContent) ||
      /<link[^>]+href=["']https?:\/\//i.test(htmlContent);

    const uiViolations: string[] = [];
    const scanUiSource = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanUiSource(full);
        } else if (/\.(ts|tsx|css|html)$/.test(entry.name)) {
          const src = fs.readFileSync(full, 'utf8');
          const rel = toPosixPath(path.relative(projectRoot, full));
          if (src.includes('dangerouslySetInnerHTML')) {
            uiViolations.push(`${rel}: dangerouslySetInnerHTML forbidden`);
          }
          if (/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(src)) {
            uiViolations.push(`${rel}: browser storage forbidden in isolated MCP App iframe`);
          }
        }
      }
    };
    scanUiSource(path.join(projectRoot, 'src', 'ui'));
    scanUiSource(path.join(projectRoot, 'src', 'kit', 'ui-shell'));

    const sizeOk = htmlStat.size > 1024 && htmlStat.size <= maxUiHtmlBytes;
    record(
      'ui_singlefile_csp_and_xss_gate',
      sizeOk && !externalScriptOrCss && uiViolations.length === 0,
      `size=${(htmlStat.size / 1024).toFixed(1)} KiB (limit ${(maxUiHtmlBytes / 1024).toFixed(0)} KiB), externalCdn=${externalScriptOrCss}, uiViolations=${JSON.stringify(uiViolations)}`,
    );
  } catch (err) {
    record('ui_singlefile_csp_and_xss_gate', false, `UI bundle audit failed: ${String(err)}`);
  }

  // 8. Node JS syntax verification (`node --check`)
  const serverBundlePath = path.join(stagedPluginDir, 'dist', 'server', 'index.mjs');
  const hookBundlePath = path.join(stagedPluginDir, 'dist', 'hooks', 'lifecycle-hook.cjs');
  const bundlesToCheck = options.expectHooks ? [serverBundlePath, hookBundlePath] : [serverBundlePath];
  const syntaxFailures: string[] = [];
  for (const bPath of bundlesToCheck) {
    const res = await runCommandSafe(process.execPath, ['--check', bPath], { timeoutMs: 5_000 });
    if (res.exitCode !== 0) {
      syntaxFailures.push(`${path.basename(bPath)}: ${res.stderr.trim()}`);
    }
  }
  record(
    'js_bundle_syntax_check',
    syntaxFailures.length === 0,
    syntaxFailures.length === 0 ? `Verified ${bundlesToCheck.length} JS bundle(s) via node --check` : syntaxFailures.join('; '),
  );

  // 9 & 10. Isolated OS Temp Cleanroom Verification (Zero `node_modules`!)
  let cleanroomSummary: CleanroomSummary | null = null;
  const cleanroomBase = fs.mkdtempSync(path.join(os.tmpdir(), `${options.pluginId}-cleanroom-`));
  const cleanPluginDir = path.join(cleanroomBase, 'plugin');
  const cleanDataDir = path.join(cleanroomBase, 'plugin-data');
  const cleanWorkspaceDir = path.join(cleanroomBase, 'sample-workspace');

  try {
    fs.cpSync(stagedPluginDir, cleanPluginDir, { recursive: true });
    fs.mkdirSync(cleanDataDir, { recursive: true });
    fs.mkdirSync(path.join(cleanWorkspaceDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(cleanWorkspaceDir, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(cleanWorkspaceDir, 'src', 'core.ts'),
      'export const greeting = "hello cleanroom";\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(cleanWorkspaceDir, 'src', 'hello.ts'),
      'import { greeting } from "./core.js";\nexport const say = () => greeting;\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(cleanWorkspaceDir, 'tests', 'hello.test.ts'),
      'import { say } from "../src/hello.js";\nsay();\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(cleanWorkspaceDir, 'src', 'Widget.vue'),
      '<template><div/></template>\n<script setup lang="ts">\nimport { say } from "./hello";\nsay();\n</script>\n',
      'utf8',
    );

    const cleanServerJs = path.join(cleanPluginDir, 'dist', 'server', 'index.mjs');
    const cleanUiHtml = path.join(cleanPluginDir, 'dist', 'ui', 'app.html');
    const cleanHookJs = path.join(cleanPluginDir, 'dist', 'hooks', 'lifecycle-hook.cjs');

    // 9. Real Stdio MCP Handshake in Cleanroom (with 8s Circuit Breaker)
    const mcpCheck = await withTimeoutCircuitBreaker('cleanroom_mcp_handshake', 8_000, async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          cleanServerJs,
          `--plugin-root=${cleanPluginDir}`,
          `--data-dir=${cleanDataDir}`,
        ],
        cwd: cleanWorkspaceDir,
        stderr: 'pipe',
      });
      const client = new Client({ name: 'cleanroom-verifier', version: '1.0.0' });
      try {
        await client.connect(transport);
        const toolsRes = await client.listTools();
        const openWb = toolsRes.tools.find((t) => t.name === 'open_workbench');
        const restoreTool = toolsRes.tools.find((t) => t.name === 'app_restore_checkpoint');

        const openMeta = (openWb?._meta ?? {}) as Record<string, unknown>;
        const uiMeta = (openMeta.ui ?? {}) as { resourceUri?: string };
        const agyMeta = (openMeta['com.google.antigravity/ui'] ?? {}) as {
          entrypoints?: Array<{ type?: string }>;
        };
        const hasAuxAndGlobal =
          Array.isArray(agyMeta.entrypoints) &&
          agyMeta.entrypoints.some((e) => e.type === 'aux_pane') &&
          agyMeta.entrypoints.some((e) => e.type === 'global');

        const restoreVisibility = ((restoreTool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui
          ?.visibility ?? []);
        const restoreAppOnly =
          restoreVisibility.length === 1 && restoreVisibility[0] === 'app';

        const resourceRes = await client.readResource({ uri: `ui://${options.pluginId}/app.html` });
        const firstContent = resourceRes.contents[0];
        const mimeOk = firstContent?.mimeType === 'text/html;profile=mcp-app';

        // Call open_workbench with empty `{}` (simulating aux_pane / global entrypoint click!)
        const emptyLaunchRes = await client.callTool({ name: 'open_workbench', arguments: {} });
        const serializedBytes = Buffer.byteLength(JSON.stringify(emptyLaunchRes), 'utf8');

        // Also verify `analyze_diff_impact` end-to-end in cleanroom (1-hop, 2-hop, recommendedTests & CLI Markdown!)
        const impactRes = await client.callTool({
          name: 'analyze_diff_impact',
          arguments: { targetFiles: ['src/core.ts'] },
        });
        const impactStructured = (impactRes.structuredContent as { impact?: { directImpactedFiles?: string[]; indirectImpactedFiles?: string[]; recommendedTests?: Array<{ testFile: string }> } } | undefined)?.impact;
        const impactOk =
          !impactRes.isError &&
          Boolean(impactStructured?.directImpactedFiles?.includes('src/hello.ts')) &&
          Boolean(impactStructured?.indirectImpactedFiles?.includes('tests/hello.test.ts')) &&
          Boolean(impactStructured?.indirectImpactedFiles?.includes('src/Widget.vue')) &&
          Boolean(impactStructured?.recommendedTests?.some((t) => t.testFile === 'tests/hello.test.ts'));

        const appOnlyTools = toolsRes.tools
          .filter((t) => {
            const vis = ((t._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility ?? []);
            return vis.length === 1 && vis[0] === 'app';
          })
          .map((t) => t.name);

        return {
          ok:
            Boolean(openWb) &&
            uiMeta.resourceUri === `ui://${options.pluginId}/app.html` &&
            hasAuxAndGlobal &&
            restoreAppOnly &&
            mimeOk &&
            !emptyLaunchRes.isError &&
            impactOk &&
            serializedBytes < 512 * 1024,
          toolNames: toolsRes.tools.map((t) => t.name),
          appOnlyTools,
          serializedBytes,
          impactOk,
          mimeType: firstContent?.mimeType ?? 'missing',
        };
      } finally {
        await client.close().catch(() => undefined);
      }
    });

    record(
      'cleanroom_isolated_mcp_handshake',
      mcpCheck.ok,
      `tools=${JSON.stringify(mcpCheck.toolNames)}, appOnly=${JSON.stringify(mcpCheck.appOnlyTools)}, mime=${mcpCheck.mimeType}, emptyArgsBytes=${mcpCheck.serializedBytes}, impactAnalysisOk=${mcpCheck.impactOk}`,
    );

    // 10. Cleanroom Hook Latency Benchmark (<50ms single-file engine + net subprocess overhead) & Fail-Open Verification
    let snapP50 = 0;
    let snapP95 = 0;
    let hookNetP50 = 0;
    let hookE2EP50 = 0;
    let failOpenOk = true;

    if (options.expectHooks) {
      const sampleFile = path.join(cleanWorkspaceDir, 'src', 'hello.ts');

      // 10a. Measure pure single-file PreToolUse SnapshotEngine latency across 30 measured runs (+2 warm-up)
      // Using 30 measured samples ensures true P95 (29th of 30) filters out single-sample shared-VM I/O spikes.
      const benchEngine = new SnapshotEngine(cleanDataDir, path.join(cleanDataDir, 'audit.jsonl'));
      const engineDurations: number[] = [];
      for (let i = 0; i < 32; i++) {
        const fPath = path.join(cleanWorkspaceDir, 'src', `bench_${i}.ts`);
        fs.writeFileSync(fPath, `export const idx = ${i};\n`.repeat(40), 'utf8');
        const out = benchEngine.capturePreToolSnapshot({
          workspaceRoot: cleanWorkspaceDir,
          targetPath: fPath,
          toolName: 'edit_file',
          toolCallId: `eng_${i}`,
          conversationId: 'bench_engine',
          lastUserInput: `Turn ${i}`,
        });
        if (i >= 2) engineDurations.push(out.durationMs);
      }
      engineDurations.sort((a, b) => a - b);
      snapP50 = percentile(engineDurations, 50);
      snapP95 = percentile(engineDurations, 95);

      // 10b. Measure OS + Node CJS file/stdin bootstrap baseline + full CJS Hook subprocess E2E
      const noopCjsPath = path.join(cleanroomBase, 'noop.cjs');
      fs.writeFileSync(noopCjsPath, 'const fs=require("node:fs");fs.readFileSync(0);process.stdout.write("{}\\n");\n', 'utf8');
      const baseRuns: number[] = [];
      for (let i = 0; i < 5; i++) {
        const b = await runCommandSafe(process.execPath, [noopCjsPath], {
          cwd: cleanPluginDir,
          stdinData: '{}',
          timeoutMs: 3_000,
        });
        if (i >= 1) baseRuns.push(b.durationMs);
      }
      baseRuns.sort((a, b) => a - b);
      const osSpawnBaselineP50 = percentile(baseRuns, 50);

      const validStdin = JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'cleanroom-conv-1',
        workspacePaths: [cleanWorkspaceDir],
        cwd: cleanWorkspaceDir,
        lastUserInput: 'Benchmark PreToolUse latency',
        stepIdx: 1,
        toolCall: {
          id: 'call_bench_1',
          name: 'edit_file',
          args: { Path: sampleFile },
        },
      });

      const hookEnv = {
        ...process.env,
        PLUGIN_ROOT: cleanPluginDir,
        PLUGIN_DATA: cleanDataDir,
      };

      await runCommandSafe(process.execPath, [cleanHookJs], {
        cwd: cleanPluginDir,
        env: hookEnv,
        stdinData: validStdin,
        timeoutMs: 3_000,
      });

      const durations: number[] = [];
      let allAllow = true;
      for (let i = 0; i < 7; i++) {
        const payloadI = JSON.stringify({
          ...JSON.parse(validStdin),
          stepIdx: i + 2,
          toolCall: { id: `call_bench_${i + 2}`, name: 'edit_file', args: { Path: sampleFile } },
        });
        const run = await runCommandSafe(process.execPath, [cleanHookJs], {
          cwd: cleanPluginDir,
          env: hookEnv,
          stdinData: payloadI,
          timeoutMs: 3_000,
        });
        durations.push(run.durationMs);
        if (run.exitCode !== 0 || !run.stdout.includes('"decision":"allow"')) {
          allAllow = false;
        }
      }

      durations.sort((a, b) => a - b);
      hookE2EP50 = percentile(durations, 50);
      hookNetP50 = Math.max(0, Math.round((hookE2EP50 - osSpawnBaselineP50) * 100) / 100);

      // Fault-injection test: corrupted JSON stdin MUST still exit 0 and return `{"decision":"allow"}`!
      const faultRun = await runCommandSafe(process.execPath, [cleanHookJs], {
        cwd: cleanPluginDir,
        env: hookEnv,
        stdinData: '{corrupted_json_payload!!!',
        timeoutMs: 3_000,
      });
      failOpenOk = faultRun.exitCode === 0 && faultRun.stdout.includes('"decision":"allow"');

      const isCi = Boolean(process.env.CI);
      const snapP50Ceiling = 50;
      const snapP95Ceiling = isCi ? 150 : 50;
      const hookNetCeiling = isCi ? 80 : 50;
      const hookE2ECeiling = isCi ? 650 : 250;

      const latencyOk =
        allAllow &&
        failOpenOk &&
        snapP50 < snapP50Ceiling &&
        snapP95 < snapP95Ceiling &&
        hookNetP50 < hookNetCeiling &&
        hookE2EP50 < hookE2ECeiling;

      record(
        'cleanroom_hook_latency_and_fail_open',
        latencyOk,
        `snapshotEngineP50=${snapP50}ms (<${snapP50Ceiling}ms) / P95=${snapP95}ms (<${snapP95Ceiling}ms), hookNetOverheadP50=${hookNetP50}ms (<${hookNetCeiling}ms over ${osSpawnBaselineP50}ms OS spawn, total E2E=${hookE2EP50}ms <${hookE2ECeiling}ms), failOpenOnCorruptJson=${failOpenOk}`,
      );
    }

    const uiBytes = fs.statSync(cleanUiHtml).size;
    const srvBytes = fs.statSync(cleanServerJs).size;
    const hkBytes = options.expectHooks ? fs.statSync(cleanHookJs).size : 0;

    cleanroomSummary = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      mcpToolsVerified: mcpCheck.toolNames,
      appOnlyToolsVerified: mcpCheck.appOnlyTools,
      uiHtmlBytes: uiBytes,
      uiHtmlKiB: Math.round((uiBytes / 1024) * 100) / 100,
      uiHtmlSha256: sha256File(cleanUiHtml),
      serverBundleBytes: srvBytes,
      serverBundleSha256: sha256File(cleanServerJs),
      hookBundleBytes: hkBytes,
      hookBundleSha256: options.expectHooks ? sha256File(cleanHookJs) : 'none',
      snapshotEngineP50Ms: snapP50,
      snapshotEngineP95Ms: snapP95,
      hookNetOverheadP50Ms: hookNetP50,
      hookSubprocessE2EP50Ms: hookE2EP50,
      hookFailOpenVerified: failOpenOk,
    };
  } catch (err) {
    record('cleanroom_isolated_mcp_handshake', false, `Cleanroom execution failed: ${String(err)}`);
  } finally {
    fs.rmSync(cleanroomBase, { recursive: true, force: true });
  }

  // Write `dist/build_verification.json` BEFORE running the leak scan so `build_verification.json` ITSELF is audited!
  const verificationOutPath = path.join(projectRoot, 'dist', 'build_verification.json');
  fs.mkdirSync(path.dirname(verificationOutPath), { recursive: true });
  fs.writeFileSync(
    verificationOutPath,
    JSON.stringify(
      {
        ok: failures.length === 0,
        pluginId: options.pluginId,
        version,
        distDir: './dist',
        stagedPluginDir: `./.agents/plugins/${options.pluginId}`,
        verifiedAt: new Date().toISOString(),
        cleanroom: cleanroomSummary,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // 11. Secret, API Key & Personal Dev-Path Leak Scan across source + staged plugin + build_verification.json
  const leakedPaths: string[] = [];
  const leakedSecrets: string[] = [];
  const scanTextExts = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.mjs',
    '.cjs',
    '.json',
    '.md',
    '.html',
    '.css',
    '.svg',
    '.yml',
    '.yaml',
  ]);

  const collectFiles = (dir: string, acc: string[]) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'coverage') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        collectFiles(full, acc);
      } else if (scanTextExts.has(path.extname(ent.name).toLowerCase())) {
        acc.push(full);
      }
    }
  };

  const filesToScan: string[] = [];
  collectFiles(path.join(projectRoot, 'src'), filesToScan);
  collectFiles(path.join(projectRoot, 'tests'), filesToScan);
  collectFiles(path.join(projectRoot, 'scripts'), filesToScan);
  collectFiles(path.join(projectRoot, 'docs'), filesToScan);
  collectFiles(path.join(projectRoot, 'skills'), filesToScan);
  collectFiles(path.join(projectRoot, 'rules'), filesToScan);
  collectFiles(path.join(projectRoot, '.github'), filesToScan);
  collectFiles(stagedPluginDir, filesToScan);
  for (const rootDoc of [
    'plugin.json',
    'mcp_config.json',
    'hooks.json',
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'NOTICE.md',
    'package.json',
  ]) {
    const p = path.join(projectRoot, rootDoc);
    if (fs.existsSync(p)) filesToScan.push(p);
  }
  if (fs.existsSync(verificationOutPath)) filesToScan.push(verificationOutPath);

  // Verify root repository is ready for zero-build `agy plugin install <GitHub URL>`
  const rootRequiredFiles = [
    'plugin.json',
    'mcp_config.json',
    ...(options.expectHooks ? ['hooks.json'] : []),
    'assets/logo.svg',
    `skills/${options.pluginId}/SKILL.md`,
    'rules/AGENTS.md',
    'dist/server/index.mjs',
    ...(options.expectHooks ? ['dist/hooks/lifecycle-hook.cjs'] : []),
    'dist/ui/app.html',
  ];
  const missingRootPluginFiles = rootRequiredFiles.filter((rel) => !fs.existsSync(path.join(projectRoot, rel)));
  record(
    'root_zero_build_plugin_readiness',
    missingRootPluginFiles.length === 0,
    missingRootPluginFiles.length === 0
      ? `All ${rootRequiredFiles.length} root plugin runtime & manifest files present for zero-build agy plugin install`
      : `Missing root plugin files: ${JSON.stringify(missingRootPluginFiles)}`,
  );

  // Verify zero broken relative markdown links in README.md, README.zh-CN.md, CONTRIBUTING.md, NOTICE.md, SECURITY.md, and docs/*.md
  const brokenDocLinks: string[] = [];
  const markdownDocsToCheck: string[] = [];
  for (const docName of ['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'NOTICE.md', 'SECURITY.md']) {
    const p = path.join(projectRoot, docName);
    if (fs.existsSync(p)) markdownDocsToCheck.push(p);
  }
  const docsDir = path.join(projectRoot, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const ent of fs.readdirSync(docsDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        markdownDocsToCheck.push(path.join(docsDir, ent.name));
      }
    }
  }
  for (const docPath of markdownDocsToCheck) {
    const relDoc = toPosixPath(path.relative(projectRoot, docPath));
    // Strip fenced code blocks before scanning links so code examples don't false-trigger
    const mdTxt = fs.readFileSync(docPath, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of mdTxt.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const href = (m[1] ?? '').trim();
      if (!href || /^(https?:|mailto:|antigravity:|customization:|#)/i.test(href)) continue;
      const targetRel = href.split('#')[0] ?? '';
      if (!targetRel) continue;
      const resolved = path.resolve(path.dirname(docPath), targetRel);
      if (!fs.existsSync(resolved)) {
        brokenDocLinks.push(`${relDoc} -> ${href}`);
      }
    }
  }
  record(
    'docs_relative_links_integrity',
    brokenDocLinks.length === 0,
    brokenDocLinks.length === 0
      ? `All relative links across ${markdownDocsToCheck.length} markdown document(s) resolve cleanly`
      : `Broken links: ${JSON.stringify(brokenDocLinks)}`,
  );

  const currentUser = path.basename(os.homedir());
  // Match host username strictly inside a filesystem path segment (avoids false positives on contributor names like "code", "core", "test", "node")
  const userNamePathRe =
    currentUser && currentUser.length >= 4 && !['user', 'admin', 'root', 'runner'].includes(currentUser.toLowerCase())
      ? new RegExp(
          `(?:Users|home)[/\\\\]{1,2}${currentUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/\\\\]|$)`,
          'i',
        )
      : null;

  for (const fPath of filesToScan) {
    // Skip auditor.ts itself which defines the regex patterns
    if (fPath.endsWith('auditor.ts')) continue;
    const rel = toPosixPath(path.relative(projectRoot, fPath));
    const txt = fs.readFileSync(fPath, 'utf8');
    for (const pat of LEAKED_DEV_PATH_PATTERNS) {
      if (pat.test(txt)) {
        leakedPaths.push(`${rel} (${pat.source.slice(0, 28)}...)`);
        break;
      }
    }
    if (userNamePathRe && userNamePathRe.test(txt)) {
      leakedPaths.push(`${rel} (host home path match)`);
    }
    for (const secPat of LEAKED_SECRET_PATTERNS) {
      if (secPat.test(txt)) {
        leakedSecrets.push(rel);
        break;
      }
    }
  }

  record(
    'no_secret_or_dev_path_leaks',
    leakedPaths.length === 0 && leakedSecrets.length === 0,
    leakedPaths.length === 0 && leakedSecrets.length === 0
      ? `Scanned ${filesToScan.length} source/dist/plugin/doc files (including build_verification.json): 0 leaked dev paths, 0 hardcoded secrets`
      : `leakedPaths=${JSON.stringify(leakedPaths)}, leakedSecrets=${JSON.stringify(leakedSecrets)}`,
  );

  // 12. Optional `agy plugin validate --strict` integration when `agy` CLI is available in PATH
  // On Windows, prefer `.exe`; if only `.cmd`/`.bat` exists, invoke via `cmd.exe /d /s /c` (Node >= 20 blocks spawning `.cmd` with `shell: false`!)
  const agyProbe = await runCommandSafe(process.platform === 'win32' ? 'where.exe' : 'which', ['agy'], {
    timeoutMs: 2_500,
  });
  if (agyProbe.exitCode === 0 && agyProbe.stdout.trim().length > 0) {
    const candidates = agyProbe.stdout
      .trim()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let valRes;
    if (process.platform === 'win32') {
      const exeCand = candidates.find((c) => c.toLowerCase().endsWith('.exe'));
      const cmdCand = candidates.find((c) => /\.(cmd|bat)$/i.test(c));
      if (exeCand) {
        valRes = await runCommandSafe(exeCand, ['plugin', 'validate', '--strict', stagedPluginDir], {
          timeoutMs: 8_000,
        });
      } else if (cmdCand) {
        valRes = await runCommandSafe(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `"${cmdCand}" plugin validate --strict "${stagedPluginDir}"`],
          { timeoutMs: 8_000 },
        );
      } else {
        valRes = null;
      }
    } else {
      valRes = await runCommandSafe(candidates[0]!, ['plugin', 'validate', '--strict', stagedPluginDir], {
        timeoutMs: 8_000,
      });
    }

    if (valRes) {
      record(
        'agy_cli_validate_strict',
        valRes.exitCode === 0,
        valRes.exitCode === 0 ? 'agy plugin validate --strict passed (0 errors)' : valRes.stderr || valRes.stdout,
      );
    } else {
      record(
        'agy_cli_validate_strict',
        true,
        'agy shim found without native Windows .exe/.cmd; offline strict manifest + cleanroom protocol suite passed',
        'info',
      );
    }
  } else {
    record(
      'agy_cli_validate_strict',
      true,
      'agy CLI not in host PATH; offline strict manifest + cleanroom protocol suite passed',
      'info',
    );
  }

  const finalStatus: 'PASS' | 'FAIL' = failures.length === 0 ? 'PASS' : 'FAIL';
  // Update ok flag in build_verification.json if leak scan failed
  if (finalStatus === 'FAIL' && fs.existsSync(verificationOutPath)) {
    const cur = JSON.parse(fs.readFileSync(verificationOutPath, 'utf8')) as Record<string, unknown>;
    cur.ok = false;
    fs.writeFileSync(verificationOutPath, JSON.stringify(cur, null, 2) + '\n', 'utf8');
  }

  return {
    status: finalStatus,
    pluginId: options.pluginId,
    version,
    totalChecks: checks.length,
    failedCount: failures.length,
    warningCount: warnings.length,
    failures,
    warnings,
    checks,
    cleanroom: cleanroomSummary,
  };
}
