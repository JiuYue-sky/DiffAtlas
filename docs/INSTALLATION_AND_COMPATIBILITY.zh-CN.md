# 安装配置、跨系统适配与排错指南（Windows / macOS / Linux）

**简体中文** | [English](./INSTALLATION_AND_COMPATIBILITY.md)

> [!CAUTION]
> **非 Windows 宿主机重要提示**：除 **Windows** 外，macOS、Linux 与 WSL 等系统目前**仅基于 AI Agent 完成了代码适配与自动化测试，未经作者实机人工测试**，无法保证完全适配，非 Windows 宿主机请谨慎下载。完整说明见 **[跨平台实机测试状态与兼容性免责声明](./PLATFORM_TESTING_DISCLAIMER.zh-CN.md)**。

---

## 1. 运行环境要求

| 依赖项 | 版本要求 | 是否必需 | 说明 |
| :--- | :--- | :---: | :--- |
| **Node.js** | `>= 20.0.0`（LTS 20 / 22 / 24） | **必需** | 须确保系统 `PATH` 中可直接调用 `node`，以便 Antigravity 启动 `mcp_config.json` 与 `hooks.json` |
| **Google Antigravity** | App 2.0 / CLI (`agy`) / IDE | 推荐 | 同时兼容任意 MCP Apps (`SEP-1865`) 或标准 Stdio MCP 客户端 |
| **Git** | `>= 2.20` | 可选 | 用于读取分支、变更状态与统一 Diff 预览；非 Git 文件夹可自动零子进程降级运行依赖图分析 |
| **Python / Docker / C++ (`node-gyp`)** | — | **不需要** | 零原生 C++ 编译依赖；全部 8 大主流语言解析器均在 Node.js 内纯脚本运行 |

---

## 2. 全局安装 vs 工作区安装（避坑必看）

了解 Google Antigravity 的插件发现机制可避免最常见的“重启后找不到插件”困惑：

| 安装模式 | 目录位置 | 作用域与行为 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **全局插件安装（推荐）** | **Windows**：`%USERPROFILE%\.gemini\config\plugins\diffatlas\`<br>**macOS / Linux**：`~/.gemini/config/plugins/diffatlas/` | 在**所有工作区**持久生效，右侧 **`aux_pane`** 与左侧 **`global`** 侧栏随时可用，重启 Antigravity 后不依赖特定打开目录 | 日常跨多个仓库使用 DiffAtlas 的所有开发者 |
| **工作区级插件** | `<项目根目录>/.agents/plugins/diffatlas/` | **仅在打开该项目工作区时**被发现加载；切换到其他目录时不会出现 | 团队仓库内共享配置，或开发 DiffAtlas 本身（`npm run build` 自动生成本地调试镜像） |

> [!WARNING]
> **避免同名插件冲突**：插件名（`"name": "diffatlas"`）全局共享命名空间。如果你既做了全局安装，又在当前项目里有 `.agents/plugins/diffatlas/`，工作区副本优先级更高并会覆盖全局插件。本仓库默认在 `.gitignore` 中忽略 `.agents/`，避免贡献者克隆源码时引发冲突。

---

## 3. 详细安装方式

### 方式一：通过 Antigravity CLI (`agy plugin install`) 一键直装（最快捷、零编译）
在 Windows（PowerShell / CMD）、macOS（zsh / bash）与 Linux 上命令完全一致：

```bash
agy plugin install https://github.com/JiuYue-sky/DiffAtlas
agy plugin list
```

### 方式二：通过 GitHub Releases 独立压缩包离线安装
1. 前往 [GitHub Releases](https://github.com/JiuYue-sky/DiffAtlas/releases) 下载对应平台的压缩包与 `.sha256` 校验文件。
2. 核对 SHA-256 完整性：
   ```bash
   # macOS / Linux
   shasum -a 256 -c diffatlas-plugin-v0.1.0.tar.gz.sha256
   # 或
   sha256sum -c diffatlas-plugin-v0.1.0.tar.gz.sha256
   ```
   ```powershell
   # Windows PowerShell
   Get-FileHash .\diffatlas-plugin-v0.1.0.zip -Algorithm SHA256
   Get-Content .\diffatlas-plugin-v0.1.0.zip.sha256
   ```
3. 将 `diffatlas/` 解压至全局插件目录：
   ```bash
   # macOS / Linux
   mkdir -p ~/.gemini/config/plugins
   tar -xzf diffatlas-plugin-v0.1.0.tar.gz -C ~/.gemini/config/plugins
   ```
   ```powershell
   # Windows PowerShell
   New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\config\plugins" | Out-Null
   Expand-Archive -Path .\diffatlas-plugin-v0.1.0.zip -DestinationPath "$env:USERPROFILE\.gemini\config\plugins" -Force
   ```
4. 在 Antigravity App 的 **Customizations > Installed** 确认 `DiffAtlas` 已启用（新插件自动发现，无需重启）。

### 方式三：从源码构建并在本机安装（开发者）
```bash
git clone https://github.com/JiuYue-sky/DiffAtlas.git
cd DiffAtlas
npm install
npm run verify

# 可选：使用 agy CLI 严格校验并从本地目录全局安装
agy plugin validate --strict .
agy plugin install .
```

### 方式四：接入其他标准 MCP 客户端（Claude Desktop / Cursor / 自定义宿主）
将 DiffAtlas 配置为标准 Stdio MCP 服务（将 `/abs/path/to/diffatlas` 替换为实际解压路径）：

```json
{
  "mcpServers": {
    "diffatlas": {
      "command": "node",
      "args": [
        "/abs/path/to/diffatlas/dist/server/index.mjs",
        "--plugin-root=/abs/path/to/diffatlas",
        "--data-dir=/abs/path/to/diffatlas-data"
      ]
    }
  }
}
```

- 支持 **MCP Apps (`SEP-1865`)** 的宿主可完整渲染交互式面板，并在点击文件时自动降级（`-32601`）展示可拖动内联 Diff 预览。
- 纯文本 MCP 客户端可直接获得 `analyze_diff_impact`、`open_workbench` 与 `list_checkpoints` 返回的结构化 Markdown 报告。

---

## 4. 三大操作系统专项适配说明

### Windows 10 / 11 (x64 & arm64)
- **长路径与盘符大小写**：`PathGuard` 自动剥离 `\\?\` / `\\?\UNC\` 前缀、归一化盘符大小写（`D:\` vs `d:\`），并跨平台拦截 DOS 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1–9`、`LPT1–9`）。
- **NTFS 杀毒扫描锁竞争**：原子文件写入采用同目录临时文件 + 增量退避重试，避免 Windows Defender 瞬时占用导致索引写失败。
- **UTF-8 BOM 兼容**：自动剥离 Visual Studio / PowerShell 保存 `.gitignore` 与 `tsconfig.json` 时附带的 `\uFEFF` 字节序标记。
- **跨平台 Hook 命令 (`cmd /c`)**：`hooks.json` 直接调用 `node dist/hooks/lifecycle-hook.cjs`，零 Unix 专属 Shell 语法。

### macOS (Apple Silicon arm64 & Intel x64)
- **APFS / HFS+ Unicode NFD/NFC 归一**：`toPosixPath` 在 macOS 上自动执行 NFC 归一化，确保含重音或中日韩字符的文件名与代码导入路径稳定匹配。
- **`/var` → `/private/var` 符号链接**：`PathGuard` 统一使用 `fs.realpathSync.native` 解析工作区与目标路径，杜绝临时目录符号链接误报越界。
- **可执行权限位保留**：时光机回滚 `chmod +x`（如 `0755`）脚本文件时自动恢复 POSIX 权限位。
- **桌面端 GUI 的 `node` PATH**：若在 macOS 上通过 `nvm` / `fnm` / `asdf` / Homebrew 安装 Node 且桌面端提示找不到 `node`，请确保登录 Shell（`~/.zprofile`）导出 `PATH`，或将 `node` 软链至 `/opt/homebrew/bin/node`（Apple Silicon）/ `/usr/local/bin/node`（Intel）。

### Linux 与 WSL / 容器环境
- **字节精确大小写敏感**：在 Linux（`ext4` / `xfs`）下严格保留大小写与原始字节，不在沙箱 containment 或空目录回收中强制小写化。
- **Go 管道非阻塞 `EAGAIN` 防护**：`lifecycle-hook.cjs` 异步流式读取 `process.stdin`，杜绝 Go 语言服务器管道触发 `EAGAIN` 异常。
- **子进程树清理**：超时 `git` 子进程以独立进程组（`detached: true`）派生，超时时通过 `-pid` `SIGKILL` 彻底清理避免孤儿进程。

---

## 5. 常见问题排查（FAQ）

1. **重启 Antigravity 后，右侧 `+` 菜单或左侧栏看不到 `DiffAtlas`**
   - 请确认是**全局安装**（`~/.gemini/config/plugins/diffatlas/`）还是仅放在某个仓库的 `.agents/plugins/diffatlas/`。工作区级插件仅在打开该对应仓库时生效。
   - 打开 **Customizations > Installed** 确认 `DiffAtlas` 已开启，并在 **MCP Servers** 检查 `diffatlas_diffatlas` 状态为 `READY`。
   - 确认 Antigravity 可见环境中的 `node -v` 满足 `>= 20.0.0`。
2. **顶部提示 `Git status unavailable (fatal: detected dubious ownership...)`**
   - 常见于 Windows / WSL / Docker 跨用户挂载目录。DiffAtlas 出于安全原则不会绕过 Git 所有权校验；若信任该仓库，可执行 `git config --global --add safe.directory <路径>`，或直接在纯文件系统 What-If 模式下继续使用。
3. **为什么左侧全局栏里点击文件打开的是底部内联预览，而不是原生 `fileView`？**
   - Google Antigravity 设计上左侧 `global` 全局视图无对话侧栏上下文（`toggle-aux-pane` 返回 `isError: true` 且不提供 `updateModelContext`）。DiffAtlas 会自动检测并无缝回退到可拖动内联预览；需要原生 `fileView` 跳转和上下文胶囊时，请在会话窗口右侧 **`aux_pane`** 中打开 DiffAtlas。
4. **为什么 `.md` / `.json` / `.css` 文件在文件树里没有「预演影响」按钮？**
   - 确定性依赖图预演面向已支持的代码语言（**TS/JS、Vue/Svelte/Astro、Python、Go、Rust、C/C++、Java/Kotlin、C#**，详见 [适用范围、核心强项与当前不足](./SCOPE_AND_LIMITATIONS.zh-CN.md)）；非代码文件仍完整支持「查看 Diff」、「源码」跳转、挂入上下文胶囊与时光机快照。
5. **时光机快照与审计日志保存在哪里，如何清理？**
   - 全部保存在 `${PLUGIN_DATA}`（回退路径 `~/.gemini/antigravity-plugin-data/diffatlas/`）。内置 LRU 自动限制单工作区最多保留 50 个恢复点 / 200 MiB，必要时可直接删除该目录重置状态。

---

返回 [简体中文 README](../README.zh-CN.md) · [English Version](./INSTALLATION_AND_COMPATIBILITY.md)
