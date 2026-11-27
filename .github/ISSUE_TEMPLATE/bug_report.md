---
name: Bug Report / 问题反馈
about: Report a bug, cross-OS compatibility issue, or Antigravity (agy) integration problem
title: "[Bug] "
labels: bug
---

## 1. Host Environment / 宿主机环境
- **OS & Architecture / 操作系统**: e.g. Windows 11 24H2 x64 / macOS 15 arm64 / Ubuntu 24.04 x64
- **Antigravity Surface / 运行载体**: Antigravity App (2.0) / Antigravity CLI (`agy`) / Antigravity IDE / Third-party MCP Client (specify)
- **Node.js Version (`node -v`)**: e.g. v22.14.0 (requires `>= 20.0.0`)
- **Git Version (`git --version`)**: e.g. 2.47.0 (or N/A for non-Git workspace)
- **DiffAtlas Version**: e.g. `v0.1.0`
- **Install Method / 安装方式**: `agy plugin install` / Global `~/.gemini/config/plugins/diffatlas/` / Workspace `.agents/plugins/diffatlas/`

## 2. Symptoms & Reproduction Steps / 复现步骤
1. Action performed (e.g., opened `aux_pane`, ran `analyze_diff_impact`, triggered `PreToolUse` rollback):
2. Expected behavior:
3. Actual behavior:

## 3. Diagnostics / 诊断信息 (Do NOT paste secrets or personal paths!)
Please attach the output of the **Probe / 诊断** tab or `npm run audit:self` (redacted):
```text
Paste diagnostic output here...
```

> For private logs or security-sensitive issues, please do not disclose publicly — see [SECURITY.md](../../SECURITY.md) or email `jiuyue200712@gmail.com`.
