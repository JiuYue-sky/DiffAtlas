import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SnapshotEngine } from '../src/core/snapshot-engine.js';
import { runCommandSafe } from '../src/kit/process-guard.js';

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

describe('Snapshot & Rollback State Machine (SnapEngine)', () => {
  it('preserves first pre-state across multi-step edits in a single turn and restores cleanly with Undo-of-Undo backup', () => {
    const ws = makeTempDir('da-snap-ws-');
    const dataDir = makeTempDir('da-snap-data-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'));

    const targetFile = path.join(ws, 'service.ts');
    fs.writeFileSync(targetFile, 'export const version = 1;\n', 'utf8');

    // Edit #1 in Turn A
    const pre1 = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: targetFile,
      toolName: 'edit_file',
      toolCallId: 'call_1',
      conversationId: 'conv_a',
      lastUserInput: 'Upgrade service twice',
    });
    expect(pre1.captured).toBe(true);
    fs.writeFileSync(targetFile, 'export const version = 2;\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: targetFile,
      toolName: 'edit_file',
      toolCallId: 'call_1',
      conversationId: 'conv_a',
      lastUserInput: 'Upgrade service twice',
    });

    // Edit #2 in the SAME Turn A (`version = 2 -> version = 3`)
    engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: targetFile,
      toolName: 'edit_file',
      toolCallId: 'call_2',
      conversationId: 'conv_a',
      lastUserInput: 'Upgrade service twice',
    });
    fs.writeFileSync(targetFile, 'export const version = 3;\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: targetFile,
      toolName: 'edit_file',
      toolCallId: 'call_2',
      conversationId: 'conv_a',
      lastUserInput: 'Upgrade service twice',
    });

    const cps = engine.listCheckpoints(ws);
    expect(cps.length).toBe(1);

    const preview = engine.previewRollback(ws, cps[0]!.id);
    expect(preview?.canRestoreCleanly).toBe(true);
    expect(preview?.files[0]?.disposition).toBe('READY_CLEAN_RESTORE');

    const res = engine.restoreCheckpoint(ws, cps[0]!.id);
    expect(res.status).toBe('RESTORED');
    expect(res.backupCheckpointId).toBeTruthy();
    // Must restore all the way back to version = 1 (NOT version = 2!)
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('export const version = 1;\n');

    // Undo-of-Undo: restoring the generated backup checkpoint brings back version = 3!
    const undoRes = engine.restoreCheckpoint(ws, res.backupCheckpointId!);
    expect(undoRes.status).toBe('RESTORED');
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('export const version = 3;\n');
  });

  it('handles newly created files (existedBefore: false) by safely backing up then deleting on rollback', () => {
    const ws = makeTempDir('da-snap-new-');
    const dataDir = makeTempDir('da-snap-newdata-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'));

    const createdFile = path.join(ws, 'generated.ts');
    // PreToolUse runs BEFORE write_file creates `generated.ts`
    const pre = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: createdFile,
      toolName: 'write_file',
      toolCallId: 'call_new',
      conversationId: 'conv_new',
      lastUserInput: 'Create generated.ts',
    });
    expect(pre.captured).toBe(true);

    fs.writeFileSync(createdFile, 'export const created = true;\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: createdFile,
      toolName: 'write_file',
      toolCallId: 'call_new',
      conversationId: 'conv_new',
      lastUserInput: 'Create generated.ts',
    });

    const cpId = pre.checkpointId!;
    const preview = engine.previewRollback(ws, cpId);
    expect(preview?.files[0]?.disposition).toBe('READY_CLEAN_DELETE_CREATED');

    const restored = engine.restoreCheckpoint(ws, cpId);
    expect(restored.status).toBe('RESTORED');
    expect(fs.existsSync(createdFile)).toBe(false);

    // Undo-of-Undo recovers the deleted created file!
    engine.restoreCheckpoint(ws, restored.backupCheckpointId!);
    expect(fs.existsSync(createdFile)).toBe(true);
    expect(fs.readFileSync(createdFile, 'utf8')).toBe('export const created = true;\n');
  });

  it('supports single-file partial rollback (onlyPaths echo) and prunes newly-created empty directories cleanly', () => {
    const ws = makeTempDir('da-snap-partial-');
    const dataDir = makeTempDir('da-snap-partialdata-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'));

    const fileA = path.join(ws, 'a.ts');
    const fileB = path.join(ws, 'b.ts');
    const nestedCreated = path.join(ws, 'src', 'new_feature', 'deep', 'created.ts');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(fileA, 'a_v1\n', 'utf8');
    fs.writeFileSync(fileB, 'b_v1\n', 'utf8');

    // Same turn touches a.ts, b.ts, and creates src/new_feature/deep/created.ts
    const cp = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: fileA,
      toolName: 'edit_file',
      toolCallId: 'p1',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });
    fs.writeFileSync(fileA, 'a_v2\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: fileA,
      toolName: 'edit_file',
      toolCallId: 'p1',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });

    engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: fileB,
      toolName: 'edit_file',
      toolCallId: 'p2',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });
    fs.writeFileSync(fileB, 'b_v2\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: fileB,
      toolName: 'edit_file',
      toolCallId: 'p2',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });

    engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: nestedCreated,
      toolName: 'write_file',
      toolCallId: 'p3',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });
    fs.mkdirSync(path.dirname(nestedCreated), { recursive: true });
    fs.writeFileSync(nestedCreated, 'new_code\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: nestedCreated,
      toolName: 'write_file',
      toolCallId: 'p3',
      conversationId: 'conv_p',
      lastUserInput: 'Multi-file edit',
    });

    // 1. Single-file preview & restore ONLY `a.ts` -> `b.ts` and `created.ts` MUST stay at v2!
    const prevA = engine.previewRollback(ws, cp.checkpointId!, ['a.ts']);
    expect(prevA?.onlyPaths).toEqual(['a.ts']);
    expect(prevA?.files.length).toBe(1);
    engine.restoreCheckpoint(ws, cp.checkpointId!, { onlyPaths: prevA?.onlyPaths });
    expect(fs.readFileSync(fileA, 'utf8')).toBe('a_v1\n');
    expect(fs.readFileSync(fileB, 'utf8')).toBe('b_v2\n');
    expect(fs.existsSync(nestedCreated)).toBe(true);

    // 2. Roll back newly created nested file -> empty `src/new_feature/deep` & `src/new_feature` pruned, `src/` kept!
    engine.restoreCheckpoint(ws, cp.checkpointId!, { onlyPaths: ['src/new_feature/deep/created.ts'] });
    expect(fs.existsSync(nestedCreated)).toBe(false);
    expect(fs.existsSync(path.join(ws, 'src', 'new_feature'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'src'))).toBe(true);
  });

  it('detects 3-way human-edit conflicts and blocks rollback until explicitly overridden', () => {
    const ws = makeTempDir('da-snap-conflict-');
    const dataDir = makeTempDir('da-snap-conflictdata-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'));

    const appFile = path.join(ws, 'app.ts');
    fs.writeFileSync(appFile, 'v1_initial\n', 'utf8');

    const pre = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: appFile,
      toolName: 'edit_file',
      toolCallId: 'call_c1',
      conversationId: 'conv_c',
      lastUserInput: 'Agent refactor',
    });
    fs.writeFileSync(appFile, 'v2_agent_edit\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: appFile,
      toolName: 'edit_file',
      toolCallId: 'call_c1',
      conversationId: 'conv_c',
      lastUserInput: 'Agent refactor',
    });

    // Human manually edits `app.ts` AFTER the Agent turn!
    fs.writeFileSync(appFile, 'v3_precious_human_work\n', 'utf8');

    const blocked = engine.restoreCheckpoint(ws, pre.checkpointId!);
    expect(blocked.status).toBe('BLOCKED_CONFLICT');
    expect(blocked.conflicts.length).toBe(1);
    expect(blocked.conflicts[0]?.disposition).toBe('CONFLICT_HUMAN_MODIFIED');
    // Human file MUST remain completely untouched!
    expect(fs.readFileSync(appFile, 'utf8')).toBe('v3_precious_human_work\n');

    // Explicit human override succeeds AND backs up `v3_precious_human_work` first!
    const forced = engine.restoreCheckpoint(ws, pre.checkpointId!, { allowOverwriteConflicts: true });
    expect(forced.status).toBe('RESTORED');
    expect(fs.readFileSync(appFile, 'utf8')).toBe('v1_initial\n');

    engine.restoreCheckpoint(ws, forced.backupCheckpointId!);
    expect(fs.readFileSync(appFile, 'utf8')).toBe('v3_precious_human_work\n');
  });

  it('skips sensitive files (.env) and enforces LRU checkpoint quota eviction', () => {
    const ws = makeTempDir('da-snap-quota-');
    const dataDir = makeTempDir('da-snap-quotadata-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'), {
      maxCheckpoints: 3,
      maxFileBytes: 1024,
    });

    const envFile = path.join(ws, '.env');
    fs.writeFileSync(envFile, 'SECRET=123', 'utf8');
    const envCap = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: envFile,
      toolName: 'edit_file',
      conversationId: 'c_env',
      lastUserInput: 'touch env',
    });
    expect(envCap.captured).toBe(false);
    expect(envCap.skippedReason).toBe('SENSITIVE_BLOCKED');

    const codeFile = path.join(ws, 'mod.ts');
    for (let turn = 1; turn <= 5; turn++) {
      fs.writeFileSync(codeFile, `turn_${turn}\n`, 'utf8');
      engine.capturePreToolSnapshot({
        workspaceRoot: ws,
        targetPath: codeFile,
        toolName: 'edit_file',
        conversationId: 'c_quota',
        lastUserInput: `Turn prompt ${turn}`,
      });
    }
    const remaining = engine.listCheckpoints(ws);
    expect(remaining.length).toBe(3);
  });

  it('splits checkpoints on mid-turn model switch, repeated short prompts after idle gap, and skips >maxFileBytes in PostToolUse', () => {
    const ws = makeTempDir('da-snap-split-');
    const dataDir = makeTempDir('da-snap-splitdata-');
    const engine = new SnapshotEngine(dataDir, path.join(dataDir, 'audit.jsonl'), {
      maxFileBytes: 512,
      turnIdleSplitMs: 30_000,
    });

    const f = path.join(ws, 'feature.ts');
    fs.writeFileSync(f, 'v0_start\n', 'utf8');
    const t0 = 1_700_000_000_000;

    // Edit 1 by Carbon on prompt "继续"
    const cp1 = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c1',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-carbon',
      lastUserInput: '继续',
      stepIdx: 10,
      nowMs: t0,
    });
    fs.writeFileSync(f, 'v1_carbon\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c1',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-carbon',
      lastUserInput: '继续',
      nowMs: t0 + 100,
    });

    // Mid-turn model switch to Neon on SAME prompt "继续" -> MUST create distinct checkpoint!
    const cp2 = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c2',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-neon',
      lastUserInput: '继续',
      stepIdx: 11,
      nowMs: t0 + 2_000,
    });
    fs.writeFileSync(f, 'v2_neon\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c2',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-neon',
      lastUserInput: '继续',
      nowMs: t0 + 2_100,
    });

    // Another turn 45s later with SAME model & SAME prompt "继续" -> MUST split into 3rd checkpoint!
    const cp3 = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c3',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-neon',
      lastUserInput: '继续',
      stepIdx: 15,
      nowMs: t0 + 47_000,
    });
    fs.writeFileSync(f, 'v3_neon_later\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: f,
      toolName: 'edit_file',
      toolCallId: 'c3',
      conversationId: 'conv_switch',
      modelName: 'gemini-4-neon',
      lastUserInput: '继续',
      nowMs: t0 + 47_100,
    });

    expect(cp1.checkpointId).not.toBe(cp2.checkpointId);
    expect(cp2.checkpointId).not.toBe(cp3.checkpointId);
    expect(engine.listCheckpoints(ws).length).toBe(3);

    // Rollback ONLY cp3 -> restores v2_neon without losing cp1/cp2!
    const r = engine.restoreCheckpoint(ws, cp3.checkpointId!);
    expect(r.status).toBe('RESTORED');
    expect(fs.readFileSync(f, 'utf8')).toBe('v2_neon\n');

    // Oversized file in PostToolUse MUST bail out fast (`updated: false`) without reading full blob
    const bigFile = path.join(ws, 'big.bin');
    fs.writeFileSync(bigFile, Buffer.alloc(1024, 0x41));
    const postBig = engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: bigFile,
      toolName: 'write_file',
      conversationId: 'conv_switch',
    });
    expect(postBig.updated).toBe(false);
  });

  it('routes relative tool paths in multi-root Hook payloads to payload.cwd rather than workspacePaths[0]', async () => {
    const repoA = makeTempDir('da-hook-repoA-');
    const repoB = makeTempDir('da-hook-repoB-');
    const pluginData = makeTempDir('da-hook-pdata-');
    fs.writeFileSync(path.join(repoA, 'shared.ts'), 'repoA_original\n', 'utf8');
    fs.writeFileSync(path.join(repoB, 'shared.ts'), 'repoB_original\n', 'utf8');

    const hookCjs = path.resolve('dist/hooks/lifecycle-hook.cjs');
    if (!fs.existsSync(hookCjs)) {
      const { build: esbuild } = await import('esbuild');
      await esbuild({
        entryPoints: [path.resolve('src/hooks/lifecycle-hook.ts')],
        outfile: hookCjs,
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
      });
    }
    const payload = JSON.stringify({
      hookEventName: 'PreToolUse',
      conversationId: 'conv_multiroot',
      workspacePaths: [repoA, repoB],
      cwd: repoB,
      lastUserInput: 'Edit relative shared.ts in repoB',
      stepIdx: 1,
      toolCall: {
        id: 'call_rel_1',
        name: 'edit_file',
        args: { Path: 'shared.ts' },
      },
    });

    const hookRes = await runCommandSafe(process.execPath, [hookCjs], {
      env: { ...process.env, PLUGIN_DATA: pluginData },
      stdinData: payload,
      timeoutMs: 3_000,
    });
    expect(hookRes.exitCode).toBe(0);
    expect(hookRes.stdout).toContain('"decision":"allow"');

    const engine = new SnapshotEngine(pluginData, path.join(pluginData, 'audit.jsonl'));
    // RepoA MUST have 0 checkpoints; RepoB MUST have captured `shared.ts`!
    expect(engine.listCheckpoints(repoA).length).toBe(0);
    expect(engine.listCheckpoints(repoB).length).toBe(1);
    expect(engine.listCheckpoints(repoB)[0]?.files[0]?.relativePath).toBe('shared.ts');
  });

  it('normalizes Windows-style onlyPaths, preserves POSIX mode bits on Unix, and serializes concurrent async Hook calls safely', async () => {
    const ws = makeTempDir('da-hook-concurrent-');
    const pluginData = makeTempDir('da-hook-concdata-');
    const fileA = path.join(ws, 'src', 'a.ts');
    const fileB = path.join(ws, 'src', 'b.ts');
    const scriptSh = path.join(ws, 'scripts', 'run.sh');
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'scripts'), { recursive: true });
    fs.writeFileSync(fileA, 'a_orig\n', 'utf8');
    fs.writeFileSync(fileB, 'b_orig\n', 'utf8');
    fs.writeFileSync(scriptSh, '#!/bin/sh\necho ok\n', 'utf8');
    if (process.platform !== 'win32') {
      fs.chmodSync(scriptSh, 0o755);
    }

    const engine = new SnapshotEngine(pluginData, path.join(pluginData, 'audit.jsonl'));
    const cpSh = engine.capturePreToolSnapshot({
      workspaceRoot: ws,
      targetPath: scriptSh,
      toolName: 'edit_file',
      toolCallId: 'sh_1',
      conversationId: 'conv_perm',
      lastUserInput: 'Edit script',
    });
    fs.writeFileSync(scriptSh, '#!/bin/sh\necho changed\n', 'utf8');
    engine.capturePostToolSnapshot({
      workspaceRoot: ws,
      targetPath: scriptSh,
      toolName: 'edit_file',
      toolCallId: 'sh_1',
      conversationId: 'conv_perm',
      lastUserInput: 'Edit script',
    });

    // Windows backslash `onlyPaths` MUST still match POSIX relative path cleanly!
    const prevBackslash = engine.previewRollback(ws, cpSh.checkpointId!, ['scripts\\run.sh']);
    expect(prevBackslash?.files.length).toBe(1);
    expect(prevBackslash?.onlyPaths).toEqual(['scripts/run.sh']);

    const restoredSh = engine.restoreCheckpoint(ws, cpSh.checkpointId!, { onlyPaths: ['scripts\\run.sh'] });
    expect(restoredSh.status).toBe('RESTORED');
    if (process.platform !== 'win32') {
      expect(fs.statSync(scriptSh).mode & 0o777).toBe(0o755);
    }

    // Parallel hook execution via compiled CJS hook (tests async stdin + lockfile serialization)
    const hookCjs = path.resolve('dist/hooks/lifecycle-hook.cjs');
    const { build: esbuild } = await import('esbuild');
    await esbuild({
      entryPoints: [path.resolve('src/hooks/lifecycle-hook.ts')],
      outfile: hookCjs,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
    });

    const mkPayload = (target: string, id: string) =>
      JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'conv_parallel',
        workspacePaths: [ws],
        cwd: ws,
        lastUserInput: 'Parallel edits',
        stepIdx: 1,
        toolCall: { id, name: 'edit_file', args: { filePath: target } },
      });

    const [r1, r2] = await Promise.all([
      runCommandSafe(process.execPath, [hookCjs], {
        env: { ...process.env, PLUGIN_DATA: pluginData },
        stdinData: mkPayload(fileA, 'par_1'),
        timeoutMs: 4_000,
      }),
      runCommandSafe(process.execPath, [hookCjs], {
        env: { ...process.env, PLUGIN_DATA: pluginData },
        stdinData: mkPayload(fileB, 'par_2'),
        timeoutMs: 4_000,
      }),
    ]);
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);

    const latestCp = engine.listCheckpoints(ws).find((c) => c.conversationId === 'conv_parallel');
    expect(latestCp?.files.map((f) => f.relativePath).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });
});
