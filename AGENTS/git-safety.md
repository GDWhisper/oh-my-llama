# 在本环境跑 git 与 gh，哪些操作会毁仓库，正确做法是什么？

> 父索引：../AGENTS.md

本篇只回答一个问题：本环境的 git / gh 有哪些不可推断的破坏性行为，以及每条对应的安全操作规范是什么。共五条，编号供正文互相引用。

| # | 破坏性行为 | 安全做法 |
|---|---|---|
| 1 | git 命令不带 `-c gc.auto=0`，回合结束被强杀的 `gc --auto` 把对象库写残 | 每条 git 命令都带 `-c gc.auto=0` |
| 2 | 信 `origin/*` 与 `git status` 的 `ahead N`，用 `origin/dev` 去合并 | 合并只用本地 `dev`，核对远端用 `git ls-remote` |
| 3 | 在本目录 `git checkout main` | main 上的动作到 `F:\llama_run\tauri-launcher` 执行 |
| 4 | 不清代理直接跑 `gh`，报 EOF 后反复重试 | `gh` 前先 unset / Remove-Item 四个代理变量 |
| 5 | 凭印象相信某路径不会被提交 | `git check-ignore -v` + `git status --ignored --short` 自证 |

## 1. git 命令一律带 `-c gc.auto=0`

**git 命令一律带 `-c gc.auto=0`**：本环境在回合结束时会回收后台子进程，而 git 的 `gc --auto` 默认 `gc.autoDetach=true` 会**转入后台运行**——被强杀在半途会把**对象库写残**（2026-09-15 20:02 因此整仓损坏：对象库残缺、dev worktree 的管理目录被清空、主 worktree 的工作区被删掉 110 个 tracked 文件）。`bad object HEAD`、`fatal: not a git repository: (NULL)`、fetch 报 `unresolved deltas` 都可能是此类损坏；**此时不要用 `git gc` / `repack` 去"修"**（它正是加害者），动手前先把工作区改动备份到仓库外。

操作细则：

1. 每条 git 命令都带 `-c gc.auto=0`，只读命令同样带：`git -c gc.auto=0 status`、`git -c gc.auto=0 log --oneline -1`、`git -c gc.auto=0 worktree list`。
2. 写操作也带：`git -c gc.auto=0 add <文件列表>`、`git -c gc.auto=0 commit -m "..."`、`git -c gc.auto=0 fetch`。
3. 见到 `bad object HEAD`、`fatal: not a git repository: (NULL)`、fetch 报 `unresolved deltas`，先按半途 gc 损坏判断；是则先把工作区改动备份到仓库外，再决定下一步动作。
4. 不要用 `git gc` / `repack` 应对上面的症状。半途被强杀的 gc 正是加害者，再跑一次只会把损坏扩大。

## 2. `origin/*` 引用会陈旧：fetch / push 报成功但引用不变

**`origin/*` 引用会陈旧（根因未明；既非沙箱权限问题，也非仓库损坏）**：本环境 git 写不进 `refs/remotes/**`——`git fetch` / `push` / `update-ref` 一律**报成功但 `origin/*` 不变**，`git status` 会**谎报 `ahead N`**（实测关掉沙箱同样失败；`refs/heads/**`、tags、objects 的 git 写入都正常）。**别为此重建克隆、跑 `git gc` / `repack`，或怀疑仓库损坏。** 动作规范：合并只用**本地分支 `dev`**（用 `origin/dev` 会合到陈旧提交，v0.2.4 踩过），核对远端一律 `git ls-remote origin refs/heads/dev refs/heads/main`；确需拨正本地引用就改主仓库 `F:\llama_run\tauri-launcher\.git\packed-refs` 对应行（持久；shell 写 loose 会让下一次写 `refs/remotes` 的 git 命令连带清掉）。细节见 `.dev_docs/release-guide.md:12-14`。

操作细则：

1. 核对远端真实提交用 `git -c gc.auto=0 ls-remote origin refs/heads/dev refs/heads/main`；`git status` 的 `ahead N` 一律不信。
2. 合并到 main 在 main 工作树执行：`cd F:/llama_run/tauri-launcher && git -c gc.auto=0 fetch origin && git -c gc.auto=0 merge --no-ff dev -m "Merge dev into main for vX.Y.Z"`。合并对象写本地 `dev`，不写 `origin/dev`。
3. 合错对象的症状：合并结果只带零星文件变动（v0.2.4 实测只合进 README 两个文件），没有本迭代的成批改动。补救非破坏性、无需 force-push：在 main 上再 `git merge --no-ff dev` 纠正；已打错 tag 的补救见 `.dev_docs/release-guide.md:86`。
4. 确需拨正本地引用，改主仓库 `F:\llama_run\tauri-launcher\.git\packed-refs` 的对应行。dev 工作树的 `.git` 是指向主仓库的 gitfile、不是目录，所以必须写主仓库的实际路径。shell 写 loose 文件虽即时生效，会被下一次写 `refs/remotes` 的 git 命令连带清掉，不作为正式手段。

## 3. 工作树结构：本目录是 dev 工作树，main 在另一工作树

本目录是 **dev 工作树**；main 分支被另一工作树（`F:\llama_run\tauri-launcher`）占用，**此处不能 `git checkout main`**，dev→main 合并须到 main 工作树执行。改动先落 dev，勿直提交 main。

操作细则：

1. 查看工作树结构：`git -c gc.auto=0 worktree list`。实测输出两行：`F:/llama_run/tauri-launcher` 挂在 main，`F:/llama_run/llama-launcher-dev`（本目录）挂在 dev。
2. 在本目录 `git checkout main` 会失败（分支被另一工作树占用）。dev→main 的合并命令见第 2 节细则 2，到 main 工作树执行。
3. 两个工作树共享 node_modules 与端口 6060，dev server 唯一实例约束与启停方式见 `AGENTS/environment.md`「开发机：同一时间只能跑一个 dev server」一节；到 main 工作树执行合并时同样适用。

## 4. 跑 gh 前先清代理环境变量

跑 `gh` 前先清代理环境变量（本机代理常未运行，直连报 EOF）：Git Bash 用 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`；PowerShell 用 `Remove-Item Env:HTTPS_PROXY,Env:HTTP_PROXY,Env:https_proxy,Env:http_proxy -ErrorAction SilentlyContinue`。仓库 git 已设 `http.sslBackend openssl`，勿改。

操作细则：

1. 本机全局 git 代理指向 `http://127.0.0.1:7897`（`git config --global --get http.proxy` 实测值；`https.proxy` 同值），该代理常未运行。
2. gh 自身走 Go TLS，不依赖 schannel，但会读取代理环境变量——清变量是跑 gh 的前置条件，不是可选项。
3. `gh` 报 EOF 时，先执行上面的 unset / Remove-Item；仍报错改用 `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy gh ...` 跑同一条命令。
4. git 网络命令要覆盖代理，必须用带点的键：`-c "http.proxy=" -c "https.proxy="`（空值 = 直连）。写 `-c https_proxy=` 会被 git 报 `key does not contain a section`。直连报 `Connection was reset` / `Could not connect` 时，改 `-c "http.proxy=http://127.0.0.1:7897" -c "https.proxy=http://127.0.0.1:7897"`；报 `Could not connect to 127.0.0.1` 说明代理没开，退回直连。
5. `http.sslBackend` 已设 `openssl`（`git config --local --get http.sslBackend` 实测 `openssl`），勿改。

## 5. 提交前自证某路径不会被误提交

1. 查单条路径是否被忽略：`git -c gc.auto=0 check-ignore -v <路径>`。有输出 = 被忽略，输出含 `.gitignore` 行号、规则、路径（实测 `git check-ignore -v node_modules` 得 `.gitignore:10:node_modules	node_modules`）；无输出、退出码 1 = 未被忽略（实测 `git check-ignore -v AGENTS` 无输出，AGENTS/ 下的文档能入库）。
2. 查目录的忽略标记：`git -c gc.auto=0 status --ignored --short <路径>`，`!!` 前缀 = 已忽略。实测 `git status --ignored --short node_modules` 输出 `!! node_modules/`。
3. 常见具名排除是外来 AI 脚手架：`.claude/`、`.mcp.json` 等；完整名单以根 `.gitignore` 当前内容为准（"Foreign AI-tool scaffolding" 一节）。
4. 提交用显式 `git add <文件列表>`，只加项目文件。
5. 每次改 `.gitignore` 后重跑细则 1、2 两条命令。规则变化不会主动通知，上一次的自证结论此时已失效。
