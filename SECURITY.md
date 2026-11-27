# Security Policy & Threat Model / 安全策略与威胁模型

DiffAtlas is designed for **100% local, offline, zero-telemetry** code review and follows **OWASP MCP Top 10** defense-in-depth principles across Windows, macOS, and Linux.

---

## 1. Built-in Security Boundaries

1. **Canonical Workspace Sandbox (`src/kit/path-guard.ts`)**
   - Every filesystem target is canonicalized via `fs.realpathSync.native` against the canonical workspace root.
   - Blocks `../` lexical traversal, symbolic link and Windows NTFS Junction escapes (for both existing files and not-yet-created ancestor paths), dangling symlinks, NUL bytes (`\0`), ASCII control characters, Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), and external URI schemes (`http(s)://`, `ws(s)://`, `ftp://`, `javascript:`).
2. **Sensitive File Denylist**
   - The entire `.git/**` internal directory (`.git/hooks/*`, `.git/config`, `.git/index`, `.git/HEAD`), `.env`, `.env.*`, `*.pem`, `*.key`, `*.pfx`, `*.p12`, `*.kdbx`, `*.keystore`, `*.jks`, `*.der`, `*.crt`, `id_rsa*`, `id_ed25519*`, `.ssh/*`, `.aws/*`, `.gnupg/*`, `.npmrc`, `.pypirc`, `.netrc`, `.dockerconfigjson`, and `*credentials*/*.json` / `*secret*/*.json` are blocked by default from Diff preview, chunk reading, snapshot blob storage, and checkpoint rollback.
3. **Human-Exclusive Rollback (`visibility: ["app"]`)**
   - `app_restore_checkpoint` and `app_preview_rollback` declare `_meta.ui.visibility = ["app"]`, hiding destructive workspace restore capabilities completely from LLMs.
   - Every restore performs 3-way conflict detection (`CONFLICT_HUMAN_MODIFIED`) and writes a mandatory Undo-of-Undo backup (`pre_rollback_backup`) before modifying any workspace file.
4. **Strict CSP & XSS Isolation (`default-src 'none'`)**
   - Built single-file UI (`dist/ui/app.html`) contains zero external scripts or stylesheets (100% compliant with Antigravity's `default-src 'none'` iframe CSP), zero `dangerouslySetInnerHTML`, and zero browser storage (`localStorage` / `sessionStorage` / `IndexedDB`).
   - Untrusted repository filenames and import snippets are sanitized against Unicode bidi overrides and control characters before embedding into model-visible Markdown.
5. **Process & Lifecycle Hook Circuit Breakers (`src/kit/process-guard.ts`)**
   - All subprocesses execute with `shell: false`, strict stdout/stderr byte caps, and cross-platform process-tree termination (`taskkill /T /F` on Windows, negative PGID `SIGKILL` on macOS/Linux).
   - `PreToolUse` and `PostToolUse` hooks use non-blocking async stdin streaming with an active 3.5s fail-open watchdog (`timeout: 5` in `hooks.json`) so filesystem errors or pipe stalls never block the Agent loop.
6. **Automated Cleanroom Self-Audit (`npm run audit:self`)**
   - Scans source code, documentation, prebuilt bundles, and `dist/build_verification.json` for hardcoded secrets, personal machine paths, native binaries, broken links, and non-permissive dependency licenses, and verifies end-to-end Stdio MCP execution in an isolated zero-`node_modules` temporary directory.

---

## 2. Reporting a Vulnerability / 安全漏洞私密反馈

Please **do not** disclose security vulnerabilities (such as path traversal, symlink escape, secret leakage, or unintended rollback overwrites) in public GitHub Issues. Report them privately through either channel:

- **GitHub Security Advisories** (recommended): [Report a vulnerability privately](https://github.com/JiuYue-sky/DiffAtlas/security/advisories/new)
- **Maintainer Email**: `jiuyue200712@gmail.com`

Please include reproduction steps, OS & Node.js version, Antigravity surface (App / CLI / IDE), and DiffAtlas version. Verified reports will be acknowledged promptly and patched with a coordinated security release.
