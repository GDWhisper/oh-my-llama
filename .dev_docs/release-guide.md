# 发布指导（Release Guide）— 供 AI Agent 使用

> **何时阅读本文档**：当需要进行版本发布（提交 / 打标签 / 触发 CI / 编写 Release Note 或更新 CHANGELOG）时，**必须**先阅读本文档，并严格遵守其中的流程与分工，不得凭默认习惯发布。

> **适用范围**：`oh-my-llama`（Tauri 2 + React/TS 桌面应用）。发布仅出 **Windows** 安装包（`.exe` NSIS / `.msi`），由 `.github/workflows/release.yml` 在推送 `v*` 标签时自动构建。

---

## 一、前置约定（发布前必读）

1. **Git worktree 结构**：`dev` 工作树（`F:\llama_run\llama-launcher-dev`）与 `main` 工作树（`F:\llama_run\tauri-launcher`）共享同一 `.git`。**`dev` 工作树不能 `git checkout main`**（被另一 worktree 占用）——合并必须到 `main` 工作树执行。重大改动先落 `dev`，勿直提交 `main`。
2. **排除项**：提交时**必须排除** `.claude/`、`.mcp.json`（外来 AI 工具脚手架，不属于本项目）。用显式 `git add <文件列表>`，不要 `git add -A`。
3. **Git TLS**：本仓库已设 `git config http.sslBackend openssl`（仓库级），推送走 openssl 握手，避免 Windows schannel 失败。
4. **gh 代理坑**：本机 `HTTPS_PROXY=http://127.0.0.1:7897` 通常未运行，导致 `gh` 直连报 `EOF`。所有 `gh` 命令前先 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`（gh 自身走 Go TLS，不依赖 schannel，但会读取代理环境变量）。
5. **门禁必须常绿**：前端 `npm run check:frontend`（tsc + eslint + prettier）；Rust 改动跑 `cargo check` / `cargo clippy -D warnings` / `cargo fmt --check`。详见 `agents.md` 第七节护栏。

---

## 二、发布流程（Step by Step）

> 以下路径：`dev` = `F:\llama_run\llama-launcher-dev`；`main` = `F:\llama_run\tauri-launcher`。

0. **开发 & 自测**（在 `dev` 工作树）：完成代码改动，确保前端门禁与（如有）Rust 检查全绿。
1. **提升版本号**：同步修改两处——
   - `src-tauri/Cargo.toml` 的 `version = "X.Y.Z"`
   - `src-tauri/tauri.conf.json` 的 `"version": "X.Y.Z"`
   > `tauri.conf.json` 的版本驱动 Release 名 `__VERSION__` 与安装包版本；`Cargo.toml` 也应保持一致。
2. **提交**（在 `dev`）：`git add` 仅项目文件，**排除 `.claude/`、`.mcp.json`**。commit message 用中文、概述本版本改动。可用 `git commit -F - <<'EOF'` 喂多行。
3. **推送 dev**：`git push origin dev`。
4. **合并到 main 工作树**：`cd F:/llama_run/tauri-launcher && git fetch origin && git merge --no-ff dev -m "Merge dev into main for vX.Y.Z"`。用 `--no-ff` 保留合并记录；**不要**在 `dev` 工作树 checkout main。
5. **推送 main**：`git push origin main`。
6. **打标签触发 CI**：`git tag -a vX.Y.Z -m "Oh My Llama vX.Y.Z"` + `git push origin vX.Y.Z`。推送标签即触发 `release.yml`（仅 Windows）构建。
7. **等待构建**：`unset` 代理后 `gh run watch <run_id> --repo GDWhisper/oh-my-llama --exit-status`。构建约 **7 分钟**；成功后 Release 以**草稿**形式生成（`releaseDraft: true`）。
8. **更新 CHANGELOG.md**（见第三节分工）。
9. **发布 Release**：`gh release edit vX.Y.Z --notes-file <path> --draft=false --latest`。**必须**补 notes（草稿默认 body 是占位符 `See the assets to download and install.`）。

---

## 三、CHANGELOG 与 Release Note 的分工（用户硬性要求）

- **`CHANGELOG.md` = 详细改动历史**：每条写**涉及的文件与实现机制**（如 `ConfigManager` 加按钮、`lib.rs` 新增 `file_size` 命令、`App.css` 用 `.btn-secondary:disabled` 特异度压制通用 `button:disabled` 等）。按 `### 新增功能 / ### 功能优化 / ### Bug 修复` 三类组织。文件头注明「本文件为详细改动历史，Release 页面为总结性说明」。
- **GitHub Release Note = 总结性**：必须明显分为三段——
  - `### 新增功能`
  - `### 功能优化`
  - `### Bug 修复`
  **不要混在一起**；也**不要放「下载」栏目**（下载信息已在 Release 资产区自动展示）。
- Release Note 末尾统一加一行：`> 详细改动参考 CHANGELOG`。
- **不使用 emoji**（遵循项目无表情符号约定）。
- 归类示例：按钮禁用态误显蓝底 → 归 **Bug 修复**；`--no-webui` 置灰、停止变红、地址文案统一 → 归 **功能优化**。

---

## 四、常见坑（Gotchas）

- **gh 报 EOF** → 先 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`。
- **草稿 body 是占位符** → 必须 `gh release edit --notes-file` 补正式说明并 `--draft=false`。
- **资产 URL 显示 `untagged-...`** → 属 tauri-action 上传时的内部路径，Release 仍正确挂在 tag 下，无需处理。
- **`dev` 不能 checkout main** → 合并去 `main` 工作树执行 `git merge --no-ff dev`。
- **提交排除 `.claude/`、`.mcp.json`**。
- **版本号两处都要改**（`Cargo.toml` + `tauri.conf.json`）。
- **`release.yml` 仅 Windows**；不要试图让它出 macOS / Linux（历史已验证会失败）。

---

## 五、发布前检查清单（Checklist）

- [ ] 前端门禁 `npm run check:frontend` 通过
- [ ] （如有 Rust 改动）`cargo check` / `clippy -D warnings` / `fmt --check` 通过
- [ ] 版本号两处（`Cargo.toml` + `tauri.conf.json`）已同步
- [ ] `git add` 已排除 `.claude/`、`.mcp.json`
- [ ] `dev` 已推送、`main` 已合并并推送
- [ ] tag `vX.Y.Z` 已推送并触发 CI
- [ ] `CHANGELOG.md` 已更新（详细、三类分段）
- [ ] Release Note 已用 `--notes-file` 写入（三段式、无下载栏目、底部「详细改动参考 CHANGELOG」），并 `--draft=false --latest`
- [ ] 资产（`setup.exe` + `.msi`）已生成
