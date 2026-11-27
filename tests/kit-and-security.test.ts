import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitignoreMatcher } from '../src/core/gitignore.js';
import {
  BoundedConcurrencyQueue,
  PathGuard,
  PathGuardError,
  PluginStateStore,
  appendAuditLogSync,
  enforceTrajectoryBudget,
  readSafeFileChunk,
  redactSecretsAndPaths,
  runCommandSafe,
  toFileUri,
  truncateUtf8Clean,
} from '../src/kit/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('PathGuard Security Boundary (OWASP MCP Hardening)', () => {
  it('resolves valid existing & non-existent paths including Unicode/Chinese & spaces', () => {
    const ws = makeTempDir('da-ws-中文 空格-');
    const subDir = path.join(ws, '模块 A');
    fs.mkdirSync(subDir, { recursive: true });
    const fileAbs = path.join(subDir, '示例 文件.ts');
    fs.writeFileSync(fileAbs, 'export const x = 42;\n', 'utf8');

    const guard = new PathGuard(ws);
    const existing = guard.resolvePath('模块 A/示例 文件.ts');
    expect(existing.exists).toBe(true);
    expect(existing.relativePath).toBe('模块 A/示例 文件.ts');

    const futureFile = guard.resolvePath('模块 A/新建子目录/new_file.ts');
    expect(futureFile.exists).toBe(false);
    expect(futureFile.relativePath).toBe('模块 A/新建子目录/new_file.ts');

    const uri = toFileUri(existing.absolutePath);
    expect(uri.startsWith('file:///')).toBe(true);
    expect(uri).toContain('%E6%A8%A1%E5%9D%97%20A');
  });

  it('blocks ../ path traversal, NUL bytes, control chars, and external URIs', () => {
    const ws = makeTempDir('da-ws-sec-');
    const guard = new PathGuard(ws);

    expect(() => guard.resolvePath('../../etc/passwd')).toThrowError(PathGuardError);
    try {
      guard.resolvePath('../../outside.txt');
    } catch (e) {
      expect((e as PathGuardError).code).toBe('ERR_OUTSIDE_WORKSPACE');
    }

    try {
      guard.resolvePath('src/foo\0.ts');
    } catch (e) {
      expect((e as PathGuardError).code).toBe('ERR_NUL_BYTE');
    }

    try {
      guard.resolvePath('https://evil.example.com/payload.js');
    } catch (e) {
      expect((e as PathGuardError).code).toBe('ERR_EXTERNAL_URI_BLOCKED');
    }

    // Subresource SSRF protection (reusable kit helper for .gltf external buffers/assets)
    expect(guard.validateSubresourceUri('data:application/octet-stream;base64,AAAA').kind).toBe('data-uri');
    expect(() => guard.validateSubresourceUri('https://evil.example.com/mesh.bin')).toThrowError(PathGuardError);

    // Unencoded '%' in local asset filename (e.g. `100%_roughness.png`) MUST NOT throw raw URIError!
    fs.writeFileSync(path.join(ws, '100%_roughness.png'), 'PNG', 'utf8');
    const pctRes = guard.validateSubresourceUri('100%_roughness.png');
    expect(pctRes.kind).toBe('local-file');

    // Windows reserved device names (CON, AUX.ts, NUL, COM1) MUST be blocked cross-platform
    for (const badDev of ['CON', 'src/AUX.ts', 'NUL.txt', 'nested/LPT1']) {
      expect(() => guard.resolvePath(badDev)).toThrowError(PathGuardError);
    }

    // Legal filenames starting with `..` (e.g. `..config.ts`) inside workspace MUST NOT be falsely rejected!
    fs.writeFileSync(path.join(ws, '..config.ts'), 'export const cfg = true;\n', 'utf8');
    const dotDotFile = guard.resolvePath('..config.ts');
    expect(dotDotFile.exists).toBe(true);
    expect(dotDotFile.relativePath).toBe('..config.ts');
  });

  it('blocks symlink / junction escape pointing outside workspace', () => {
    const ws = makeTempDir('da-ws-link-');
    const outside = makeTempDir('da-outside-secret-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOP_SECRET', 'utf8');

    const linkDir = path.join(ws, 'escaped-dir');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(outside, linkDir, linkType);

    const guard = new PathGuard(ws);
    let caught: PathGuardError | null = null;
    try {
      guard.resolvePath('escaped-dir/secret.txt');
    } catch (err) {
      caught = err as PathGuardError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('ERR_SYMLINK_ESCAPE');

    // Also block creating a new file through an escaping directory junction!
    let caughtNew: PathGuardError | null = null;
    try {
      guard.resolvePath('escaped-dir/brand-new.txt');
    } catch (err) {
      caughtNew = err as PathGuardError;
    }
    expect(caughtNew).not.toBeNull();
    expect(caughtNew?.code).toBe('ERR_SYMLINK_ESCAPE');
  });

  it('blocks sensitive files (.git/** internals, .env*, *.pem, *.key, .ssh/*) by default', () => {
    const ws = makeTempDir('da-ws-sens-');
    fs.mkdirSync(path.join(ws, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.env'), 'API_KEY=123', 'utf8');
    fs.writeFileSync(path.join(ws, '.env.production'), 'API_KEY=456', 'utf8');
    fs.writeFileSync(path.join(ws, 'server.key'), 'KEY', 'utf8');
    fs.writeFileSync(path.join(ws, '.ssh', 'config'), 'Host *', 'utf8');
    fs.writeFileSync(path.join(ws, '.git', 'config'), '[remote "origin"]', 'utf8');
    fs.writeFileSync(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main', 'utf8');
    fs.writeFileSync(path.join(ws, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho hi', 'utf8');

    fs.mkdirSync(path.join(ws, '.kube'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.kube', 'config'), 'apiVersion: v1', 'utf8');
    fs.writeFileSync(path.join(ws, '.git-credentials'), 'https://u:p@example.com', 'utf8');
    fs.writeFileSync(path.join(ws, 'app_secrets.yaml'), 'token: 123', 'utf8');
    fs.writeFileSync(path.join(ws, 'credentials.json'), '{"key":"123"}', 'utf8');
    fs.writeFileSync(path.join(ws, 'gcp-service-account.json'), '{"type":"service_account"}', 'utf8');

    const guard = new PathGuard(ws);
    for (const target of [
      '.env',
      '.env.production',
      'server.key',
      '.ssh/config',
      '.kube/config',
      '.git-credentials',
      'app_secrets.yaml',
      'credentials.json',
      'gcp-service-account.json',
      '.git/config',
      '.git/HEAD',
      '.git/hooks/pre-commit',
    ]) {
      expect(() => guard.resolvePath(target)).toThrowError(PathGuardError);
    }
  });

  it('neutralizes malicious .gitignore ReDoS backtracking and malformed [z-a] character classes', () => {
    const ws = makeTempDir('da-ws-redos-');
    fs.writeFileSync(
      path.join(ws, '.gitignore'),
      [
        '**/**/**/**/**/**/**/**/**/**/target_never_matches',
        '[z-a]malformed_range',
        '*.secretlog',
      ].join('\n'),
      'utf8',
    );
    const t0 = performance.now();
    const matcher = new GitignoreMatcher(ws);
    const probePath = `${'a/'.repeat(60)}file.ts`;
    expect(matcher.isIgnored(probePath, false)).toBe(false);
    // Malformed `[z-a]` line MUST be skipped cleanly without breaking subsequent valid rules!
    expect(matcher.isIgnored('debug.secretlog', false)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(100);
  });

  it('enforces 768 KiB trajectory budget so CallToolResult never hits the 1 MiB host drop cap', () => {
    const small = enforceTrajectoryBudget('ok', { items: [1, 2, 3] });
    expect(small._truncatedForTrajectory).toBeUndefined();

    const huge = enforceTrajectoryBudget('summary', {
      serverVersion: '0.1.0',
      blob: 'x'.repeat(900 * 1024),
    });
    expect(huge._truncatedForTrajectory).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeLessThan(2048);
  });

  it('redacts API tokens, private keys, personal home paths, rotates audit.jsonl, and truncates UTF-8 cleanly', () => {
    const fakeGitHub = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
    const fakeOpenAi = 'sk-proj-' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';
    const fakeHomeWin = 'C:\\Users\\' + 'johndoe\\project';
    const input = `Token1=${fakeGitHub} Token2=${fakeOpenAi} Path=${fakeHomeWin}`;
    const scrubbed = redactSecretsAndPaths(input);
    expect(scrubbed).not.toContain(fakeGitHub);
    expect(scrubbed).not.toContain(fakeOpenAi);
    expect(scrubbed).not.toContain('johndoe');
    expect(scrubbed).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(scrubbed).toContain('[REDACTED_API_KEY]');

    // Regression: redactPersonalPaths MUST NOT swallow trailing words after a space in Windows error messages
    const sentenceWithWinPath = redactSecretsAndPaths('Path C:\\Users\\alice has failed validation');
    expect(sentenceWithWinPath).toContain('<USER_HOME>');
    expect(sentenceWithWinPath).toContain('has failed validation');
    expect(sentenceWithWinPath).not.toContain('alice');

    // Clean UTF-8 byte boundary truncation across 3-byte CJK and 4-byte emoji sequences
    const utf8Sample = '严守边界🚀零乱码测试';
    for (let cap = 1; cap <= Buffer.byteLength(utf8Sample, 'utf8'); cap++) {
      const sliced = truncateUtf8Clean(utf8Sample, cap);
      expect(Buffer.byteLength(sliced, 'utf8')).toBeLessThanOrEqual(cap);
      expect(sliced).not.toContain('\uFFFD');
    }

    // Bounded audit.jsonl rotation + plugin staging path exclusion from Recent Workspaces
    const stateRoot = makeTempDir('da-state-rot-');
    const auditPath = path.join(stateRoot, 'audit.jsonl');
    for (let i = 0; i < 6; i++) {
      appendAuditLogSync(
        auditPath,
        { event: `evt_${i}`, actor: 'system', detail: { pad: 'x'.repeat(80), p: fakeHomeWin } },
        240,
      );
    }
    expect(fs.existsSync(auditPath)).toBe(true);
    expect(fs.existsSync(`${auditPath}.1`)).toBe(true);
    expect(fs.readFileSync(auditPath, 'utf8')).not.toContain('johndoe');

    const store = new PluginStateStore(stateRoot);
    store.recordRecentTarget(path.join(stateRoot, '.agents', 'plugins', 'diffatlas'), 'workspace');
    expect(store.getRecentTargets().length).toBe(0);
    store.recordRecentTarget(stateRoot, 'workspace');
    expect(store.getRecentTargets().length).toBe(1);

    const savedPrefs = store.savePreferences({ locale: 'zh-CN', themeOverride: 'dark', previewRatio: 58 });
    expect(savedPrefs.locale).toBe('zh-CN');
    expect(savedPrefs.previewRatio).toBe(58);
    expect(store.getPreferences().locale).toBe('zh-CN');
    expect(store.getPreferences().previewRatio).toBe(58);
  });
});

describe('Chunk Channel & Process Circuit Breaker', () => {
  it('reads binary and utf8 chunks accurately and enforces <= 3 concurrency', async () => {
    const ws = makeTempDir('da-chunk-');
    const payload = Buffer.alloc(100_000, 0xab);
    fs.writeFileSync(path.join(ws, 'asset.glb'), payload);
    const guard = new PathGuard(ws);

    const slice1 = readSafeFileChunk(guard, {
      targetPath: 'asset.glb',
      byteOffset: 0,
      byteLength: 40_000,
      encoding: 'base64',
    });
    expect(slice1.byteLength).toBe(40_000);
    expect(slice1.eof).toBe(false);
    expect(Buffer.from(slice1.data, 'base64').equals(payload.subarray(0, 40_000))).toBe(true);

    const queue = new BoundedConcurrencyQueue(3);
    let peak = 0;
    let active = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        queue.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 15));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('trips watchdog circuit breaker and kills hanging child processes without stalling', async () => {
    const res = await runCommandSafe(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 250 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.durationMs).toBeLessThan(2_500);
  });

  it('survives child early-exit EPIPE on large stdin and reassembles split multi-byte UTF-8 chunks without mojibake', async () => {
    const epipeRes = await runCommandSafe(process.execPath, ['-e', 'process.exit(0)'], {
      stdinData: 'X'.repeat(512 * 1024),
      timeoutMs: 3_000,
    });
    expect(epipeRes.exitCode).toBe(0);

    // Multi-byte UTF-8 safety: split right across a 3-byte Chinese character boundary (7 bytes)
    const ws = makeTempDir('da-utf8-split-');
    const chineseText = '测试中文多字节分片零乱码🚀验证';
    fs.writeFileSync(path.join(ws, 'zh.txt'), chineseText, 'utf8');
    const guard = new PathGuard(ws);
    const total = Buffer.byteLength(chineseText, 'utf8');
    const parts: Buffer[] = [];
    for (let offset = 0; offset < total; offset += 7) {
      const ch = readSafeFileChunk(guard, {
        targetPath: 'zh.txt',
        byteOffset: offset,
        byteLength: 7,
        encoding: 'base64',
      });
      parts.push(Buffer.from(ch.data, 'base64'));
    }
    const decoded = new TextDecoder('utf-8').decode(Buffer.concat(parts));
    expect(decoded).toBe(chineseText);
    expect(decoded).not.toContain('\uFFFD');
  });
});
