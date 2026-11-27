## Summary
<!-- Briefly describe what this PR fixes or adds -->

## Ecosystem / Cross-OS Impact
- [ ] Tested on Windows / macOS / Linux (or verified via 3-OS CI matrix)
- [ ] Zero native C++ addons (`node-gyp` remains strictly banned)
- [ ] Preserves Antigravity (`agy`) native surfaces (`aux_pane`, `global`, CLI Markdown fallback)
- [ ] Zero browser storage (`localStorage`/`IndexedDB`) and `default-src 'none'` CSP intact

## Verification Checklist
- [ ] `npm run verify` passes (`tsc --noEmit`, `build`, `vitest run`, `audit:self` cleanroom)
- [ ] If runtime bundles changed, updated prebuilt `dist/server/index.mjs`, `dist/hooks/lifecycle-hook.cjs`, and `dist/ui/app.html`
- [ ] Updated relevant docs (`README.md`, `README.zh-CN.md`, `CHANGELOG.md`, or `docs/*`)
