/**
 * Cross-platform standalone Antigravity plugin release packager (`dist/release/`).
 * Produces ready-to-extract plugin bundles (`.tar.gz` and `.zip` + `.sha256` checksums)
 * containing ONLY the minimal zero-`node_modules` Antigravity plugin files.
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeChecksum(archivePath) {
  const hash = sha256File(archivePath);
  const line = `${hash}  ${path.basename(archivePath)}\n`;
  fs.writeFileSync(`${archivePath}.sha256`, line, 'ascii');
  return hash;
}

function main() {
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'plugin.json'), 'utf8'));
  const rawTag = process.argv[2] || `v${pluginManifest.version}`;
  const tag = rawTag.replace(/^refs\/tags\//, '');
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
    throw new Error(`Unsafe release tag string: "${tag}"`);
  }

  const requiredRuntime = [
    'plugin.json',
    'mcp_config.json',
    'hooks.json',
    'dist/server/index.mjs',
    'dist/hooks/lifecycle-hook.cjs',
    'dist/ui/app.html',
    'assets/logo.svg',
    'skills/diffatlas/SKILL.md',
    'rules/AGENTS.md',
  ];
  for (const rel of requiredRuntime) {
    if (!fs.existsSync(path.join(rootDir, rel))) {
      throw new Error(`Missing required plugin asset "${rel}". Run "npm run build" first.`);
    }
  }

  const releaseDir = path.join(rootDir, 'dist', 'release');
  fs.mkdirSync(releaseDir, { recursive: true });

  const tmpStageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'diffatlas-release-stage-'));
  const pluginStageDir = path.join(tmpStageRoot, 'diffatlas');
  fs.mkdirSync(pluginStageDir, { recursive: true });

  try {
    const rootFiles = [
      'plugin.json',
      'mcp_config.json',
      'hooks.json',
      'README.md',
      'README.zh-CN.md',
      'LICENSE',
      'NOTICE.md',
      'SECURITY.md',
      'CHANGELOG.md',
    ];
    for (const rel of rootFiles) {
      const src = path.join(rootDir, rel);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(pluginStageDir, rel));
      }
    }

    for (const dir of ['assets', 'docs', 'skills', 'rules']) {
      fs.cpSync(path.join(rootDir, dir), path.join(pluginStageDir, dir), { recursive: true });
    }
    for (const sub of ['ui', 'server', 'hooks']) {
      fs.cpSync(path.join(rootDir, 'dist', sub), path.join(pluginStageDir, 'dist', sub), { recursive: true });
    }

    const baseName = `diffatlas-plugin-${tag}`;
    const tarGzPath = path.join(releaseDir, `${baseName}.tar.gz`);
    const zipPath = path.join(releaseDir, `${baseName}.zip`);

    if (fs.existsSync(tarGzPath)) fs.unlinkSync(tarGzPath);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    // Cross-platform tar.gz (Windows 10/11 ships bsdtar; macOS & Linux ship tar)
    execFileSync('tar', ['-czf', tarGzPath, '-C', tmpStageRoot, 'diffatlas'], { stdio: 'inherit' });
    const tarHash = writeChecksum(tarGzPath);

    // Cross-platform zip with POSIX forward-slash entry paths (`bsdtar -a` on Windows 10/11, `zip`/`python3` on Unix)
    if (process.platform === 'win32') {
      try {
        execFileSync('tar', ['-a', '-cf', zipPath, '-C', tmpStageRoot, 'diffatlas'], { stdio: 'inherit' });
      } catch {
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `Compress-Archive -Path '${pluginStageDir.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
          ],
          { stdio: 'inherit' },
        );
      }
    } else {
      try {
        execFileSync('zip', ['-rq', zipPath, 'diffatlas'], { cwd: tmpStageRoot, stdio: 'inherit' });
      } catch {
        execFileSync(
          'python3',
          [
            '-c',
            'import os,sys,zipfile; root,out=sys.argv[1],sys.argv[2]; z=zipfile.ZipFile(out,"w",zipfile.ZIP_DEFLATED); [z.write(os.path.join(dp,f), os.path.relpath(os.path.join(dp,f), root)) for dp,_,fs in os.walk(os.path.join(root,"diffatlas")) for f in fs]; z.close()',
            tmpStageRoot,
            zipPath,
          ],
          { stdio: 'inherit' },
        );
      }
    }
    const zipHash = writeChecksum(zipPath);

    console.log(`[DiffAtlas Release Packager] Built standalone zero-node_modules plugin archives for ${tag}:`);
    console.log(`  - ${path.relative(rootDir, zipPath)} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KiB) sha256=${zipHash.slice(0, 12)}...`);
    console.log(`  - ${path.relative(rootDir, tarGzPath)} (${(fs.statSync(tarGzPath).size / 1024).toFixed(1)} KiB) sha256=${tarHash.slice(0, 12)}...`);
  } finally {
    fs.rmSync(tmpStageRoot, { recursive: true, force: true });
  }
}

main();
