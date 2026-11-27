# 适用范围、核心强项与当前不足

**简体中文** | [English](./SCOPE_AND_LIMITATIONS.md)

本文档旨在客观、透明地说明 **DiffAtlas（`v0.1.0`）** 的真实工程边界：它在 **Google Antigravity (`agy`)** 与 **MCP Apps（`SEP-1865`）** 生态中最擅长解决什么问题、当前版本存在哪些明确局限，以及在哪些场景下应当配合或改用其他工具。

---

## 1. 最佳适用范围与目标场景

DiffAtlas 专为以下高频开发场景设计：

1. **Google Antigravity (`agy`) 中的多文件 AI 协作审查**
   - 当 Agent 单轮改动 **TypeScript / JavaScript**、**Vue / Svelte / Astro**、**Python**、**Go**、**Rust**、**C / C++**、**Java / Kotlin** 或 **C#** 仓库中的 2～30 个文件时，快速看清直接改动、下游波及模块与受影响测试文件，避免逐个盲翻文本 Diff 漏看连锁破坏。
2. **重构前的“What-If 影响预演”**
   - 在让 Agent 重构公共工具函数、类型定义或核心模块之前，先在文件树点击 **预演影响** 查看 1～2 跳波及范围，并通过 `updateModelContext()` 将关键波及模块与推荐测试一键挂入下一轮对话上下文。
3. **Git 提交之间的高频、高安全本地回滚**
   - 当 Agent 探索性修改走偏时，毫秒级回退单个文件或整轮修改，无需频繁打临时 WIP Commit，同时通过三方冲突检测防止误覆盖你自己的手工修改。
4. **基于 `src/kit/` 扩展更多 Google Antigravity (`agy`) 生态插件**
   - 直接复用与领域解耦的 [`src/kit/`](./ARCHITECTURE_AND_ECOSYSTEM.zh-CN.md) 基础套件（路径沙箱、进程熔断、分片传输、`PLUGIN_DATA` 持久化、React 桥接、洁净室自检），快速孵化其他本地 MCP App 工作台插件。

---

## 2. 核心强项

| 核心强项 | 工程落点与可验证事实 |
| :--- | :--- |
| **零原生编译、三平台开箱即用** | 100% 纯 TypeScript/JS + WASM 运行时（严禁 `node-gyp` C++ 扩展），随仓库附带零 `node_modules` 的纯 JS/HTML 运行时产物（`dist/`），在 Windows、macOS（Apple Silicon / Intel）与 Linux 上仅需 Node.js `>= 20 LTS` 即可直接安装运行。 |
| **强证据链与诚实置信度分层** | 影响图中的每一条依赖边与 CLI 报告行均附带精确 `file:line` 行号与脱敏源码片段；对动态加载（`import(expr)`、`require(expr)`、`importlib`、`plugin.Open`、`dlopen`/`LoadLibrary`、`Class.forName`、`Assembly.Load`/`Type.GetType`）与 JVM `.*` 通配导入显式标注为 **Low Confidence（低置信度）**，绝不制造虚假确定性。 |
| **惰性索引与拓扑感知增量缓存** | 本地冷扫描 1,000 个文件耗时约 1.6s；各语言工作区索引按需惰性构建（未出现该语言时零开销），基于 `mtime + size + 文件集合/清单/声明拓扑哈希` 的增量热更新可在 `< 300ms` 内完成。 |
| **五支柱原生集成 + 无缝优雅降级** | 完整打通 MCP App UI（`aux_pane` + `global`）、`hooks.json`、`SKILL.md`、`rules/AGENTS.md` 与 `${PLUGIN_DATA}` 持久化；在 `global` 侧栏或第三方 MCP 宿主（`-32601`）自动降级为上下可拖动分屏预览，在 `agy` CLI 中自动输出整洁 Markdown 证据报告。 |
| **纵深安全边界与 100% 本地离线** | 回滚权限人类独占（`visibility: ["app"]`）、三方人工修改冲突拦截、强制回滚前备份（Undo-of-Undo）、规范化 `realpath` 沙箱、敏感文件黑名单（`.git/**`、`.env*`、私钥）、严格 `default-src 'none'` CSP、零浏览器存储、零网络遥测。 |
| **零侵入独立双语与主题同步** | 实时跟随宿主亮/暗主题变量，同时在插件沙箱内提供完全隔离的 `EN / 中文` 切换按钮，绝不与宿主界面或其他汉化插件冲突。 |

---

## 3. 当前不足与明确局限（`v0.1.0`）

提前明确项目当前**做不到**或**尚未覆盖**的边界，有助于避免错误预期：

### 3.1 语言覆盖范围与剩余缺口（`v0.1.0`）
- **当前已支持依赖影响图谱与「预演影响」（8 大主流语言家族）**：
  - **TypeScript / JavaScript**（`.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`）
  - **Vue / Svelte / Astro 单文件组件**（`.vue/.svelte/.astro` 的 `<script>` 与 frontmatter 块）
  - **Python**（`.py/.pyi`）
  - **Go**（`.go` + `go.mod` / `replace` + 同包 `_test.go`）
  - **Rust**（`.rs` + Cargo 工作区 `Cargo.toml`、`mod`、`use crate::/super::/self::`、`extern crate`）
  - **C / C++**（`.c/.h/.cc/.cpp/.cxx/.hpp/.hh/.hxx` 的 `#include`）
  - **Java / Kotlin**（`.java/.kt/.kts` 包声明、显式/静态/同包/通配导入）
  - **C#**（`.cs` 命名空间、`using static`、别名 `using` 与类型过滤式命名空间 `using`）
- **尚未纳入导入图谱解析的语言**：PHP、Ruby、Swift、Dart、Scala、Elixir、SQL、Shell 脚本，以及无显式 `import` 的框架自动注入组件（如 Nuxt/unplugin 自动导入）。这些文件在文件树浏览、查看 Diff、原生 `fileView` 跳转、挂入上下文胶囊与时光机快照回滚中**均完全可用**，仅暂不生成导入依赖连线。

### 3.2 文件级分析（非符号级 / 类型检查 / 运行时调用图）
- **模块文件粒度**：影响分析追踪的是 **文件到文件的静态导入/重导出关系**（最多 **2 跳**：`Hop 0 → 1 跳 → 2 跳`），而非函数/类级别的精细符号引用图或编译器类型推导。
- **Barrel 聚合导出文件的保守过报**：若修改了某个被广泛重导出的 `index.ts` 中的单个未用辅助函数，依赖该 `index.ts` 的下游文件都会被保守标记为受波及。
- **无法静态感知运行时或编译器宏耦合**：依赖注入容器、字符串路由注册表、消息队列、HTTP/gRPC 接口契约、C/C++ 预处理 `#ifdef` 条件编译求值、C# MSBuild `<ImplicitUsings>` / 跨文件 `global using` 注入，以及 `tsconfig.json`/`jsconfig.json` 之外的自定义构建别名无法在不调用完整编译器的情况下静态证明；对于可识别的动态加载（`import()`、`require(expr)`、`importlib`、`plugin.Open`、`dlopen`/`LoadLibrary`、`Class.forName`、`Assembly.Load`/`Type.GetType`），系统会作为 **低置信度告警** 提示人工复核。

### 3.3 Agent 时光机的捕获范围边界
- **仅拦截接入钩子的 Agent 文件编辑工具**：快照通过 `hooks.json`（`PreToolUse` / `PostToolUse`）监听 `write_file`、`edit_file`、`write_to_file`、`replace_file_content` 与 `multi_replace_file_content`。
- **不捕获终端命令（`run_command`）造成的文件改动**：通过终端执行的 `sed`、`rm`、`git checkout`、`prettier --write`、代码生成脚本或数据库迁移脚本绕过了文件编辑工具钩子，**不会**生成时光机快照。
- **主动跳过规则**：大于 **5 MiB** 的单文件、符号链接以及敏感文件（`.git/**`、`.env*`、`*.pem`、`*.key`、`.ssh/*`、凭据文件）会被主动排除。
- **容量配额上限**：单个工作区采用 LRU 淘汰策略，默认上限 **50 个恢复点 / 200 MiB**。**时光机是两次 Git 提交之间的轻量安全网，绝不能替代 Git 版本控制。**

### 3.4 仓库规模与可视化图谱上限
- **工作区扫描上限**：默认扫描上限为 **5,000 个文件**（超出上限的活跃 Git 变更文件仍会强制保留）。面对 20,000+ 文件的巨型 Monorepo，建议直接将目标子包目录作为工作区打开，以获得最佳速度与图谱清晰度。
- **内联 SVG 图谱上限**：为保证侧边栏可读性，可视化图谱最多渲染 **120 个节点 / 260 条边**（单列最多展示 **14 个节点**，超出部分显示 `+N` 提示引导至文件树页签）。
- **初始 Trajectory 体积预算**：`open_workbench` 初始轨迹载荷控制在 600 个文件以内（远低于 Antigravity 1 MiB 轨迹截断红线），超量文件通过 `app_get_workbench_state` 二次无感补齐。

### 3.5 宿主工作面与系统环境约束
- **非 Windows 系统尚未经过作者实机人工测试**：目前仅 **Windows** 宿主机经过作者实机运行测试；macOS、Linux 等系统仅基于 AI Agent 进行了自动化测试与跨平台代码适配，无法保证真实环境 100% 完全适配，非 Windows 宿主机请谨慎下载（详见 [跨平台实机测试状态与兼容性免责声明](./PLATFORM_TESTING_DISCLAIMER.zh-CN.md)）。
- **部分交互依赖宿主工作面能力**：原生 `fileView` 跳转（`com.google.antigravity/toggle-aux-pane`）与 `updateModelContext()` 上下文胶囊仅在具备会话能力的面板（如 Antigravity 右侧 `aux_pane`）可用；在左侧 `global` 全局栏或第三方 MCP 宿主中会自动隐藏胶囊按钮并降级为内联预览。
- **宿主机 PATH 需可访问 `node >= 20`**：在 macOS 上如果仅通过交互式 Shell（`nvm` / `fnm`）配置 Node，桌面端 GUI 启动插件前需确保登录态 `PATH` 可见 `node`（详见 [安装配置与跨系统兼容指南](./INSTALLATION_AND_COMPATIBILITY.zh-CN.md)）。
- **不自动代跑测试命令**：DiffAtlas 负责推荐关联测试文件，但刻意不自动执行任意测试脚本以严守最小权限原则。

---

## 4. 互补工具对照（什么时候该用别的工具）

| 你的核心诉求 | 推荐配合工具 |
| :--- | :--- |
| 完整版本历史、分支协作，或回滚终端命令（`run_command`）修改 | **Git**（DiffAtlas 时光机与 Git 互补） |
| 编译器级精确符号重命名、类型报错检查、函数调用层级跳转 | **IDE 内置 LSP / `tsc` / `pyright`** |
| 跨 10 万+ 文件的多语言（Java / Go / C++ / Rust）企业级代码索引 | **SCIP / LSIF / Sourcegraph / IDE 工程索引器** |
| 实际执行测试并验证断言 | **Vitest / Jest / Pytest**（可先依据 DiffAtlas 推荐测试列表定向运行） |

---

## 5. 后续演进路线

在严守 **零原生 C++ 编译依赖（无 `node-gyp`）** 底线的前提下，后续计划按社区反馈（[GitHub Issues](https://github.com/JiuYue-sky/DiffAtlas/issues)）推进：

- **继续扩展零原生依赖语言解析器**：PHP（`composer.json` PSR-4）、Ruby（`require_relative`）、Dart/Flutter（`package:`）与 Swift。
- **符号感知的 Barrel 追踪**：可选导出符号提示过滤，降低修改大型聚合导出 `index.ts` 时的保守过报噪音。
- **可配置的图谱跳数与忽略规则覆盖**：在 `${PLUGIN_DATA}` 中支持按工作区持久化扫描与跳数偏好。
- **上架 Google Antigravity 官方插件市场**：在 `v0.1.0` 正式版完成首批社区反馈验证后提交官方 Marketplace。

---

返回 [简体中文 README](../README.zh-CN.md) · [English Version](./SCOPE_AND_LIMITATIONS.md)
