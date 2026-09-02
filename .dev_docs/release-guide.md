# 发布指导（Release Guide）— 供 AI Agent 使用

> **何时阅读本文档**：当需要进行版本发布（提交 / 打标签 / 触发 CI / 编写 Release Note 或更新 CHANGELOG）时，**必须**先阅读本文档，并严格遵守其中的流程与分工，不得凭默认习惯发布。

> **适用范围**：`oh-my-llama`（Tauri 2 + React/TS 桌面应用）。发布出 **Windows**（`.exe` NSIS / `.msi`）、**Linux**（`.deb` / `.rpm` / `.AppImage`）、**macOS arm64**（`.dmg`，未签名版），由 `.github/workflows/release.yml` 在推送 `v*` 标签时三平台并行构建。

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
1. **提升版本号**：**只改一处**——`src-tauri/tauri.conf.json` 的 `"version": "X.Y.Z"`。
   > **该文件是应用版本号的唯一真源**，同时驱动三件事：运行时 `getVersion()`（设置→关于显示的版本）、安装包版本、CI Release 名 `__VERSION__`。
   >
   > `src-tauri/Cargo.toml` 与根 `package.json` **已刻意省略 `version` 字段**，因此无需（也不应）同步：
   > - Cargo 省略时默认 `0.0.0`，`Cargo.lock` 里的 `oh-my-llama` 也会是 `0.0.0`——**这是预期状态，勿手工回填**；该值不参与分发。
   > - `package.json` 因 `"private": true` 可省略 `version`，重新生成的 `package-lock.json` 同样不含该字段。
   >
   > 这样做的原因：历史上版本号散落 4 个文件 5 处、靠人肉同步，实际漂移过（曾同时存在 0.1.0 / 0.1.1 / 0.1.2 三个值）。收敛为单一真源后，漂移在结构上不再可能发生。
2. **编写发布说明文件 + 更新 CHANGELOG（⛔ 必须在提交/打标签之前）**：复制 `.dev_docs/release-note-template.md` 按第三节分工填写，保存为 **`.dev_docs/release-notes-vX.Y.Z.md`**（文件名固定，CI 按 tag 名精确读取），同时更新 `CHANGELOG.md`。
   > **为什么必须前置**：`release.yml` 的「Read release notes」步骤从 **tag 所在 commit** 读该文件，把全文注入 `tauri-action` 的 `releaseBody`；`releaseBody` 会同时写进 **GitHub Release 正文**与 **`latest.json` 的 `notes` 字段**，后者才是**应用内更新弹窗**显示的更新说明。文件不在 tag 里 → 应用内永远只看到占位符。（另注：`tauri-action` 的 `body_path` 输入只改 Release 正文、**不进 `latest.json`**，不能用来替代这套机制。）
3. **提交**（在 `dev`）：`git add` 仅项目文件，**排除 `.claude/`、`.mcp.json`**。版本号、发布说明文件、CHANGELOG **一起进这一个 commit**（保证它们随 tag 落地）。commit message 用中文、概述本版本改动。可用 `git commit -F - <<'EOF'` 喂多行。
4. **推送 dev**：`git push origin dev`。
5. **合并到 main 工作树**：`cd F:/llama_run/tauri-launcher && git fetch origin && git merge --no-ff dev -m "Merge dev into main for vX.Y.Z"`。用 `--no-ff` 保留合并记录；**不要**在 `dev` 工作树 checkout main。
6. **推送 main**：`git push origin main`。
7. **打标签触发 CI**：`git tag -a vX.Y.Z -m "Oh My Llama vX.Y.Z"` + `git push origin vX.Y.Z`。推送标签即触发 `release.yml`（三平台并行：Windows / Ubuntu 22.04 / macOS arm64）构建。
8. **等待构建（前台，不可拆成两轮）**：`unset` 代理后在**前台**执行 `gh run watch <run_id> --repo GDWhisper/oh-my-llama --exit-status`（三平台并行，实测最长约 8-9 分钟，Bash 命令超时给足 600000ms）。**禁止用 `run_in_background` 把等待拆到后台**——后台返回后控制权已交还用户，发布步骤极易被漏掉；必须等到构建结束**在同一轮对话里**继续后续步骤。构建成功时 Release 以**草稿**形式生成（`releaseDraft: true`），这只是中间态，**不是终点**。
9. **核对更新说明已自动注入**：`gh release view vX.Y.Z --repo GDWhisper/oh-my-llama --json body -q .body` 看正文是否为发布说明全文。若仍是占位符 `See the assets to download and install.`，说明 tag 所在 commit 缺 `.dev_docs/release-notes-vX.Y.Z.md`（第 2 步）——**补文件、重打 tag**，不要用 `--notes-file` 糊过去：`--notes-file` 只改 Release 正文，**不会重写已上传的 `latest.json`**，应用内更新弹窗仍是空的。
10. **发布 Release（强制收尾，不可省略 / 不可推迟）**：构建一结束（同一轮）**立即**执行 `gh release edit vX.Y.Z --draft=false --latest`。**这是发布流程的最后一个动作；在它完成前，任务视为未完成，不得向用户报告「已发布 / 完成 / 可直接下载」。**
11. **验证已正式发布**：`gh release view vX.Y.Z --repo GDWhisper/oh-my-llama`，确认输出含 `draft: false` 且 `Latest` 标记存在。只有亲眼看到 `draft: false`，才算发布成功、才能回复用户。

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
- **GitHub Release Note = 总结性**：**统一使用模板文件 `.dev_docs/release-note-template.md`**（复制后填入实际内容），保存为 **`.dev_docs/release-notes-vX.Y.Z.md`** 并随版本 commit 入库——CI 从 tag 所在 commit 读它注入 `releaseBody`，同时落到 Release 正文与 `latest.json.notes`（应用内更新弹窗）。模板已内嵌以下强制要求：
  - **顶部固定文案**（不可改动）：`本版本亮点由发布 agent 基于 CHANGELOG 手动总结。详细条目见 CHANGELOG.md。`
  - **正文必须包含三大类**（顺序固定、缺一不可，空类也要保留标题并写「无」）：
    - `### 新增功能`
    - `### 功能优化`
    - `### Bug 修复`
  - 末尾统一加一行：`> 详细改动参考 CHANGELOG`。
  **不要混在一起**；也**不要放「下载」栏目**（下载信息已在 Release 资产区自动展示）。
- **⛔ 内容红线（用户硬性要求）**：Release Note 只写「两个**已发布**版本之间**用户可见**的差异」。**严禁混入开发过程中误添加又删除的内部改动**（如某版本开发期误塞进 UI、随后又移除的元素；或加了又删、从未在 UI 展示过的字段等）。判断标准：该改动在**上一正式版里不存在、在当前正式版里也不存在** → 对版本对比毫无意义，必须剔除。写完逐条自问：「用户从旧版升到新版会注意到这条吗？」回答「不会 / 从未出现过」的，删。
- Release Note 末尾统一加一行：`> 详细改动参考 CHANGELOG`。
- **不使用 emoji**（遵循项目无表情符号约定）。
- 归类示例：按钮禁用态误显蓝底 → 归 **Bug 修复**；`--no-webui` 置灰、停止变红、地址文案统一 → 归 **功能优化**。

---

## 四、常见坑（Gotchas）

- **gh 报 EOF** → 先 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`（或 `env -u` 四个变量后再执行 `gh`）。
- **git 代理覆盖语法**：本机全局 `http(s).proxy` 指向 `127.0.0.1:7897`，且该代理可能未运行（动态）。覆盖时**必须用带点的键** `-c "http.proxy=" -c "https.proxy="`（空值=直连）；写 `-c https_proxy=`（下划线）会被 git 报 `key does not contain a section`、`-c http.proxy=<url>` 则路由经过代理。若直连报 `Connection was reset`/`Could not connect`，改 `-c "http.proxy=http://127.0.0.1:7897" -c "https.proxy=http://127.0.0.1:7897"`；若报 `Could not connect to 127.0.0.1`，说明代理没开，退回直连。两者交替试，勿把命令里的 `-` 误写成参数分隔。
- **草稿 ≠ 已发布** → CI 永远先生成 draft（`releaseDraft: true`）。必须 `gh release edit --draft=false --latest` 并 `gh release view` 确认 `draft: false` 才算发布成功。构建成功、资产齐全都**不算**发布完成。
- **应用内更新说明为空 / 只有占位符** → 发布说明文件必须在**打标签之前**进 commit（`.dev_docs/release-notes-vX.Y.Z.md`）；CI 从 tag 所在 commit 读取。事后用 `gh release edit --notes-file` 只能补 Release 正文，**重写不了已上传的 `latest.json.notes`**，应用内仍看不到说明——只能补文件、删 tag 重打。
- **资产 URL 显示 `untagged-...`** → 属 tauri-action 上传时的内部路径，Release 仍正确挂在 tag 下，无需处理。
- **`dev` 不能 checkout main** → 合并去 `main` 工作树执行 `git merge --no-ff dev`。
- **提交排除 `.claude/`、`.mcp.json`**。
- **版本号只改 `tauri.conf.json` 一处**（唯一真源）。`Cargo.toml` / `package.json` 已省略 `version`，`Cargo.lock` 里的 `0.0.0` 属预期，**勿手工回填**。
- **`release.yml` 三平台并行**：Windows / Linux（ubuntu-22.04）/ macOS（macos-latest = 原生 arm64）；Linux 需在 runner 上安装 Tauri v2 官方系统依赖（webkit2gtk-4.1 等，见 workflow）。macOS 当前发未签名版（Gatekeeper 右键打开），其更新通道待 Apple 证书后启用。

---

## 五、发布前检查清单（Checklist）

- [ ] 前端门禁 `npm run check:frontend` 通过
- [ ] （如有 Rust 改动）`cargo check` / `clippy -D warnings` / `fmt --check` 通过
- [ ] 版本号已在 `src-tauri/tauri.conf.json`（唯一真源）提升，且与将要打的 tag 一致
- [ ] `CHANGELOG.md` 已更新（详细、三类分段）
- [ ] Release Note 已**复制 `release-note-template.md` 模板**填好，存为 `.dev_docs/release-notes-vX.Y.Z.md` 并随版本号一起 commit（含顶部固定文案、三大类齐全、无下载栏目、底部「详细改动参考 CHANGELOG」、**无开发期内部增减类条目**）
- [ ] `git add` 已排除 `.claude/`、`.mcp.json`
- [ ] `dev` 已推送、`main` 已合并并推送
- [ ] tag `vX.Y.Z` 已推送并触发 CI
- [ ] `gh release view vX.Y.Z --json body` 确认正文已是发布说明全文（仍是占位符说明 tag 里缺文件，需补文件重打 tag）
- [ ] 已 `--draft=false --latest` 发布
- [ ] `gh release view vX.Y.Z` 确认输出含 `draft: false`（**未确认前不得回复用户「已发布」**）
- [ ] 资产已生成（Windows `setup.exe` + `.msi`；Linux `.deb` / `.rpm` / `.AppImage`；macOS arm64 `.dmg`；各平台 `.sig` + `latest.json`）
- [ ] 本地已生成签名私钥 `~/.tauri/oh-my-llama.key`（公钥已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）
- [ ] GitHub 仓库 **Secrets** 已配置 `TAURI_SIGNING_PRIVATE_KEY`（内容为私钥文件全文）；**注意（实测 tauri v2）**：`createUpdaterArtifacts=true` 时缺失私钥会直接报错（`A public key has been found, but no private key`），不会静默降级

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
- `updaterJsonPreferNsis: true`：偏好 NSIS 安装包作为 Windows 更新载体（三平台各自按平台产物生成对应更新条目）。
- `latest.json` 与 `.sig` 作为 Release 资产上传；`tauri.conf.json` 的 `plugins.updater.endpoints` 指向 `https://github.com/GDWhisper/oh-my-llama/releases/latest/download/latest.json`，与上传位置对应。

### 发版时更新通道如何生效
1. 照常打 `vX.Y.Z` 标签触发 `release.yml`（三平台）构建。
2. 构建产出 `setup.exe`/`.msi` + 对应 `.sig` + `latest.json`，作为草稿 Release 资产。
3. `gh release edit --draft=false` 发布后，已装旧版用户在「设置 → 关于 → 检查更新」即可看到新版本并可视化下载安装。
4. **`tauri.conf.json` 的 `version`（唯一真源）必须与 tag 一致**，`latest.json` 才指向正确版本。

### 常见坑
- **缺 `bundle.createUpdaterArtifacts`（v0.0.3 踩过）**：Tauri v2 **必须**在 `tauri.conf.json` 的 `bundle` 里显式设 `"createUpdaterArtifacts": true`，否则即使配了签名私钥，构建也**不产出 `.sig`**，Release 只有 `setup.exe`/`.msi`，更新通道失效。
- **`release.yml` 用错输入名 `includeUpdaterArtifacts`（v0.0.3 踩过）**：`tauri-action` **无**此输入（CI 日志会警告 `Unexpected input(s) 'includeUpdaterArtifacts'` 并忽略），正确的是 **`includeUpdaterJson: true`**（生成并上传 `latest.json`）。`.sig` 由上面的 `createUpdaterArtifacts` 产出，二者缺一不可。
- **未配 `TAURI_SIGNING_PRIVATE_KEY`**：构建不报错，但无 `.sig`、无 `latest.json` → 更新检查永远「已是最新」。先确认 Secret 已填。
- **公钥与私钥不匹配**（如换过密钥没同步 pubkey）：旧客户端校验签名失败，更新报错。pubkey 必须与签名所用私钥配对。
- **`latest.json` 下载地址 404**：检查 `endpoints` 与 Release 资产名（`latest.json`）是否一致、Release 是否已发布（草稿态对外不可见）。
- **手动改 `tauri.conf.json` 的 version 却不打 tag**：`latest.json` 由 CI 按 tag 生成，本地手改无效。

