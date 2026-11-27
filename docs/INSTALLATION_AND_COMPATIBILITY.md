# Installation, Cross-OS Compatibility & Troubleshooting Guide

[简体中文](./INSTALLATION_AND_COMPATIBILITY.zh-CN.md) | **English**

> [!CAUTION]
> **Important Notice for Non-Windows Hosts**: Apart from **Windows**, support for macOS, Linux, and WSL has **only been verified via AI Agent automated tests without hands-on physical machine testing by the author**. Full compatibility on non-Windows systems cannot be guaranteed — please download with caution. Read **[Platform Testing Status & Compatibility Disclaimer](./PLATFORM_TESTING_DISCLAIMER.md)**.

---

## 1. Prerequisites

| Requirement | Version | Required? | Notes |
| :--- | :--- | :---: | :--- |
| **Node.js** | `>= 20.0.0` (LTS 20 / 22 / 24) | **Yes** | Must be available as `node` in your system `PATH` so Antigravity can launch `mcp_config.json` and `hooks.json` |
| **Google Antigravity** | App 2.0 / CLI (`agy`) / IDE | Recommended | Also compatible with any MCP Apps (`SEP-1865`) or standard Stdio MCP client |
| **Git** | `>= 2.20` | Optional | Enables live diff status, branch detection, and unified diff previews; non-Git folders degrade cleanly to filesystem-only dependency analysis |
| **Python / Docker / C++ (`node-gyp`)** | — | **Not Required** | Zero native addons; all 8 mainstream language parsers run purely in Node.js |

---

## 2. Choosing Global vs. Workspace Installation

Understanding how Google Antigravity discovers plugins avoids the most common setup confusion:

| Install Mode | Path | Scope & Behavior | Best For |
| :--- | :--- | :--- | :--- |
| **Global Plugin (Recommended)** | **Windows**: `%USERPROFILE%\.gemini\config\plugins\diffatlas\`<br>**macOS / Linux**: `~/.gemini/config/plugins/diffatlas/` | Always active across **all** workspaces, available in both right-hand **`aux_pane`** and left-hand **`global`** sidebar, survives restarts regardless of which folder is open | Everyday developers using DiffAtlas across multiple repositories |
| **Workspace-Scoped Plugin** | `<your-repo>/.agents/plugins/diffatlas/` | Discovered **only** when `<your-repo>` is an active workspace; not visible in workspaces outside `<your-repo>` | Team-shared repo config or developing DiffAtlas itself (`npm run build` stages here automatically) |

> [!WARNING]
> **Avoid Name Collisions**: Plugin names share a single namespace (`"name": "diffatlas"`). If you install DiffAtlas globally **and** also have a workspace copy inside `.agents/plugins/diffatlas/`, the workspace copy takes higher precedence and shadows the global copy. Contributors cloning the `DiffAtlas` source repo benefit from `.agents/` being gitignored by default.

---

## 3. Installation Methods

### Method 1: Antigravity CLI (`agy plugin install`) — Fastest (Zero Build)
Works identically on Windows (PowerShell / CMD), macOS (zsh / bash), and Linux:

```bash
agy plugin install https://github.com/JiuYue-sky/DiffAtlas
agy plugin list
```

### Method 2: GitHub Releases Standalone Archive (Offline / Air-Gapped Friendly)
1. Download the latest archive and `.sha256` from [GitHub Releases](https://github.com/JiuYue-sky/DiffAtlas/releases).
2. Verify checksum:
   ```bash
   # macOS / Linux
   shasum -a 256 -c diffatlas-plugin-v0.1.0.tar.gz.sha256
   # or
   sha256sum -c diffatlas-plugin-v0.1.0.tar.gz.sha256
   ```
   ```powershell
   # Windows PowerShell
   Get-FileHash .\diffatlas-plugin-v0.1.0.zip -Algorithm SHA256
   Get-Content .\diffatlas-plugin-v0.1.0.zip.sha256
   ```
3. Extract `diffatlas/` into `~/.gemini/config/plugins/`:
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
4. Confirm in Antigravity App under **Customizations > Installed** (no restart required for newly added plugins).

### Method 3: Build & Install Locally from Source
```bash
git clone https://github.com/JiuYue-sky/DiffAtlas.git
cd DiffAtlas
npm install
npm run verify

# Optional: validate with agy CLI and install globally from local directory
agy plugin validate --strict .
agy plugin install .
```

### Method 4: Third-Party MCP Clients (Claude Desktop / Cursor / Custom Hosts)
Add DiffAtlas as a standard Stdio MCP server in your client's MCP configuration (replacing `/abs/path/to/diffatlas` with your extracted folder):

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

- Hosts supporting **MCP Apps (`SEP-1865`)** render the full interactive UI and gracefully fall back (`-32601`) to resizable inline diff preview when clicking files.
- Non-UI MCP hosts receive clean, structured Markdown evidence reports from `analyze_diff_impact`, `open_workbench`, and `list_checkpoints`.

---

## 4. Platform-Specific Notes & Cross-OS Adaptations

### Windows 10 / 11 (x64 & arm64)
- **Long Paths & Drive Casing**: `PathGuard` strips `\\?\` / `\\?\UNC\` prefixes while delegating >260 char paths cleanly to Node's native filesystem APIs, normalizes drive letter casing (`D:\` vs `d:\`), and blocks reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1–9`, `LPT1–9`).
- **NTFS Antivirus Contention**: Atomic writes use sibling temp files with incremental retry backoff so Windows Defender scans do not fail index updates.
- **UTF-8 BOM Files**: `.gitignore` and `tsconfig.json` files saved with a UTF-8 BOM (`\uFEFF`) by Visual Studio or PowerShell are stripped automatically.
- **Lifecycle Hooks (`cmd /c`)**: `hooks.json` executes `node dist/hooks/lifecycle-hook.cjs` with zero Unix-only shell syntax (`./foo.sh`, `$VAR`).

### macOS (Apple Silicon arm64 & Intel x64)
- **APFS / HFS+ Unicode NFD vs NFC**: `toPosixPath` normalizes filenames to NFC on macOS so NFD on-disk filenames match NFC import specifiers cleanly.
- **`/var` → `/private/var` Symlinks**: `PathGuard` canonicalizes both workspace root and target via `fs.realpathSync.native` so temp/symlinked directories never trigger false containment errors.
- **Executable Permission Preservation**: Rolling back shell scripts (`chmod +x`, e.g., `0755`) via the Agent Time Machine preserves POSIX mode bits.
- **Node PATH in GUI Apps**: If you installed Node.js via `nvm`, `fnm`, `asdf`, or Homebrew on macOS and Antigravity App reports `node: command not found`, ensure your login shell profile (`~/.zprofile`) exports `PATH` or symlink `node` into `/usr/local/bin/node` (Intel) / `/opt/homebrew/bin/node` (Apple Silicon).

### Linux & WSL / Containers
- **Byte-Exact Case-Sensitive Paths**: On Linux (`ext4`/`xfs`), `PathGuard` preserves exact filename bytes and case sensitivity (never lowercasing containment comparisons or directory pruning boundaries).
- **Go Pipe Non-Blocking Stdin (`EAGAIN`)**: `lifecycle-hook.cjs` reads `process.stdin` asynchronously instead of `fs.readFileSync(0)`, preventing `EAGAIN` errors when invoked by Go-based language servers on Linux/macOS.
- **Process Tree Cleanup**: Timed-out child processes (`git`) are spawned in their own process group (`detached: true`) and terminated via `-pid` `SIGKILL` to avoid orphan processes.

---

## 5. Troubleshooting FAQ

1. **DiffAtlas does not appear in the `+` menu or left sidebar after restarting Antigravity**
   - Check whether DiffAtlas was installed **globally** (`~/.gemini/config/plugins/diffatlas/`) or only inside one repository's `.agents/plugins/diffatlas/`. Workspace-scoped plugins only appear when that specific workspace is open.
   - Open **Customizations > Installed** and verify `DiffAtlas` is enabled and its MCP server `diffatlas_diffatlas` is `READY` under **MCP Servers**.
   - Confirm `node -v` is `>= 20.0.0` in the environment visible to Antigravity.
2. **Banner shows `Git status unavailable (fatal: detected dubious ownership...)`**
   - Common on Windows/WSL/Docker when a repository is owned by a different OS user. DiffAtlas intentionally never bypasses Git's ownership check; add your trusted workspace via `git config --global --add safe.directory <path>` if you trust that folder, or continue using DiffAtlas in filesystem-only What-If mode.
3. **Why does clicking a file in the Left Global Sidebar open Inline Preview instead of native `fileView`?**
   - By design in Google Antigravity, the `global` sidebar view has no conversation side pane (`com.google.antigravity/toggle-aux-pane` returns `isError: true` and `updateModelContext` is absent). DiffAtlas detects this automatically and opens the resizable inline preview drawer instead. Open DiffAtlas from the right-hand **`aux_pane`** inside a conversation for native `fileView` jump and Context Pill attachment.
4. **Why do `.md` / `.json` / `.css` files not show a `Simulate Impact` button in the file tree?**
   - Deterministic import-graph simulation applies to supported source languages (**TS/JS, Vue/Svelte/Astro, Python, Go, Rust, C/C++, Java/Kotlin, and C#**; see [Scope, Strengths & Limitations](./SCOPE_AND_LIMITATIONS.md)). Non-code files still support **Diff** preview, **fileView** jump, Context Pill attachment, and Time Machine snapshots.
5. **Where are Time Machine snapshots and logs stored, and how do I clear them?**
   - All snapshots, preferences, and rotating `audit.jsonl` logs live strictly inside `${PLUGIN_DATA}` (or fallback `~/.gemini/antigravity-plugin-data/diffatlas/`). LRU eviction automatically caps storage at 50 checkpoints / 200 MiB per workspace, and you can delete that directory anytime to reset plugin data cleanly.

---

Back to [README (English)](../README.md) · [简体中文版安装指南](./INSTALLATION_AND_COMPATIBILITY.zh-CN.md)
