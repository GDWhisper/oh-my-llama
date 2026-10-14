# AGENTS.md — oh-my-llama 智能体操作规范

> 动手前先读完本文件：这里只记录**读代码、看配置、跑命令推断不出来**的信息，优先级高于模型默认习惯。产品介绍见 `README.md`，发布全流程与 Release Note 模板见 `.dev_docs/`，技术审计报告见 `docs/`，均不在此重复。本文件与 README 冲突时，以本文件为准。

## 项目一句话

Oh My Llama：Tauri 2 桌面工具，管理 `llama-server` 启动配置、参数与日志（仅作导航，产品介绍读 `README.md`）。双层边界：`src/`（React/TS 表现层）只经 invoke 桥与后端通信；`src-tauri/src/`（Rust）独占进程、文件、系统交互。
任务栏小窗是独立 webview 入口（另起 webview，不走主窗 invoke 桥），常驻、生命周期独立于主窗。

## 快速命令

```bash
npm install
npm run tauri dev                    # 全应用开发，Vite 端口 6060
npm run check                        # 本地门禁 = tsc + eslint + prettier + check:css + cargo fmt --check + clippy -D warnings
npm run check:css                    # 单独跑 CSS 选择器检查（拦「冒号+空格」这类会被浏览器静默丢弃的写法）
cargo test --lib --manifest-path src-tauri/Cargo.toml                     # 单元测试（必须带 manifest-path：仓库根无该文件，裸跑失败）
cargo test --lib --manifest-path src-tauri/Cargo.toml build_server_args   # 按名子串过滤（可命中多个同前缀用例）
powershell scripts/dev-server.ps1 -Action start|stop|restart              # 管理 dev server（含端口占用处理）
```

- 其余 scripts 见 `package.json` 的 scripts 段；打包用 `npm run tauri build`。
- lint / format 规则见 `eslint.config.js` 与 `.prettierrc.json`：只读配置，本文件不复述。
- ① 提交前跑 `npm run check`；改了 Rust 逻辑再跑 `cargo test --lib --manifest-path src-tauri/Cargo.toml`。CI（`.github/workflows/build-check.yml`）在 dev 每次 push 时三平台跑 `npm run check` + `npm run tauri build`，**不跑** `cargo test`——Rust 测试只靠本地。
- ② 门禁红了修根因，不许绕过；具体红线（`--no-verify` / `--ignore-scripts`、`#[allow]`、删 clippy `-D warnings`、剔除 eslint / prettier / check:css）见「边界」第 5 条。

## 硬性规则

1. **默认值唯一真源在后端**：`ServerConfig` 默认值只定义在 `ServerConfig::default()`（`src-tauri/src/lib.rs`）；前端经 `get_default_config` 获取，`App.tsx` 在 config 为 null 时拦截渲染。不要在前端复制 `default()` 里的字段默认值字面量，应经 IPC 取。结构化高级参数的初值在生成脚本 `DEFAULTS` 表，不在 `ServerConfig`。
2. **版本号唯一真源是 `src-tauri/tauri.conf.json` 的 `"version"`**：`src-tauri/Cargo.toml` 与 `package.json` 省略 version 字段是刻意设计，不要回填；`src-tauri/Cargo.lock` 里 `oh-my-llama 0.0.0` 是预期状态。发版只改这一处。
3. **llama-server 经伪终端（portable-pty）启动**：普通管道下 stdout 块缓冲使日志不实时，不要改回 `std::process` 普通管道。
4. **进程守护平台双分支**：Windows 走 windows-sys Job Object（KILL_ON_JOB_CLOSE），非 Windows 走 libc 进程组；两套 `cfg` 门控都必须保留，删任一支，对应平台会漏杀进程。
5. **`useServer` 内注册 Tauri 事件监听必须用 `listenGuarded`**：StrictMode 双挂载曾导致监听残留、日志双份。
6. **`src-tauri/src/params.rs` 是生成文件**，由 `scripts/gen_structured_params.py` 整体重写：不要手改 `params.rs`，应改脚本里的 PARAMS 表并在仓库根目录执行 `python scripts/gen_structured_params.py`。文件头「在此表加一行」是生成器模板原话，勿信；i18n skip 陷阱与新增参数顺序见 `AGENTS/recipes.md`。
7. **i18n**：用户可见文案一律走 `t()`；新键必须同时加进 `src/i18n/messages.ts` 的 zh 与 en（zh 用 `as const` 固定键集，en 缺键会编译报错）。
8. **`AppSettings` 持久化是整体读-改-写**（`%APPDATA%/OhMyLlama/settings.json`）：写命令必须先 `load_settings` 取全量、只改自己字段再落盘；只序列化局部会抹掉其它设置。字段加 `#[serde(default)]` 兼容旧文件。见 `lib.rs` 的 `load_settings` / `save_settings` 注释。
9. **测试约定**：Rust 单元测试只写在 `src-tauri/src/lib.rs` 尾部 `mod tests`；前端无测试框架，UI 改动用 `npm run tauri dev` 手动自测。改动相关逻辑须保持 `cargo test --lib --manifest-path src-tauri/Cargo.toml` 绿；配置序列化往返、参数构建、PTY 读取、注册表唯一性等同类纯逻辑，新增或改动须补对应用例。

## 边界（历史整改所得，禁止回退）

1. 安全配置：`src-tauri/tauri.conf.json` 的 `csp` 保持显式策略，禁止置 `null`；不得新增 `assetProtocol` 或 `dangerousDisableAssetCspModification`；`src-tauri/capabilities/` 保持最小权限，不为图省事批量放开（授权现状见 `AGENTS/recipes.md`）。
2. 禁止删除 `src/App.tsx` 的配置加载门控，或把 `config` 初始值改回硬编码对象——配置值只准来自后端 `get_default_config`。
3. 禁止重新引入源码文本替换补丁脚本（`patch_*.py` / `patch.diff` 之类）；改源码应走编辑工具逐处确认。
4. 禁止提交构建产物与外来 AI 脚手架——路径以根 `.gitignore` 与 `src-tauri/.gitignore` 为准（后者含 `/target/`、`/gen/schemas`）。提交用显式 `git -c gc.auto=0 add <文件列表>`，不要 `git add -A`；如何自证某路径被排除见 `AGENTS/git-safety.md`。
5. 禁止绕过门禁：不用 `--no-verify` / `--ignore-scripts` 强行跳过；不用 `#[allow]` 压过 clippy；不删 clippy 的 `-D warnings`；不从 `npm run check` 中剔除 eslint / prettier / check:css。门禁红了应修根因。
6. 缺陷修复先复现、定位根因；禁止症状层打补丁（`unwrap` 吞错、`sleep` 绕时序、放宽权限掩盖越界）。
7. **安全红线**：updater 签名私钥仅存本地 `~/.tauri/oh-my-llama.key`，绝不入库（CI 经 secret 注入）——入库等于交出更新包签名能力。上下文与理由见 `AGENTS/environment.md`。

### STOP & ASK（必须先停下来请示）

落入以下任一情形时停止编码，说明后等待明确指示，不得自行推进：

1. 新增 npm / crates 依赖，或破坏性框架/语言版本升级——须说明现有手段为何不足、候选的安全/维护/体积成本。
2. 破坏双层分层（前端直接做进程/文件/系统操作，后端碰 DOM），或修改共享状态结构。
3. 多方案在性能/可维护性/复杂度上取舍明显且无法判定最优——给 2–3 个候选。

请示必须包含：背景、已排除的简单方案、每个候选的影响（触及文件/层、新依赖、是否触碰上述禁区、回退难度）、你的推荐及理由。禁止只抛选项不表态。

## 按需文档索引（AGENTS/）

| 文档 | 内容 | 何时读取 | 何时维护 |
|---|---|---|---|
| `AGENTS/git-safety.md` | 在本环境跑 git 与 gh，哪些操作会毁仓库，正确做法是什么？ | 执行任何 git fetch/push/merge/tag、跑 gh 或准备提交前 | 环境 git 行为变化、踩新坑、发布流程变更时 |
| `AGENTS/environment.md` | 开发机与运行期环境有哪些读代码看不出的约束？ | 启动或重启 dev server、遇端口或依赖冲突、排查运行期数据或更新通道（签名私钥）问题前 | 开发环境要求、运行期路径、更新通道与密钥位置变化时 |
| `AGENTS/recipes.md` | 要改 IPC 命令 / 配置字段 / 高级参数 / 设置字段 / 文案时，按什么顺序动哪些文件？ | 执行上述五类改动中任一之前 | 上述流程变化、PARAMS 表或 capabilities 结构变化时 |

## Git / 提交

- 提交信息用 Conventional Commits：type 取 `feat` / `fix` / `chore` / `perf` / `docs`（最近 30 条提交实测仅此五种），冒号后中文摘要；发布提交固定 `chore(release): vX.Y.Z …`。
- 改动本文件或 `AGENTS/` 下文档的提交统一用 `docs(agents):` 前缀，便于检索与 review。
- 合并策略：dev→main 用本地分支 `dev`（`git -c gc.auto=0 merge --no-ff dev`）在 main 工作树（`F:\llama_run\tauri-launcher`）执行；本目录是 dev 工作树，不能 `git checkout main`；改动先落 dev，勿直提交 main。
- git 命令一律带 `-c gc.auto=0`：回合结束回收后台子进程会把 `gc --auto` 杀在半途、写残对象库；症状与补救见 `AGENTS/git-safety.md`。
- `origin/*` 引用陈旧：fetch / push / update-ref 报成功但 `origin/*` 不变，`git status` 的 `ahead N` 不可信；合并只用本地 `dev`，核对远端用 `git -c gc.auto=0 ls-remote origin refs/heads/dev refs/heads/main`。细节见 `AGENTS/git-safety.md`。

## 文档维护纪律（防止本文件再次膨胀）

易腐快照（命令数、测试数、组件清单、目录树、版本号）、配置文件与 lint 规则的内容复述、与 README / `.dev_docs/` 重复的介绍性文字、「保持简洁」之类无法判定违反与否的模糊指令、TODO 占位，一律不写；命令必须在 `package.json` / CI / scripts 里实测存在才可写入，规则必须能回答「违反了如何指出」。

1. **先过筛，再落笔。** 只有"不知道就会写出错误代码"的信息准进本文件；其余一律写进 `AGENTS/` 并在上方索引登记触发条件。
2. **先改写，后新增。** 要加的东西先在现有条目里找落点：能改写的就改写，能替代的就删旧加新，确认是全新约束才新增。因事故或复盘新增的硬性规则不受此限，但加完必须在同一次改动里把等量旧内容外置到 `AGENTS/`。单次会话净增超过 10 行，收尾时逐条说明它为什么必须常驻本文件。本文件超过 150 行立刻外置，不许放宽上限。
3. **改代码就同提交改文档。** 动了 `AGENTS/` 里某份文档所描述的代码，同一个提交里更新那份文档；上方索引的"何时维护"列写什么就做什么。
4. **会话收尾必须报告。** 本次会话改过本文件或 `AGENTS/` 下任何文档，收尾时报告四件事：改了哪几份、行数变化、是否触发拆分阈值（单篇 >200 行 / 同主题 ≥3 篇 / 索引条目 >12 条）、孤儿文档与失效索引是否已清理。没改就不用报。
5. **见到垃圾当场修。** 不在任何索引中的 `AGENTS/` 文档、索引里指向不存在路径的条目，当场修掉，不许记成待办。
6. **不许删本段来省行数。** 本段同样适用上面五条；绕过它，就是把这份文件的下一次膨胀留给下一个会话。
