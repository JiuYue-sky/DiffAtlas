# 版本升级、GitHub 开源发版与 Antigravity 市场上架指南

**简体中文** | [English](./RELEASE_AND_UPDATING_GUIDE.md)

本文档涵盖两套标准操作流程：
1. **宿主机用户**：如何在不丢失时光机快照与界面偏好的前提下安全升级 DiffAtlas。
2. **维护者 / 作者**：如何递增版本号、执行洁净室门禁、发布 GitHub Releases、配置 GitHub / Google Antigravity (`agy`) 高权重检索元数据以及提交官方 **Antigravity Marketplace**。

---

## 1. 宿主机用户升级方式

DiffAtlas 将全部时光机快照（`snapshots/`）、最近工作区记录（`state/`）、界面偏好（语言、主题覆盖、分屏比例）以及 `audit.jsonl` 持久化在独立于 `${PLUGIN_ROOT}` 之外的 `${PLUGIN_DATA}` 中，因此**升级插件目录不会丢失任何本地数据**。

### 通过 Antigravity CLI (`agy`) 升级
```bash
agy plugin install https://github.com/JiuYue-sky/DiffAtlas
# 或指定特定版本 Tag：
agy plugin install https://github.com/JiuYue-sky/DiffAtlas/tree/v0.1.0
```

### 通过 GitHub Releases 离线压缩包升级
1. 下载新版 `diffatlas-plugin-v<版本>.zip`（或 `.tar.gz`）并核对 `.sha256`。
2. 用解压后的 `diffatlas/` 覆盖 `~/.gemini/config/plugins/diffatlas/`（Windows 为 `%USERPROFILE%\.gemini\config\plugins\diffatlas\`）。
3. 在 Antigravity 的 **MCP Servers** 设置中对 `diffatlas_diffatlas` 点击 **Restart**（运行中的旧 MCP 进程需要重启以加载新版产物）。
4. 打开 DiffAtlas → **诊断 (Probe)** 页签确认服务已切换至新版本号。

---

## 2. 作者 SemVer 开源发版标准流程

### 语义化版本节奏
- **公开测试期（Pre-release）**：`0.1.0-beta.1` → `0.1.0-beta.2` → `0.1.0-rc.1`
  - 对应 Git Tag：`v0.1.0-beta.1`，在 GitHub Release 页面勾选 **Set as a pre-release**。
- **首个正式稳定版**：`0.1.0`（核心接口与 `src/kit/` 定型后可晋升 `1.0.0`）。

### 推送 Tag 前的 5 步强制核验清单
1. **同步更新全部版本声明位点**：
   - `package.json`（`"version"`）
   - `plugin.json`（`"version"`）
   - `src/shared/identity.ts`（`DIFFATLAS_IDENTITY.version`）
   - `README.md`、`README.zh-CN.md` 徽章与 `CHANGELOG.md`（中英双语变更说明）
2. **本地运行全量洁净室门禁与独立包体打包**：
   ```bash
   npm run verify
   npm run package:release -- v0.1.0
   ```
   确认以下全部通过：
   - `tsc --noEmit`：0 错误；
   - `vitest run`：全量单测通过；
   - `npm run audit:self`：全部 `[PASS]`（0 警告、0 路径/密钥泄露、全部文档零死链、版本号一致）；
   - `dist/server/index.mjs`、`dist/hooks/lifecycle-hook.cjs`、`dist/ui/app.html` 已同步更新并随仓库提交；
   - `.agents/`、`dist/build_verification.json`、`dist/release/` 处于忽略状态且 `git status` 洁净。
3. **（可选，装有 `agy` CLI 时）执行官方严格校验**：
   ```bash
   agy plugin validate --strict .
   ```
4. **推送 `main` 并等待三平台 CI 全绿**：
   - 确认 `.github/workflows/ci.yml` 在 `ubuntu-latest`、`macos-latest`、`windows-latest` × Node `20` / `22` 全部 6 个矩阵任务通过。
5. **打标注 Tag 并推送触发自动打包**：
   ```bash
   git tag -a v0.1.0 -m "release: v0.1.0"
   git push origin main --follow-tags
   ```
   - `.github/workflows/release-packager.yml` 会自动执行 `npm run verify` 并将 `.zip`、`.tar.gz`、`.sha256` 与 `build_verification.json` 上传至 Workflow Artifacts，核查无误后附挂发布 GitHub Release。

---

## 3. GitHub 仓库 SEO 与 `agy` 生态检索权重配置建议

在 GitHub 仓库主页（`https://github.com/JiuYue-sky/DiffAtlas`）配置 **About** 栏时，建议填入以下元数据以提升 **Google Antigravity (`agy`)** 与 **MCP Apps** 检索权重：

- **推荐仓库简介（Description）**：
  > Google Antigravity (agy) MCP App plugin: interactive Git diff, 8-language dependency impact graph, safe checkpoint rollback, and reusable plugin kit.
- **推荐主页链接（Website）**：
  > `https://github.com/JiuYue-sky/DiffAtlas#readme`
- **推荐 GitHub Topics（最多 20 个）**：
  ```text
  antigravity, google-antigravity, agy, antigravity-plugin, antigravity-mcp-app,
  mcp-app, mcp-apps, mcp-server, model-context-protocol, sep-1865,
  ai-coding-agent, git-diff, dependency-graph, blast-radius, impact-analysis,
  code-review, time-machine, rollback, polyglot, typescript
  ```

---

## 4. 提交至 Google Antigravity 官方插件市场（Marketplace）

DiffAtlas 从首个测试版起即按官方 Marketplace 准入标准构建：
- 根目录 `plugin.json` 严格遵循 `https://antigravity.google/schemas/v1/plugin.json`（含 `name`、`displayName`、`version`、`description`、`logo`、3 条 `suggestedPrompts`、`author`、`homepage`、`repository`、`license`、`keywords`）。
- 随包提供高对比度双主题 1:1 图标 `assets/logo.svg`（内置 >10% 外边距）。
- 零原生二进制依赖、零外部网络请求、全量宽松开源许可证传递依赖链与完备的 `README.md`。
- 待测试版稳定迈入 `v0.1.0`+ 后，使用 `agy plugin validate --strict .` 校验零警告并按官方 [Build & Publish Plugins 指南](https://antigravity.google/docs/build-plugins#publish-to-the-antigravity-marketplace) 提交；上架后即可在 `README.md` 中嵌入 `antigravity://plugin/diffatlas?marketplace=antigravity-plugins-partners` 一键直达深链。

---

返回 [简体中文 README](../README.zh-CN.md) · [English Version](./RELEASE_AND_UPDATING_GUIDE.md)
