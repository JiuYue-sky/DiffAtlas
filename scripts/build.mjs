import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function main() {
  const t0 = performance.now();
  console.log('[DiffAtlas Build] 1/4 Building self-contained MCP App singlefile HTML...');
  await viteBuild({
    configFile: path.join(rootDir, 'vite.config.ts'),
    logLevel: 'warn',
  });

  const esmRequireBanner =
    "import { createRequire as __daCreateRequire } from 'node:module'; const require = __daCreateRequire(import.meta.url);";

  console.log('[DiffAtlas Build] 2/4 Bundling zero-native-addon Stdio MCP Server...');
  await esbuild({
    entryPoints: [path.join(rootDir, 'src/server/index.ts')],
    outfile: path.join(rootDir, 'dist/server/index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: false,
    minify: true,
    banner: { js: esmRequireBanner },
  });

  console.log('[DiffAtlas Build] 3/4 Bundling <50ms Lifecycle Hook (fast-boot CJS)...');
  await esbuild({
    entryPoints: [path.join(rootDir, 'src/hooks/lifecycle-hook.ts')],
    outfile: path.join(rootDir, 'dist/hooks/lifecycle-hook.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    sourcemap: false,
    minify: true,
  });

  console.log('[DiffAtlas Build] 4/4 Staging workspace-isolated plugin to .agents/plugins/diffatlas/...');
  const stageDir = path.join(rootDir, '.agents', 'plugins', 'diffatlas');
  fs.mkdirSync(stageDir, { recursive: true });

  const rootFilesToCopy = [
    'plugin.json',
    'mcp_config.json',
    'hooks.json',
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    'NOTICE.md',
    'CHANGELOG.md',
    'LICENSE',
  ];
  for (const relFile of rootFilesToCopy) {
    const src = path.join(rootDir, relFile);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(stageDir, relFile);
    fs.copyFileSync(src, dst);
  }

  const dirsToMirror = ['assets', 'docs', 'skills', 'rules'];
  for (const dirName of dirsToMirror) {
    const srcDir = path.join(rootDir, dirName);
    const dstDir = path.join(stageDir, dirName);
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true, force: true });
    }
    if (fs.existsSync(srcDir)) {
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Copy ONLY runtime dist bundles (never transient `dist/release` or `dist/build_verification.json`)
  const stageDist = path.join(stageDir, 'dist');
  if (fs.existsSync(stageDist)) {
    fs.rmSync(stageDist, { recursive: true, force: true });
  }
  for (const sub of ['ui', 'server', 'hooks']) {
    const srcSub = path.join(rootDir, 'dist', sub);
    const dstSub = path.join(stageDist, sub);
    if (fs.existsSync(srcSub)) {
      fs.cpSync(srcSub, dstSub, { recursive: true });
    }
  }

  const uiHtmlSize = fs.statSync(path.join(rootDir, 'dist/ui/app.html')).size;
  const hookSize = fs.statSync(path.join(rootDir, 'dist/hooks/lifecycle-hook.cjs')).size;
  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  console.log(
    `[DiffAtlas Build] Complete in ${elapsed}s | UI HTML: ${(uiHtmlSize / 1024).toFixed(1)} KiB | Hook bundle: ${(hookSize / 1024).toFixed(1)} KiB`,
  );
}

main().catch((err) => {
  console.error('[DiffAtlas Build Failed]', err);
  process.exit(1);
});
