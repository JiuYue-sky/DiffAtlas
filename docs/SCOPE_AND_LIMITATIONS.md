# Scope, Strengths & Limitations

[简体中文](./SCOPE_AND_LIMITATIONS.zh-CN.md) | **English**

This document defines the practical engineering boundaries of **DiffAtlas (`v0.1.0`)** — where it delivers the highest value in the **Google Antigravity (`agy`)** and **MCP Apps (`SEP-1865`)** ecosystems, where its current capabilities intentionally stop, and when complementary tools should be used instead.

---

## 1. Ideal Scope & Target Scenarios

DiffAtlas is purpose-built for the following workflows:

1. **Multi-File AI-Assisted Coding in Google Antigravity (`agy`)**
   - Reviewing 2–30 changed files produced by an Agent turn across **TypeScript / JavaScript**, **Vue / Svelte / Astro**, **Python**, **Go**, **Rust**, **C / C++**, **Java / Kotlin**, or **C#** repositories without losing sight of downstream dependents and affected tests.
2. **Pre-Edit "What-If" Blast-Radius Inspection**
   - Clicking **Simulate Impact** on a shared utility, type definition, or core module *before* asking the Agent to refactor it, then attaching impacted modules and recommended tests to your next prompt via `updateModelContext()`.
3. **High-Safety Local Rollback Between Git Commits**
   - Recovering a single file or an entire Agent turn within milliseconds when an exploratory edit goes sideways — without polluting Git history or risking silent overwrites of manual edits.
4. **Building New Google Antigravity (`agy`) Ecosystem Plugins**
   - Reusing the domain-agnostic [`src/kit/`](./ARCHITECTURE_AND_ECOSYSTEM.md) foundation (`PathGuard`, `ProcessGuard`, `PluginStateStore`, `ChunkChannel`, `McpPluginShell`, `UiShell`, `SelfAudit`) as a clean starting point for other local MCP App workbenches.

---

## 2. Core Strengths

| Strength | Concrete Engineering Evidence |
| :--- | :--- |
| **Zero Native Compilation & Instant Cross-OS Install** | Pure TypeScript/JS + WASM runtime (`node-gyp`-free), shipping zero-`node_modules` prebuilt bundles (`dist/`) that install identically on Windows, macOS (Apple Silicon & Intel), and Linux with only Node.js `>= 20 LTS`. |
| **Honest, Evidence-Backed Dependency Graph** | Every graph edge and CLI report row cites exact `file:line` and sanitized source snippets. Dynamic loaders (`import(expr)`, `require(expr)`, `importlib`, `plugin.Open`, `dlopen`/`LoadLibrary`, `Class.forName`, `Assembly.Load`/`Type.GetType`) and JVM wildcard `.*` imports are explicitly labeled **Low Confidence** rather than fabricating false certainty. |
| **Fast Incremental Indexing** | Cold scan of 1,000 files finishes in ~1.6s locally; lazy per-language indexing adds zero overhead for unused languages, and topology-aware incremental re-scans (`mtime + size + file-set/manifest/declaration hash`) finish in `< 300ms`. |
| **Full 5-Pillar Native Antigravity Integration + Graceful Degradation** | Combines MCP App UI (`aux_pane` + `global`), `hooks.json`, `SKILL.md`, `rules/AGENTS.md`, and `${PLUGIN_DATA}` persistence; automatically falls back (`-32601`) to resizable inline diff preview on `global` views or third-party MCP hosts, and to clean Markdown reports in `agy` CLI. |
| **Defense-in-Depth Safety & Offline Privacy** | Human-exclusive rollback (`visibility: ["app"]`), 3-way human-edit conflict gate, mandatory Undo-of-Undo `pre_rollback_backup`, canonical `realpath` `PathGuard` sandboxing, sensitive file denylist (`.git/**`, `.env*`, keys), `default-src 'none'` CSP, zero browser storage, and zero telemetry. |
| **Non-Intrusive Bilingual UX** | Syncs host light/dark CSS tokens live while keeping its `EN / 中文` switch strictly scoped inside the DiffAtlas sandbox iframe (never conflicting with host UI or other localization plugins). |

---

## 3. Current Limitations & Known Gaps (`v0.1.0`)

Being transparent about what DiffAtlas **does not** yet cover helps set clear expectations:

### 3.1 Language Coverage & Remaining Gaps (`v0.1.0`)
- **Currently supported for dependency impact graphs & Simulate Impact (8 mainstream families)**:
  - **TypeScript / JavaScript** (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`)
  - **Vue / Svelte / Astro SFCs** (`.vue`, `.svelte`, `.astro` `<script>` & frontmatter blocks)
  - **Python** (`.py`, `.pyi`)
  - **Go** (`.go` + `go.mod` / `replace` + same-package `_test.go`)
  - **Rust** (`.rs` + Cargo workspaces `Cargo.toml`, `mod`, `use crate::/super::/self::`, `extern crate`)
  - **C / C++** (`.c`, `.h`, `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, `.hxx` `#include`)
  - **Java / Kotlin** (`.java`, `.kt`, `.kts` packages, explicit/static/same-package/wildcard imports)
  - **C#** (`.cs` namespaces, `using static`, alias `using`, type-filtered namespace `using`)
- **Not parsed into dependency edges yet**: PHP, Ruby, Swift, Dart, Scala, Elixir, SQL, Shell scripts, and template-only framework auto-imports (e.g., Nuxt/unplugin auto-imported components without an explicit `import` statement). All of these files still work fully in the file tree, unified diff preview, native `fileView`, Context Pill attachment, and Agent Time Machine rollback — they simply do not render import graph edges yet.

### 3.2 File-Level (Not Symbol / Type / Runtime Call-Graph) Analysis
- **Module-level granularity**: Impact analysis tracks **file-to-file static imports/re-exports** up to **2 hops** (`Hop 0 → 1-hop → 2-hop`), not symbol-level usage or compiler type-checking.
- **Conservative over-approximation on barrel files**: Editing an unused helper inside a heavily re-exported `index.ts` barrel file flags all importers of that barrel as impacted, even if they do not import that specific symbol.
- **No runtime or compiler-macro coupling visibility**: Dependency injection containers, string-based route registries, message queues, HTTP/gRPC contracts, C/C++ conditional `#ifdef` preprocessor evaluation, C# MSBuild `<ImplicitUsings>` / cross-file `global using` injection, and dynamic `sys.path` or custom bundler aliases outside `tsconfig.json` / `jsconfig.json` cannot be proven without running a full compiler. Detected dynamic loaders (`import()`, `require(expr)`, `importlib`, `plugin.Open`, `dlopen`/`LoadLibrary`, `Class.forName`, `Assembly.Load`/`Type.GetType`) are surfaced as **Low Confidence** warnings requiring manual review.

### 3.3 Agent Time Machine Scope & Boundaries
- **Only intercepts hooked Agent file tools**: Snapshots are captured via `hooks.json` (`PreToolUse` / `PostToolUse`) matching `write_file`, `edit_file`, `write_to_file`, `replace_file_content`, and `multi_replace_file_content`.
- **Does NOT snapshot shell-command mutations**: Changes made via terminal commands (`run_command`, e.g., `sed`, `rm`, `git checkout`, `prettier --write`, code generators, or migration scripts) bypass file-tool hooks and are **not** recorded in Time Machine checkpoints.
- **Intentional skip rules**: Single files larger than **5 MiB**, symbolic links, and sensitive files (`.git/**`, `.env*`, `*.pem`, `*.key`, `.ssh/*`, credentials) are intentionally excluded from snapshots.
- **Retention quota**: Per-workspace storage is LRU-capped at **50 checkpoints / 200 MiB**. **Time Machine is a fast safety net between commits — it does NOT replace Git.**

### 3.4 Repository Scale & Visual Graph Ceilings
- **Workspace scan limit**: Default scan caps at **5,000 files** (active Git changed files beyond the cap are still preserved). For very large monorepos (e.g., 20,000+ files), open the specific package subdirectory as your workspace root for optimal speed and clarity.
- **Inline SVG graph caps**: To stay legible inside a side pane, the visual graph displays up to **120 nodes / 260 edges** (up to **14 nodes per column**, with a `+N more` overflow indicator pointing to the Files tab).
- **Initial trajectory budget**: `open_workbench` trims initial trajectory payload to 600 file entries (staying safely under Antigravity's 1 MiB trajectory cap) and hydrates the rest via `app_get_workbench_state`.

### 3.5 Host & Environment Constraints
- **Non-Windows systems have not been manually tested on physical hosts**: Only **Windows** has been physically tested hands-on by the author; macOS, Linux, and other non-Windows systems rely solely on AI Agent-driven cross-platform code adaptations and automated tests, so full compatibility cannot be guaranteed and non-Windows users should download with caution (see [Platform Testing Status & Compatibility Disclaimer](./PLATFORM_TESTING_DISCLAIMER.md)).
- **Surface-dependent capabilities**: Native `fileView` jump (`com.google.antigravity/toggle-aux-pane`) and `updateModelContext()` Context Pills require a conversation surface advertising those capabilities (Antigravity `aux_pane`). In the `global` sidebar or third-party MCP hosts, DiffAtlas hides context-pill controls and falls back to inline preview.
- **Requires `node >= 20` on host `PATH`**: On macOS desktop apps where Node.js is initialized only inside interactive shell profiles (`nvm`/`fnm`), users may need to expose `node` in their login `PATH` (see [Installation & Compatibility Guide](./INSTALLATION_AND_COMPATIBILITY.md)).
- **No automated test execution**: DiffAtlas *recommends* impacted test files based on import chains and naming conventions, but intentionally does not execute arbitrary test commands automatically.

---

## 4. When to Use Complementary Tools

| Primary Need | Recommended Tool |
| :--- | :--- |
| Full version history, branching, team collaboration, or reverting shell commands (`run_command`) | **Git** (DiffAtlas Time Machine complements Git between commits) |
| Compiler-exact symbol rename, type error checking, or call-hierarchy refactoring | **TypeScript (`tsc`) / Pyright / Language Server (LSP)** in your IDE |
| Cross-repo 100k+ file multi-language code intelligence | **SCIP / LSIF / Sourcegraph / IDE project indexers** |
| Executing and asserting test suites | **Vitest / Jest / Pytest** (using DiffAtlas's Recommended Tests list to run targeted subsets first) |

---

## 5. Planned Roadmap

Community feedback via [GitHub Issues](https://github.com/JiuYue-sky/DiffAtlas/issues) directly shapes upcoming releases while preserving our **zero-native-addon** guarantee:

- **Additional zero-native-addon parsers**: PHP (`composer.json` PSR-4), Ruby (`require_relative`), Dart/Flutter (`package:`), and Swift/Objective-C.
- **Export-aware barrel tracing**: Optional symbol-hint filtering to reduce noise when modifying large barrel (`index.ts`) files.
- **Configurable hop depth & ignore overrides**: User-configurable graph hop depth and per-workspace scan preferences persisted in `${PLUGIN_DATA}`.
- **Official Antigravity Marketplace listing**: Submitting DiffAtlas to the official Antigravity Marketplace after initial `v0.1.0` community validation.

---

Back to [README (English)](../README.md) · [简体中文版说明](./SCOPE_AND_LIMITATIONS.zh-CN.md)
