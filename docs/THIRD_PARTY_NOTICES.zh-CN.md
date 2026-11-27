# 第三方开源组件许可清单与遵循协议标准

**简体中文** | [English](./THIRD_PARTY_NOTICES.md)

**DiffAtlas** 的全部直接与传递依赖均由 `npm run audit:self`（`src/kit/self-audit/auditor.ts`）持续按宽松开源协议白名单自动校验，绝不引入 Copyleft（GPL/AGPL）或需 `node-gyp` 编译的原生 C++ 依赖。

---

## 1. 直接运行时依赖（已打包进 `dist/`）

| 组件包名 | 开源协议 (SPDX) | 在 DiffAtlas 中的职责 | 上游仓库 |
| :--- | :---: | :--- | :--- |
| `@modelcontextprotocol/server` | `MIT` | Stdio MCP 服务端与 JSON-RPC 协议层 | https://github.com/modelcontextprotocol/typescript-sdk |
| `@modelcontextprotocol/core` | `MIT` | MCP 共享协议类型与 Schema | https://github.com/modelcontextprotocol/typescript-sdk |
| `@modelcontextprotocol/ext-apps` | `MIT` | 官方 MCP Apps (`SEP-1865`) 服务端辅助、React Hook (`useApp`) 与宿主主题变量桥接 | https://github.com/modelcontextprotocol/ext-apps |
| `@modelcontextprotocol/client` | `MIT` | 用于洁净室自检工具（`scripts/self-audit.mjs`）执行真实 Stdio MCP 端到端握手校验 | https://github.com/modelcontextprotocol/typescript-sdk |
| `react` / `react-dom` | `MIT` | 交互式 MCP App 工作台界面与内联 SVG 图谱渲染 | https://github.com/facebook/react |
| `zod` | `MIT` | MCP 工具入参与宿主扩展回执的运行时 Schema 校验 | https://github.com/colinhacks/zod |
| `es-module-lexer` | `MIT` | WASM ESM 词法解析器，用于单测中对导入解析器做交叉基准校验 | https://github.com/guybedford/es-module-lexer |

---

## 2. 构建与测试开发依赖（不进入运行时产物）

| 组件包名 | 开源协议 (SPDX) | 职责 |
| :--- | :---: | :--- |
| `typescript` | `Apache-2.0` | 严格静态类型检查（`tsc --noEmit`） |
| `vite` & `@vitejs/plugin-react` | `MIT` | 前端构建工具链 |
| `vite-plugin-singlefile` | `MIT` | 将 JS/CSS 内联打包为单文件零外链 `dist/ui/app.html` |
| `esbuild` | `MIT` | 将服务端 `dist/server/index.mjs` 与钩子 `dist/hooks/lifecycle-hook.cjs` 打包为零依赖单文件 |
| `vitest` | `MIT` | 安全边界、状态机、跨系统解析器与性能压测回归套件 |
| `@types/node`、`@types/react`、`@types/react-dom` | `MIT` | TypeScript 类型声明 |

---

## 3. 遵循的公开协议与生态参考标准

- **Google Antigravity (`agy`) 插件与开发指南**：https://antigravity.google/docs/plugins · https://antigravity.google/docs/build-plugins
- **Google Antigravity Plugin Manifest JSON Schema v1**：https://antigravity.google/schemas/v1/plugin.json
- **Google Antigravity MCP 与 Lifecycle Hooks 文档**：https://antigravity.google/docs/mcp · https://antigravity.google/docs/hooks
- **Model Context Protocol (MCP) 与 MCP Apps (SEP-1865)**：https://modelcontextprotocol.io · https://github.com/modelcontextprotocol/ext-apps
- **OWASP MCP 安全实践原则**：规范化 `realpath` 沙箱、最小权限 `visibility: ["app"]`、密钥脱敏与防间接提示词注入。

---

返回 [简体中文 README](../README.zh-CN.md) · [English Version](./THIRD_PARTY_NOTICES.md)
