# Third-Party Open-Source Notices & Standards Registry

[简体中文](./THIRD_PARTY_NOTICES.zh-CN.md) | **English**

All runtime and transitive dependencies in **DiffAtlas** are continuously verified against a strict permissive-license allowlist by `npm run audit:self` (`src/kit/self-audit/auditor.ts`). Zero copyleft (GPL/AGPL) or native C++ (`node-gyp`) packages are bundled.

---

## 1. Direct Runtime Dependencies (Bundled into `dist/`)

| Package | License (SPDX) | Role in DiffAtlas | Upstream Repository |
| :--- | :---: | :--- | :--- |
| `@modelcontextprotocol/server` | `MIT` | Stdio MCP server & JSON-RPC protocol layer | https://github.com/modelcontextprotocol/typescript-sdk |
| `@modelcontextprotocol/core` | `MIT` | Shared MCP protocol types and schemas | https://github.com/modelcontextprotocol/typescript-sdk |
| `@modelcontextprotocol/ext-apps` | `MIT` | Official MCP Apps (`SEP-1865`) server helpers, React hooks (`useApp`), and host theme/style bridge | https://github.com/modelcontextprotocol/ext-apps |
| `@modelcontextprotocol/client` | `MIT` | Used in cleanroom self-audit harness (`scripts/self-audit.mjs`) to verify live Stdio MCP handshakes | https://github.com/modelcontextprotocol/typescript-sdk |
| `react` / `react-dom` | `MIT` | Interactive MCP App workbench UI & inline SVG rendering | https://github.com/facebook/react |
| `zod` | `MIT` | Runtime input schema validation for MCP tools and host extension responses | https://github.com/colinhacks/zod |
| `es-module-lexer` | `MIT` | WASM ESM lexer oracle used in parser cross-validation tests | https://github.com/guybedford/es-module-lexer |

---

## 2. Build & Verification Dev Dependencies (Not Shipped in Runtime Bundles)

| Package | License (SPDX) | Role |
| :--- | :---: | :--- |
| `typescript` | `Apache-2.0` | Strict static typechecking (`tsc --noEmit`) |
| `vite` & `@vitejs/plugin-react` | `MIT` | Frontend build toolchain |
| `vite-plugin-singlefile` | `MIT` | Inlines JS/CSS into a single CSP-clean `dist/ui/app.html` |
| `esbuild` | `MIT` | Zero-dependency bundling for `dist/server/index.mjs` and `dist/hooks/lifecycle-hook.cjs` |
| `vitest` | `MIT` | Automated security, state-machine, parser, and SLA regression suite |
| `@types/node`, `@types/react`, `@types/react-dom` | `MIT` | TypeScript ambient type declarations |

---

## 3. Open Specifications & Ecosystem References

- **Google Antigravity (`agy`) Plugins & Build Guide**: https://antigravity.google/docs/plugins · https://antigravity.google/docs/build-plugins
- **Google Antigravity Plugin Manifest JSON Schema v1**: https://antigravity.google/schemas/v1/plugin.json
- **Google Antigravity MCP & Lifecycle Hooks Docs**: https://antigravity.google/docs/mcp · https://antigravity.google/docs/hooks
- **Model Context Protocol (MCP) & MCP Apps (SEP-1865)**: https://modelcontextprotocol.io · https://github.com/modelcontextprotocol/ext-apps
- **OWASP MCP Security Principles**: Canonical `realpath` containment, least-privilege `visibility: ["app"]`, secret redaction, and indirect prompt-injection sanitization.

---

Back to [README (English)](../README.md) · [简体中文版第三方组件声明](./THIRD_PARTY_NOTICES.zh-CN.md)
