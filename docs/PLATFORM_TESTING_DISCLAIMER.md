# Platform Testing Status & Cross-OS Compatibility Disclaimer

[简体中文](./PLATFORM_TESTING_DISCLAIMER.zh-CN.md) | **English**

> [!CAUTION]
> **Important Notice for Non-Windows Users**: To date, DiffAtlas has **only been physically run and manually tested by the author on Windows**. All non-Windows operating systems — including **macOS, Linux distributions, WSL, and container environments** — have **NOT been manually tested on real non-Windows hardware**; their cross-platform adaptations were implemented and verified **solely through AI Agent-assisted engineering and automated tests**. Full compatibility on non-Windows hosts **cannot be guaranteed**. If you are running a non-Windows host OS, please **download and evaluate with caution**.

---

## 1. Real-World Platform Verification Matrix (`v0.1.0`)

To maintain complete transparency with open-source users, the table below distinguishes hands-on physical verification from Agent-driven automated testing:

| Host Operating System | Hands-On Physical Testing by Author | AI Agent Automated Tests & Code-Level Adaptation | Current Compatibility Confidence |
| :--- | :---: | :---: | :--- |
| **Windows 10 / 11** | **Yes (Physically Tested)** | Covered | Author's primary development and verification environment; build, unit tests, cleanroom self-audit, and plugin staging verified directly on Windows |
| **macOS (Apple Silicon / Intel)** | **No (Not Physically Tested)** | Agent-driven automated tests & static checks only | Code includes APFS Unicode NFC normalization, `/private/var` `realpath` handling, async `stdin`, and POSIX mode preservation, **but has not been verified on a physical Mac** |
| **Linux (Ubuntu / Debian / Fedora, etc.)** | **No (Not Physically Tested)** | Agent-driven automated tests & static checks only | Code includes case-sensitive path preservation, process-group cleanup, and zero `node-gyp` pure-JS bundles, **but has not been verified on a live Linux desktop/CLI host** |
| **WSL / Remote Containers / Other Unix-like Hosts** | **No (Not Physically Tested)** | Agent-driven unit simulations only | Cross-OS mount boundaries (e.g., `/mnt/c`), Git ownership checks, and GUI WebView forwarding remain unverified on real setups |

---

## 2. Why Agent-Driven Automated Testing Cannot Guarantee Full Real-Host Compatibility

Although DiffAtlas uses a zero-native-addon (`node-gyp`-free) pure Node.js + single-file HTML architecture, automated tests executed via an AI Agent cannot fully replicate every real-world OS/host behavior:

1. **Desktop GUI `PATH` & Environment Inheritance**: On macOS and certain Linux desktop environments, launching GUI apps outside an interactive terminal may not inherit `nvm` / `fnm` / Homebrew `node` paths, preventing `mcp_config.json` or `hooks.json` from spawning `node`.
2. **Host WebView Rendering Differences**: Windows, macOS, and Linux WebView runtimes can differ subtly in SVG layout metrics, font rendering, scrollbars, and Pointer Capture split-pane resizing.
3. **Filesystem & OS Security Policies**: macOS Gatekeeper / folder permissions, Linux SELinux / AppArmor confinement, symlink topologies, POSIX file permissions, and Git line-ending (`core.autocrlf`) settings may surface edge cases that simulated tests do not catch.
4. **Lifecycle Hook Subprocess Pipes**: Host subprocess spawning (`cmd /c` on Windows vs `sh -c` on Unix) and non-blocking `stdin`/`stdout` pipe buffering behave differently across OS kernels.

---

## 3. Precautionary Guidance for Non-Windows Host Users

If you choose to download or try DiffAtlas on **macOS, Linux, or another non-Windows host**:

1. **Download with Caution & Test in a Disposable Workspace First**: Do **not** deploy directly onto mission-critical production repositories right away. First verify workbench loading, dependency graphs, and hook behavior on a non-critical scratch repository.
2. **Keep Clean Git Commits Before Testing Rollback**: Before testing Agent Time Machine rollback on an unverified OS, commit or stash your working tree in Git so your files always have an independent safety baseline.
3. **Clean, Zero-Residue Removal Anytime**: DiffAtlas modifies no system-wide settings. If you encounter any host incompatibility, disable the plugin in Antigravity or remove `~/.gemini/config/plugins/diffatlas/`.

---

## 4. Reporting Real-Machine Feedback

If you test DiffAtlas on a real macOS or Linux machine — whether everything works smoothly or you hit an OS-specific bug — please share your OS version and `node -v` output so real-hardware verification can be tracked openly:

- **GitHub Issues**: <https://github.com/JiuYue-sky/DiffAtlas/issues>
- **Maintainer Email**: `jiuyue200712@gmail.com`

---

Back to [README (English)](../README.md) · [Installation & Compatibility Guide](./INSTALLATION_AND_COMPATIBILITY.md) · [简体中文版声明](./PLATFORM_TESTING_DISCLAIMER.zh-CN.md)
