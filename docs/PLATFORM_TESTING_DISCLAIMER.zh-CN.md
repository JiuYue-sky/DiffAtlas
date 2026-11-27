# 跨平台实机测试状态与兼容性免责声明

**简体中文** | [English](./PLATFORM_TESTING_DISCLAIMER.md)

> [!CAUTION]
> **非 Windows 宿主机用户下载前必读**：本项目目前**仅在 Windows 宿主机环境下经过作者实际运行与人工测试**。除 Windows 以外的其他操作系统（包括但不限于 **macOS、Linux 各发行版、WSL 及容器环境**）**均未经过作者实机人工测试**，仅基于 AI Agent 完成了跨平台代码逻辑设计与自动化测试。作者**无法保证非 Windows 系统下的真实完全适配**，请非 Windows 宿主机用户**谨慎下载与使用**。

---

## 1. 各操作系统真实测试状态矩阵

为避免对跨平台成熟度产生误导，特此公开当前版本（`v0.1.0`）在各宿主机系统上的真实核验方式：

| 宿主机操作系统 | 作者实机人工测试 | AI Agent 自动化测试与代码级适配 | 当前适配可靠性说明 |
| :--- | :---: | :---: | :--- |
| **Windows 10 / 11** | **已实测** | 已覆盖 | 作者主力开发与实际运行验证环境，已完成构建、测试、洁净室自检与插件目录验证 |
| **macOS（Apple Silicon / Intel）** | **未实机测试** | 仅基于 Agent 自动化测试与静态规则验证 | 虽在代码层编写了 APFS Unicode NFC 归一化、`/private/var` 符号链接解析、异步 `stdin` 与权限位保留逻辑，但**未经真实 Mac 设备验证**，可能存在未知宿主或系统差异 |
| **Linux（Ubuntu / Debian / Fedora 等）** | **未实机测试** | 仅基于 Agent 自动化测试与静态规则验证 | 虽在代码层编写了大小写敏感路径保护、进程组清理与无原生 `node-gyp` 打包逻辑，但**未经真实 Linux 桌面/终端宿主实测**，无法保证完全兼容 |
| **WSL / 远程容器 / 其他类 Unix 环境** | **未实机测试** | 仅基于 Agent 理论推导与单元测试模拟 | 跨文件系统挂载（如 `/mnt/c`）、Git 所有权校验及 GUI WebView 转发尚未实机核验 |

---

## 2. 为什么“基于 Agent 的自动化测试”不等于“实机完全适配”？

尽管 DiffAtlas 采用了零原生 C++ 编译依赖（无 `node-gyp`）的纯 Node.js + 单文件 HTML 架构，并通过 AI Agent 编写了大量单元与回归测试，但自动化测试无法完全替代真实操作系统宿主环境中的以下客观变量：

1. **宿主机桌面进程的环境变量继承差异**：例如 macOS GUI 应用（从 Finder / Launchpad 启动的 Antigravity 桌面端）默认不加载交互式 Shell（`~/.zshrc`）中的 `nvm` / `fnm` / Homebrew `PATH`，可能导致 MCP 服务或 `hooks.json` 无法找到 `node`。
2. **宿主内置 WebView 内核行为差异**：Windows（WebView2 / Chromium）、macOS（WKWebView / Electron）与 Linux 在内联 SVG 渲染、滚动条、字体回退及 Pointer Capture 拖拽事件上可能存在细微行为差异。
3. **文件系统与系统安全策略差异**：macOS Gatekeeper / 文件夹访问授权、Linux SELinux / AppArmor 沙箱策略、软硬链接结构、挂载卷权限位及 Git 换行符（`core.autocrlf`）配置，均可能在真实机器上引发未在模拟单测中暴露的边界问题。
4. **生命周期钩子（`PreToolUse` / `PostToolUse`）的宿主管道差异**：不同平台下宿主拉起子进程的方式（Windows `cmd /c` vs Unix `sh -c`）与标准输入/输出缓冲行为存在底层系统级差异。

---

## 3. 给非 Windows 宿主机用户的安全评估建议

如果你使用的是 **macOS、Linux 或其他非 Windows 系统**，在决定下载试用前请务必遵循以下审慎原则：

1. **谨慎下载，勿直接用于关键生产仓库**：建议先在**独立的测试文件夹或已有完整 Git 提交备份的非核心仓库**中试用，确认面板加载、依赖图展示与钩子运行正常后再投入日常项目。
2. **试用回滚功能前保持 Git 工作区干净或已备份**：首次在非 Windows 系统验证「时光机回滚」前，请先通过 `git commit` 或 `git stash` 留存基线，双重保障本地代码安全。
3. **遇到异常可随时无损卸载**：DiffAtlas 不修改任何系统级配置；若在非 Windows 宿主机上出现不兼容现象，只需在 Antigravity 中禁用或删除 `~/.gemini/config/plugins/diffatlas/` 目录即可彻底移除。

---

## 4. 欢迎社区实机反馈

如果你在 macOS 或 Linux 实机环境中进行了测试（无论运行正常还是遇到兼容性报错），非常欢迎附带系统版本与 Node.js 版本通过以下方式反馈，帮助项目逐步补齐真实的跨平台实机验证记录：

- **GitHub Issues**：<https://github.com/JiuYue-sky/DiffAtlas/issues>
- **维护者邮箱**：`jiuyue200712@gmail.com`

---

返回 [简体中文 README](../README.zh-CN.md) · [安装配置与跨系统适配指南](./INSTALLATION_AND_COMPATIBILITY.zh-CN.md) · [English Version](./PLATFORM_TESTING_DISCLAIMER.md)
