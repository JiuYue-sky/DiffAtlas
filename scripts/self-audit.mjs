import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const tmpRunnerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'da-audit-runner-'));
  const runnerBundle = path.join(tmpRunnerDir, 'auditor-bundle.mjs');

  try {
    await esbuild({
      entryPoints: [path.join(rootDir, 'src/kit/self-audit/auditor.ts')],
      outfile: runnerBundle,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      banner: {
        js: "import { createRequire as __daCreateRequire } from 'node:module'; const require = __daCreateRequire(import.meta.url);",
      },
    });

    const mod = await import(pathToFileURL(runnerBundle).href);
    const report = await mod.runPluginSelfAudit({
      projectRoot: rootDir,
      stagedPluginDir: path.join(rootDir, '.agents', 'plugins', 'diffatlas'),
      pluginId: 'diffatlas',
      expectHooks: true,
    });

    console.log('\n=== DiffAtlas Self-Audit & Cleanroom Report ===');
    for (const c of report.checks) {
      const icon = c.ok ? 'PASS' : c.severity === 'warning' ? 'WARN' : 'FAIL';
      console.log(`  [${icon}] ${c.check}: ${c.detail}`);
    }
    console.log(
      `\nResult: ${report.status} (${report.totalChecks - report.failedCount}/${report.totalChecks} checks passed, ${report.warningCount} warnings)\n`,
    );

    if (report.status !== 'PASS') {
      process.exit(1);
    }
  } finally {
    fs.rmSync(tmpRunnerDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Self-Audit Fatal]', err);
  process.exit(1);
});
