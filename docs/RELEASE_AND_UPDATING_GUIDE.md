# Updating, GitHub Release & Antigravity Marketplace Playbook

[简体中文](./RELEASE_AND_UPDATING_GUIDE.zh-CN.md) | **English**

This guide covers two workflows:
1. **For End Users**: How to safely upgrade DiffAtlas to a newer release without losing Time Machine checkpoints or UI preferences.
2. **For Maintainers**: How to bump versions, verify cleanroom gates, publish GitHub Releases, optimize GitHub / Google Antigravity (`agy`) discoverability, and submit to the official **Antigravity Marketplace**.

---

## 1. End-User Upgrade Guide

Because DiffAtlas persists all Time Machine snapshots (`snapshots/`), recent workspaces (`state/`), UI preferences (`locale`, `themeOverride`, `previewRatio`), and `audit.jsonl` strictly inside `${PLUGIN_DATA}` (outside `${PLUGIN_ROOT}`), **upgrading the plugin folder preserves all local data automatically**.

### Upgrading via Antigravity CLI (`agy`)
```bash
agy plugin install https://github.com/JiuYue-sky/DiffAtlas
# Or pin a specific release tag:
agy plugin install https://github.com/JiuYue-sky/DiffAtlas/tree/v0.1.0
```

### Upgrading from GitHub Releases Archive
1. Download the new `diffatlas-plugin-v<version>.zip` or `.tar.gz` and verify `.sha256`.
2. Replace `~/.gemini/config/plugins/diffatlas/` (or `%USERPROFILE%\.gemini\config\plugins\diffatlas\` on Windows) with the extracted `diffatlas/` directory.
3. In Antigravity **MCP Servers** settings, click **Restart** on `diffatlas_diffatlas` (an already-running MCP server process keeps its previous bundle in memory until restarted).
4. Open DiffAtlas → **Probe** tab to confirm the updated version is active.

---

## 2. Maintainer SemVer Release Checklist

### Semantic Versioning Cadence
- **Public Pre-Release (`beta` / `rc`)**: `0.1.0-beta.1` → `0.1.0-beta.2` → `0.1.0-rc.1`
  - Git tag: `v0.1.0-beta.1`; mark as **Pre-release** on GitHub Releases.
- **First Stable Release**: `0.1.0` (or `1.0.0` once kit & schema APIs freeze).

### 5-Step Release Verification Procedure (Before Pushing Any Tag)
1. **Synchronize Version Numbers Across All Locations**:
   - `package.json` (`"version"`)
   - `plugin.json` (`"version"`)
   - `src/shared/identity.ts` (`DIFFATLAS_IDENTITY.version`)
   - `README.md`, `README.zh-CN.md` (version badge), and `CHANGELOG.md` (bilingual release notes)
2. **Run Full Local Cleanroom Verification & Standalone Packager**:
   ```bash
   npm run verify
   npm run package:release -- v0.1.0
   ```
   Confirm:
   - `tsc --noEmit`: 0 errors
   - `vitest run`: 100% passing
   - `npm run audit:self`: 100% `PASS` (0 failures, 0 warnings, 0 dev-path/secret leaks, version parity verified)
   - `dist/server/index.mjs`, `dist/hooks/lifecycle-hook.cjs`, and `dist/ui/app.html` are freshly built and committed
   - `.agents/`, `dist/build_verification.json`, and `dist/release/` remain untracked (`git status` clean)
3. **Optional Official CLI Validation (When `agy` CLI Is Installed)**:
   ```bash
   agy plugin validate --strict .
   ```
4. **Push `main` & Verify 3-OS Cleanroom CI**:
   - Confirm `.github/workflows/ci.yml` turns green across all 6 matrix jobs (`ubuntu-latest`, `macos-latest`, `windows-latest` × Node `20`, `22`).
5. **Create & Push Release Tag**:
   ```bash
   git tag -a v0.1.0 -m "release: v0.1.0"
   git push origin main --follow-tags
   ```
   - `.github/workflows/release-packager.yml` automatically runs `npm run verify` and uploads `diffatlas-plugin-v0.1.0.zip`, `.tar.gz`, `.sha256`, and `build_verification.json` as workflow artifacts ready to attach to the GitHub Release.

---

## 3. GitHub Repository SEO & Google Antigravity (`agy`) Ecosystem Discoverability

When configuring the GitHub repository settings (`https://github.com/JiuYue-sky/DiffAtlas`), apply the following metadata to strengthen search visibility for **Google Antigravity (`agy`)** and **MCP Apps**:

- **Recommended Repository Description (About)**:
  > Google Antigravity (agy) MCP App plugin: interactive Git diff, 8-language dependency impact graph, safe checkpoint rollback, and reusable plugin kit.
- **Recommended Website URL**:
  > `https://github.com/JiuYue-sky/DiffAtlas#readme`
- **Recommended GitHub Topics (up to 20)**:
  ```text
  antigravity, google-antigravity, agy, antigravity-plugin, antigravity-mcp-app,
  mcp-app, mcp-apps, mcp-server, model-context-protocol, sep-1865,
  ai-coding-agent, git-diff, dependency-graph, blast-radius, impact-analysis,
  code-review, time-machine, rollback, polyglot, typescript
  ```

---

## 4. Submitting to the Official Google Antigravity Marketplace

DiffAtlas is structured from day one to satisfy Google Antigravity Marketplace intake criteria:
- Root `plugin.json` conforms strictly to `https://antigravity.google/schemas/v1/plugin.json` (`name`, `displayName`, `version`, `description`, `logo`, `suggestedPrompts` [3], `author`, `homepage`, `repository`, `license`, `keywords`).
- Bundled 1:1 high-contrast dual-theme icon at `assets/logo.svg` with >10% outer padding.
- Zero native binaries, zero external network dependencies, permissive MIT/Apache-2.0 transitive dependency tree, and clean `README.md`.
- Once stable (`v0.1.0`+), validate locally with `agy plugin validate --strict .` and submit via the official [Antigravity Marketplace intake guide](https://antigravity.google/docs/build-plugins#publish-to-the-antigravity-marketplace). After approval, add `antigravity://plugin/diffatlas?marketplace=antigravity-plugins-partners` deep links to `README.md`.

---

Back to [README (English)](../README.md) · [简体中文版升级与发版指南](./RELEASE_AND_UPDATING_GUIDE.zh-CN.md)
