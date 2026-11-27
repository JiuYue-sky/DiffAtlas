---
name: diffatlas
description: Visual change review, deterministic file-level dependency impact analysis, and safe Agent checkpoint management with DiffAtlas. Activate when the user wants to inspect workspace changes, evaluate blast radius before or after edits, find affected downstream modules/tests, or open the DiffAtlas workbench.
license: MIT
compatibility: Requires Node.js >= 20 LTS; works across Windows, macOS, and Linux (Git optional).
---

# DiffAtlas Workflow

Use DiffAtlas MCP tools to maintain an accurate mental model of workspace changes and downstream impact:

1. **Open the Interactive Workbench (`open_workbench`)**:
   - Launches or updates the DiffAtlas MCP App (`aux_pane` or `global` view) showing workspace files, Git diff status, dependency impact chain, and Time Machine checkpoints.
   - Always pass `{}` or `{"workspacePath": "<current-workspace>"}` so the user gets live visual inspection alongside structured text output.
2. **Analyze Blast Radius (`analyze_diff_impact`)**:
   - Returns deterministic file-level import/export impact chains with exact `file:line` source evidence and recommended test files.
   - Works identically in GUI hosts and headless CLI environments (returns clean Markdown evidence tables).
3. **Inspect Checkpoints (`list_checkpoints`)**:
   - Lists millisecond `PreToolUse` file snapshots recorded automatically before file modifications.
   - Note: Restoring or rolling back files (`app_restore_checkpoint`) is strictly reserved for human confirmation inside the DiffAtlas UI (`visibility: ["app"]`). Never attempt to overwrite user files manually to simulate a rollback unless explicitly instructed by the user.
