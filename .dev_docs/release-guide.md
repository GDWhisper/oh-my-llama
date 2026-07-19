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
7. **等待构建（前台，不可拆成两轮）**：`unset` 代理后在**前台**执行 `gh run watch <run_id> --repo GDWhisper/oh-my-llama --exit-status`（单次最长约 7-8 分钟，Bash 命令超时给足 600000ms）。**禁止用 `run_in_background` 把等待拆到后台**——后台返回后控制权已交还用户，发布步骤极易被漏掉；必须等到构建结束**在同一轮对话里**继续后续步骤。构建成功时 Release 以**草稿**形式生成（`releaseDraft: true`），这只是中间态，**不是终点**。
8. **更新 CHANGELOG.md**（见第三节分工）。
9. **发布 Release（强制收尾，不可省略 / 不可推迟）**：构建一结束（同一轮）**立即**执行 `gh release edit vX.Y.Z --notes-file <path> --draft=false --latest`。**必须**补 notes（草稿默认 body 是占位符 `See the assets to download and install.`）。**这是发布流程的最后一个动作；在它完成前，任务视为未完成，不得向用户报告「已发布 / 完成 / 可直接下载」。**
10. **验证已正式发布**：`gh release view vX.Y.Z --repo GDWhisper/oh-my-llama`，确认输出含 `draft: false` 且 `Latest` 标记存在。只有亲眼看到 `draft: false`，才算发布成功、才能回复用户。

> ## ⛔ 强制收尾铁律（历史踩坑）
> CI 默认生成 **草稿** Release（`releaseDraft: true`），这是设计使然，**每次都会是 draft**。草稿=未发布，用户看到的就是「draft、没内容」。
> **发布流程到「`gh release edit --draft=false` 成功 + `gh release view` 确认 `draft: false`」才结束。** 在此之前：
> - **不得**把"构建成功 / 标签已推送 / 资产已生成"当作"已发布"告知用户；
> - **不得**用 `run_in_background` 等构建后把发布推迟到下一轮——那轮往往不会自己回来执行；
> - 若构建时间过长必须等待，用前台 `gh run watch`（超时 600000ms），在同一轮内紧接着发布。
> 一句话：**draft 就是没发布，看到 `draft: false` 才算数。**

---

## 三、CHANGELOG 与 Release Note 的分工（用户硬性要求）

- **`CHANGELOG.md` = 详细改动历史**：每条写**涉及的文件与实现机制**（如 `ConfigManager` 加按钮、`lib.rs` 新增 `file_size` 命令、`App.css` 用 `.btn-secondary:disabled` 特异度压制通用 `button:disabled` 等）。按 `### 新增功能 / ### 功能优化 / ### Bug 修复` 三类组织。文件头注明「本文件为详细改动历史，Release 页面为总结性说明」。
- **GitHub Release Note = 总结性**：必须明显分为三段——
  - `### 新增功能`
  - `### 功能优化`
  - `### Bug 修复`
  **不要混在一起**；也**不要放「下载」栏目**（下载信息已在 Release 资产区自动展示）。
- **⛔ 内容红线（用户硬性要求）**：Release Note 只写「两个**已发布**版本之间**用户可见**的差异」。**严禁混入开发过程中误添加又删除的内部改动**（如某版本开发期误塞进 UI、随后又移除的元素；或加了又删、从未在 UI 展示过的字段等）。判断标准：该改动在**上一正式版里不存在、在当前正式版里也不存在** → 对版本对比毫无意义，必须剔除。写完逐条自问：「用户从旧版升到新版会注意到这条吗？」回答「不会 / 从未出现过」的，删。
- Release Note 末尾统一加一行：`> 详细改动参考 CHANGELOG`。
- **不使用 emoji**（遵循项目无表情符号约定）。
- 归类示例：按钮禁用态误显蓝底 → 归 **Bug 修复**；`--no-webui` 置灰、停止变红、地址文案统一 → 归 **功能优化**。

---

## 四、常见坑（Gotchas）

- **gh 报 EOF** → 先 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`。
- **草稿 ≠ 已发布** → CI 永远先生成 draft（`releaseDraft: true`）。必须 `gh release edit --notes-file ... --draft=false --latest` 并 `gh release view` 确认 `draft: false` 才算发布成功。构建成功、资产齐全都**不算**发布完成。
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
- [ ] Release Note 已用 `--notes-file` 写入（三段式、无下载栏目、底部「详细改动参考 CHANGELOG」、**无开发期内部增减类条目**），并 `--draft=false --latest`
- [ ] `gh release view vX.Y.Z` 确认输出含 `draft: false`（**未确认前不得回复用户「已发布」**）
- [ ] 资产（`setup.exe` + `.msi`）已生成
- [ ] 本地已生成签名私钥 `~/.tauri/oh-my-llama.key`（公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）
- [ ] GitHub 仓库 **Secrets** 已配置 `TAURI_SIGNING_PRIVATE_KEY`（内容为私钥文件全文）；缺失时构建仍成功，但产物无 `.sig`、不生成 `latest.json`，更新通道不可用

---

## 六、更新机制（方案 A：tauri-plugin-updater）

> 更新通道采用 Tauri v2 官方 `tauri-plugin-updater`：**手动触发**（设置浮窗「关于」里的「检查更新」按钮），**不**做启动自动检查、也**不**提供「是否检查更新」开关（早期需求/bug 较多，用户明确要求先不做开关）。下载**可见、可取消**（进度条 + 取消按钮，取消经 `Update.close()` best-effort 中断），安装**必须显式确认**（下载完成弹「重启以安装」），绝不后台静默安装。

### 密钥与签名（一次性）
- 生成本地私钥（**不入库**，仅存开发者机器）：`npx tauri signer generate --write-keys ~/.tauri/oh-my-llama.key --ci`（无密码；有密码则需同时配 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`）。
- 公钥（`.key.pub` 内容）已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。**改公钥必须同步重新签名**，否则旧签名校验失败、更新无法安装。
- 私钥全文存入 GitHub 仓库 **Secrets** → `TAURI_SIGNING_PRIVATE_KEY`。`release.yml` 已通过环境变量把它注入 `tauri-action`，由其自动对安装包签名。
- **私钥丢失 = 无法再签发更新**（用户将收不到后续更新）。务必备份 `~/.tauri/oh-my-llama.key`。

### CI 产物（release.yml 已配）
- `includeUpdaterArtifacts: true`：构建后自动用上述私钥对安装包签名生成 `.sig`，并生成 `latest.json`（含版本、平台、签名、下载地址）。
- `updaterJsonPreferNsis: true`：偏好 NSIS 安装包作为更新载体（与本项目 Windows-only 一致）。
- `latest.json` 与 `.sig` 作为 Release 资产上传；`tauri.conf.json` 的 `plugins.updater.endpoints` 指向 `https://github.com/GDWhisper/oh-my-llama/releases/latest/download/latest.json`，与上传位置对应。

### 发版时更新通道如何生效
1. 照常打 `vX.Y.Z` 标签触发 `release.yml`（仅 Windows）构建。
2. 构建产出 `setup.exe`/`.msi` + 对应 `.sig` + `latest.json`，作为草稿 Release 资产。
3. `gh release edit --draft=false` 发布后，已装旧版用户在「设置 → 关于 → 检查更新」即可看到新版本并可视化下载安装。
4. **版本号两处**（`Cargo.toml` + `tauri.conf.json`）必须与 tag 一致，`latest.json` 才指向正确版本。

### 常见坑
- **缺 `bundle.createUpdaterArtifacts`（v0.0.3 踩过）**：Tauri v2 **必须**在 `tauri.conf.json` 的 `bundle` 里显式设 `"createUpdaterArtifacts": true`，否则即使配了签名私钥，构建也**不产出 `.sig`**，Release 只有 `setup.exe`/`.msi`，更新通道失效。
- **`release.yml` 用错输入名 `includeUpdaterArtifacts`（v0.0.3 踩过）**：`tauri-action` **无**此输入（CI 日志会警告 `Unexpected input(s) 'includeUpdaterArtifacts'` 并忽略），正确的是 **`includeUpdaterJson: true`**（生成并上传 `latest.json`）。`.sig` 由上面的 `createUpdaterArtifacts` 产出，二者缺一不可。
- **未配 `TAURI_SIGNING_PRIVATE_KEY`**：构建不报错，但无 `.sig`、无 `latest.json` → 更新检查永远「已是最新」。先确认 Secret 已填。
- **公钥与私钥不匹配**（如换过密钥没同步 pubkey）：旧客户端校验签名失败，更新报错。pubkey 必须与签名所用私钥配对。
- **`latest.json` 下载地址 404**：检查 `endpoints` 与 Release 资产名（`latest.json`）是否一致、Release 是否已发布（草稿态对外不可见）。
- **手动改 `tauri.conf.json` 的 version 却不打 tag**：`latest.json` 由 CI 按 tag 生成，本地手改无效。

