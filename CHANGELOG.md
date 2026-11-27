# 更新日志 / Changelog — `DiffAtlas`

所有重要变更均遵循 [语义化版本规范 (SemVer)](https://semver.org/) 与 [约定式提交 (Conventional Commits)](https://www.conventionalcommits.org/)。  
*All notable changes follow Semantic Versioning and Conventional Commits.*

---

## [0.1.0] - 2026-11-27

### 中文更新说明（首个 GitHub 正式版 · 面向 Google Antigravity `agy` 生态）

- **原生 Google Antigravity (`agy`) 五支柱插件包体 + 零编译直装分发**：
  - 完整对齐官方 `https://antigravity.google/schemas/v1/plugin.json`（含 `$schema`、`displayName`、`suggestedPrompts`、`author`、`license`、`keywords` 与双主题 `assets/logo.svg`），内置 `mcp_config.json`、`hooks.json`、`skills/diffatlas/SKILL.md` 与 `rules/AGENTS.md`。
  - 随仓库提供零 `node_modules` 依赖的纯 JS/HTML 运行时产物（`dist/server/index.mjs`、`dist/hooks/lifecycle-hook.cjs`、`dist/ui/app.html`），支持 Windows / macOS / Linux 三平台通过 `agy plugin install https://github.com/JiuYue-sky/DiffAtlas` 一键零编译开箱即用，并新增跨平台独立发布打包脚本 `scripts/package-release.mjs` 与 GitHub Actions Tag 自动打包工作流。
- **可复用 Antigravity MCP App 生态基础套件（`src/kit/`）**：
  - 沉淀 `PathGuard`（规范化 `realpath` 沙箱、防符号链接/Junction 逃逸、敏感文件黑名单、脱敏与防间接提示词注入）、`ProcessGuard` 跨平台进程树熔断、`PluginStateStore`（`${PLUGIN_DATA}` 状态持久化）、`ChunkChannel`（`<= 3` 并发分片流式传输）、`McpPluginShell`、`UiShell` React 桥接及 `SelfAudit` 零 `node_modules` 洁净室校验引擎。
- **确定性多语言文件级依赖影响图引擎（`src/core/`，8 大主流语言家族）**：
  - 零 `node-gyp` 原生编译依赖、零新增第三方包；完整支持 **TypeScript / JavaScript**（`import` / `import type` / Barrel `export`、TS 5.0+ 数组 `extends` + Monorepo 子包 `tsconfig.json` + 多 `references` + 精确/通配 `paths`、CommonJS `require()`）、**Vue / Svelte / Astro SFC**（`<script>` / `<script setup generic="...">` / frontmatter 精确行号保真、Emoji UTF-16 偏移免疫与 JSON-LD 忽略）、**Python**（相对/多行括号/紧凑相对导入与 `importlib`）、**Go**（`go.mod` / `replace` / 大包高扇出 / 同包 `_test.go` / `vendor` 与 `testdata` 跳过 / `plugin.Open`）、**Rust**（Cargo 工作区及 `[lib]` 自定义名与路径、`mod r#type`、`#[path]`、`use crate::/super::/self::`、`extern crate`、`include!()` 及生命周期 `'a` 免疫）、**C / C++**（本地与 `include/` 头文件、`.inl/.ipp/.tpp`、行内注释 `#include`、`#import`、`dlopen`）、**Java / Kotlin**（嵌套注解、`const val`、`@Composable`、Kotlin 插值模板、反引号包名、显式/静态/同包/通配导入与 `Class.forName`）及 **C#**（Allman 换行命名空间、嵌套方括号特性、`delegate`、插值字符串、类型过滤式命名空间 `using`、`using var` 安全区分与 `Assembly.Load`）。
  - 支持根目录与嵌套子目录 `.gitignore`、`.git/info/exclude`、Windows UTF-8 BOM 及安全识别真实 Python 虚拟环境与 `target/debug`、`obj/Debug`、`.NET bin/Debug` 构建产物（避免误伤 `src/env/`、`src/build/`、`src/target/`、`tools/bin/` 业务目录）；大仓库超 `maxFiles` 上限时仍强制保留全部 Git 变更文件；非 Git 目录跳过无谓 `git` 子进程并秒级降级。
  - 提供 1～2 跳反向波及分析（精确传递测试归因与最小置信度传播）、全语言关联测试文件推荐、按需懒加载语言索引、拓扑感知增量缓存与 CLI Markdown 证据报告。
- **独立双语文档与透明免责声明（`docs/`）**：
  - 完整拆分英文（`.md`）与简体中文（`.zh-CN.md`）六大专题文档，包含 [适用范围与当前不足](./docs/SCOPE_AND_LIMITATIONS.zh-CN.md) 与 [跨平台实机测试状态与兼容性免责声明](./docs/PLATFORM_TESTING_DISCLAIMER.zh-CN.md)（如实声明仅 Windows 经作者实机测试，非 Windows 宿主机请谨慎下载）。
- **毫秒级 Agent 时光机（`SnapshotEngine` + 异步 `PreToolUse` / `PostToolUse` Hooks）**：
  - 采用异步 `stdin` 流式读取彻底规避 macOS/Linux 下 Go 宿主管道 `EAGAIN` 异常并确保 3.5 秒 `fail-open` 看门狗真实生效；升级工作区并发锁（40 次重试）保障同轮并行多文件编辑零丢点。
  - 支持三方人工修改冲突拦截、强制回滚前备份（Undo-of-Undo）、单文件/整轮回滚、规范化空目录清理、macOS/Linux 可执行权限位（`0755`）保留与回滚权限人类独占（`visibility: ["app"]`）。
- **交互式 MCP App 可视化工作台（`src/ui/`）**：
  - 零外链单文件内联 SVG 分层影响图（吸顶列标题、点击查 `file:line` 证据、单文件 What-If 预演）、可折叠文件树、原生 `fileView` 跳转与 `-32601` 内联分屏回退（支持 Pointer Capture 上下拖动调整占比并持久化）、`updateModelContext()` 上下文胶囊、实时宿主亮/暗主题同步、与宿主隔离的 `EN / 中文` 切换按钮、快速切换工作区竞态防护以及诊断耗时面板。

### English Release Notes (Initial Public Release for the Google Antigravity `agy` Ecosystem)

- **Native 5-Pillar Google Antigravity (`agy`) Plugin & Zero-Build Distribution**:
  - Strictly conforms to `https://antigravity.google/schemas/v1/plugin.json` (`$schema`, `displayName`, `suggestedPrompts`, `author`, `license`, `keywords`, dual-theme `assets/logo.svg`) alongside `mcp_config.json`, `hooks.json`, `skills/diffatlas/SKILL.md`, and `rules/AGENTS.md`.
  - Ships deterministic zero-`node_modules` pure-JS/HTML runtime bundles (`dist/server/index.mjs`, `dist/hooks/lifecycle-hook.cjs`, `dist/ui/app.html`) so `agy plugin install https://github.com/JiuYue-sky/DiffAtlas` works immediately with zero build step across Windows, macOS, and Linux, backed by `scripts/package-release.mjs` and automated Tag Release GitHub Actions.
- **Reusable Antigravity MCP App Plugin Kit (`src/kit/`)**:
  - Provides domain-agnostic `PathGuard` (canonical `realpath` sandbox, symlink/junction & sensitive-file blocking, secret/path redaction), cross-platform `ProcessGuard` process-tree breaker, `${PLUGIN_DATA}` `PluginStateStore`, bounded `ChunkChannel` (`<= 3` concurrency), `McpPluginShell`, `UiShell` React bridge, and isolated zero-`node_modules` `SelfAudit` cleanroom verification.
- **Deterministic Multi-Language Blast-Radius Engine (`src/core/`, 8 Mainstream Language Families)**:
  - Zero native C++ addons (`node-gyp`-free) and zero extra runtime dependencies; parses **TypeScript / JavaScript** (TS 5.0+ array `extends`, monorepo nested `tsconfig.json`, multi-`references`, exact/wildcard `paths`, barrel re-exports, CJS `require()`), **Vue / Svelte / Astro SFCs** (UTF-16 emoji-safe `<script>` / Vue 3.3+ `generic` / frontmatter & JSON-LD immunity), **Python**, **Go** (`go.mod` / `replace` / high-fanout packages / same-package `_test.go` / `vendor` & `testdata` filtering / `plugin.Open`), **Rust** (Cargo workspaces & custom `[lib]` name/path, `mod r#type`, `#[path]`, `use crate::/super::/self::`, `extern crate`, `include!()`, lifetime `'a` immunity), **C / C++** (`#include "..."` & `include/` roots, `.inl/.ipp/.tpp`, inline-commented `#include`, `#import`, `dlopen`), **Java / Kotlin** (nested annotations, `const val`, `@Composable`, Kotlin string templates, backtick packages, explicit/static/same-package/wildcard imports, `Class.forName`), and **C#** (Allman namespaces, nested-bracket attributes, `delegate`, interpolated strings, type-filtered namespace `using`, `using var` immunity, `Assembly.Load`).
  - Supports root + nested `.gitignore`, `.git/info/exclude`, UTF-8 BOM files, safe Python virtualenv & Rust/Maven/C# compiled artifact detection (`target/debug`, `obj/Debug`, `.NET bin/Debug` while preserving `src/env/`, `src/build/`, `src/target/`, `tools/bin/`), Windows/macOS case-insensitive resolution fallback, `maxFiles`-safe changed file retention, and zero-Git-spawn degradation in non-Git folders.
- **Dedicated Bilingual Docs & Transparent Platform Testing Disclaimer (`docs/`)**:
  - Separate English (`.md`) and Simplified Chinese (`.zh-CN.md`) documentation suites covering [Scope, Strengths & Limitations](./docs/SCOPE_AND_LIMITATIONS.md) and [Platform Testing Status & Compatibility Disclaimer](./docs/PLATFORM_TESTING_DISCLAIMER.md) (explicitly disclosing Windows-only physical testing and advising caution on non-Windows hosts).
- **Millisecond Agent Time Machine (`SnapshotEngine` + Async `PreToolUse` / `PostToolUse` Hooks)**:
  - Uses non-blocking async stdin streaming to eliminate macOS/Linux `EAGAIN` pipe errors and keep the 3.5s fail-open watchdog live, paired with serialized lockfile contention handling for parallel agent edits.
  - Enforces 3-way human-edit conflict gating, mandatory Undo-of-Undo `pre_rollback_backup`, single-file (`onlyPaths`) and full-turn restore, canonical empty-dir pruning, POSIX executable mode preservation (`0755`), and strictly human-only rollback (`visibility: ["app"]`).
- **Interactive MCP App Workbench UI (`src/ui/`)**:
  - Strict `default-src 'none'` CSP single-file React + inline SVG blast-radius graph, collapsible directory tree, native `fileView` jump with `-32601` Pointer-Capture resizable split inline preview, `updateModelContext()` context pills, live host theme synchronization, plugin-isolated `EN / 中文` toggle, out-of-order workspace switch guard, and latency diagnostics probe.
