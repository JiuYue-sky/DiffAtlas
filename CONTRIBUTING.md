# Contributing Guide / 贡献与反馈指南

Thank you for helping extend **DiffAtlas** and the **Google Antigravity (`agy`)** open-source plugin ecosystem! Bug reports, cross-platform compatibility fixes, new language dependency parsers, `src/kit/` improvements, and documentation updates are all welcome.

欢迎提交 Bug 反馈、跨系统兼容修复、新语言依赖解析器适配、`src/kit/` 通用套件增强或文档改进！

---

## 1. Feedback & Maintainer Contact / 反馈与联系渠道

- **GitHub Issues**: Prefer opening an issue using our [Bug Report](./.github/ISSUE_TEMPLATE/bug_report.md) or [Feature / Ecosystem Request](./.github/ISSUE_TEMPLATE/feature_request.md) templates so other Antigravity (`agy`) users can search and benefit from solutions.
- **Maintainer Email / 维护者联系邮箱**: `jiuyue200712@gmail.com` (for private environment logs, cross-OS debugging, or security inquiries — see [SECURITY.md](./SECURITY.md)).

---

## 2. Local Verification Gate Before Opening a PR / 提交 PR 前本地必跑核验

Requires **Node.js >= 20 LTS**. Run the complete verification pipeline from the repository root before committing:

```bash
# 1. Install zero-native-addon dependencies
npm ci

# 2. Run the full 4-stage gate:
#    tsc --noEmit + Vite/esbuild build + Vitest suite + zero-node_modules cleanroom self-audit
npm run verify

# 3. (Optional) Verify standalone GitHub Release packaging (.zip + .tar.gz + .sha256)
npm run package:release -- dev-test
```

If you have the official Antigravity CLI (`agy`) installed, also run:

```bash
agy plugin validate --strict .
```

All checks in `npm run verify` must report `PASS` with `0` errors and `0` warnings.

---

## 3. Engineering & Ecosystem Guardrails / 工程红线与规范

1. **Zero Native C++ Addons (`node-gyp` Strictly Forbidden)**:
   - Never introduce runtime or build dependencies requiring native compilation (`better-sqlite3`, `tree-sitter`, `node-pty`, `sharp`, etc.) so `agy plugin install` remains 100% portable across Windows, macOS, and Linux.
2. **Permissive Licenses Only**:
   - Runtime and transitive dependencies are automatically checked by `npm run audit:self` against a permissive SPDX allowlist (MIT / Apache-2.0 / BSD / ISC / 0BSD / CC0).
3. **Strict Antigravity (`agy`) & MCP Apps (`SEP-1865`) Compliance**:
   - Never use `localStorage`, `sessionStorage`, `indexedDB`, `dangerouslySetInnerHTML`, or external CDN scripts/stylesheets in `src/ui/` or `src/kit/ui-shell/`. Persist UI state via `${PLUGIN_DATA}` app-only tools.
   - Keep `app_restore_checkpoint` and `app_preview_rollback` strictly `visibility: ["app"]` (human-exclusive).
   - Keep `plugin.json` compliant with `https://antigravity.google/schemas/v1/plugin.json` and preserve `version` parity across `package.json`, `plugin.json`, and `src/shared/identity.ts`.
4. **Zero Secrets or Personal Machine Paths**:
   - Never commit `.env*`, API tokens, `.agents/` local staging mirrors, `dist/build_verification.json`, or absolute machine paths (e.g., `C:\Users\<name>\...`, `/Users/<name>/...`).
5. **Prebuilt Runtime Bundle Sync (`dist/`)**:
   - Because DiffAtlas tracks `dist/server/index.mjs`, `dist/hooks/lifecycle-hook.cjs`, and `dist/ui/app.html` for zero-build `agy plugin install`, run `npm run verify` after any source change so the runtime bundles stay in sync with `src/`.
6. **Commit Convention**:
   - Follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

All contributions are licensed under the repository's [MIT License](./LICENSE).
