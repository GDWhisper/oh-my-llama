# AGENTS.md — oh-my-llama 智能体操作规范

> 动手前先读完本文件：这里只记录**读代码、看配置、跑命令推断不出来**的信息，优先级高于模型默认习惯。产品介绍见 `README.md`，发布全流程见 `.dev_docs/release-guide.md`，均不在此重复。

## 本文件的维护规范（修改本文件前先读）

- **准入测试**：每条新增内容必须同时满足 ① 新 Agent 不读本文件、只读代码/配置/跑命令**推断不出来**；② 搞错了**会出问题**。两条缺其一，不写。
- **禁止写入**：易腐快照（命令数、测试数、组件清单、目录树、版本号）；配置文件与 lint 规则的内容复述（只准给链接）；与 README / `.dev_docs/` 重复的介绍性文字；「保持简洁」「高质量」之类无法判定违反与否的模糊指令；TODO 占位；密钥等敏感信息。
- **命令必须实测存在**（`package.json` / CI / scripts 里找得到）才可写入；规则必须能回答「违反了如何指出」。
- 新增前先找可否**更新既有条目**；条目变得可推断或已过时时，**删除**而不是打补丁。
- 拿不准该不该写 → 不写。本文件每次对话都进上下文，啰嗦稀释重点。

## 定位与导航

Oh My Llama：管理 `llama-server` 启动配置、参数与日志的桌面工具。Tauri 2 双层架构：`src/`（React/TS 表现层）只经 invoke 桥与后端通信；`src-tauri/src/`（Rust）承载进程、文件、系统交互。

| 位置 | 职责 |
|---|---|
| `src/hooks/useServer.ts` | 前端状态与命令聚合点；配置值全部来自后端 |
| `src/types.ts` | IPC 类型契约，必须与 Rust 命令保持同步 |
| `src-tauri/src/lib.rs` | 命令注册（`generate_handler!`）、进程管理、持久化；单元测试全在文件尾 `mod tests` |
| `src-tauri/src/params.rs` | 高级参数注册表 —— **生成文件**（见「架构约束」第 6 条） |
| `src/i18n/messages.ts` | zh/en 字典，zh 为键集唯一真源 |
| `.dev_docs/` | 发布指南、Release Note 模板、工程化评审报告 |

## 常用命令

```bash
npm install
npm run tauri dev                    # 全应用开发，Vite 端口 6060
npm run check                        # 全量门禁 = tsc + eslint + prettier + cargo fmt --check + clippy -D warnings
cargo test --lib --manifest-path src-tauri/Cargo.toml                     # 单元测试
cargo test --lib --manifest-path src-tauri/Cargo.toml build_server_args   # 跑单个测试（按名过滤）
npm run tauri build                  # 构建安装包
npm run lint:fix                     # eslint 自动修复
npm run format                       # prettier 格式化
powershell scripts/dev-server.ps1 -Action start|stop|restart              # 管理 dev server（含端口占用处理）
```

- 门禁必须常绿：提交前跑 `npm run check`；改了 Rust 逻辑再跑 `cargo test --lib`。CI（`.github/workflows/build-check.yml`）在 dev/main 每次 push 时三平台跑同一门禁；完整打包冒烟仅在 main（dev 只检查不打包，发版资产由 release.yml 在 tag 时产出）。
- 门禁红了修根因；禁止用 `#[allow]`、删检查项、放宽规则等方式转绿。

## 架构约束（这些「看起来反常」但有意为之，不要顺手修正）

1. **默认值唯一真源在后端**：默认值只定义在 `ServerConfig::default()`（lib.rs）；前端经 `get_default_config` 获取，`App.tsx` 在 config 为 null 时拦截渲染（「加载配置中…」）。前端禁止出现任何硬编码 `ServerConfig` 默认值字面量。
2. **版本号唯一真源是 `src-tauri/tauri.conf.json` 的 `"version"`**。`Cargo.toml` 与 `package.json` 刻意省略 version 字段；`Cargo.lock` 里 `oh-my-llama 0.0.0` 是预期状态，**不要回填**。发版只改这一处。
3. **llama-server 经伪终端（portable-pty）启动**：根治管道下 stdout 块缓冲、日志不实时的问题。不要改回普通 `std::process` 管道。
4. **进程守护平台双分支**：Windows 走 windows-sys Job Object（KILL_ON_JOB_CLOSE），非 Windows 走 libc 进程组；两套 `cfg` 门控都必须保留。
5. **`useServer` 内注册 Tauri 事件监听必须用 `listenGuarded`**：StrictMode 双挂载曾导致监听残留、日志双份。
6. **`params.rs` 是生成文件**：由 `scripts/gen_structured_params.py`（仅开发期）整体生成。新增/修改结构化高级参数 → 改脚本里的 PARAMS 表并重跑脚本，不要手改 `params.rs`。
7. **i18n**：用户可见文案一律走 `t()`；新键必须同时加进 `messages.ts` 的 zh 与 en（zh 用 `as const` 固定键集，en 缺键会编译报错）。

## 边界与禁区（历史整改所得，禁止回退）

- 安全配置：`tauri.conf.json` 的 `csp` 保持显式策略（禁止置 `null`）；`assetProtocol` 保持禁用；`capabilities/default.json` 保持最小权限，不为图省事批量放开。
- 禁止删除 `App.tsx` 的配置加载门控，或把 `config` 初始值改回硬编码对象。
- 禁止重新引入源码文本替换补丁脚本（`patch_*.py` / `patch.diff` 之类）。
- 禁止提交：`dist/`、`src-tauri/target/`、`src-tauri/gen/schemas/`、`.codegraph/`、`tmp/`；提交必须显式排除 `.claude/` 与 `.mcp.json`（外来 AI 工具脚手架）——用显式 `git add <文件列表>`，不要 `git add -A`。
- 禁止绕过门禁与钩子：`--no-verify`、`--ignore-scripts`、去掉 clippy `-D warnings`、从 check 中剔除 eslint / prettier。
- 缺陷修复先复现、定位根因、归层归类；禁止症状层打补丁（`unwrap` 吞错、`sleep` 绕时序、放宽权限掩盖越界）。

## 必须先停下来请示（STOP & ASK）

落入以下任一情形时停止编码，说明后等待明确指示，不得自行推进：

1. 新增 npm / crates 依赖，或破坏性框架/语言版本升级——须说明现有手段为何不足、候选的安全/维护/体积成本。
2. 破坏双层分层（前端直接做进程/文件/系统操作，后端碰 DOM），或修改共享状态结构。
3. 多方案在性能/可维护性/复杂度上取舍明显且无法判定最优——给 2–3 个候选。

请示必须包含：背景、已排除的简单方案、每个候选的影响（触及文件/层、新依赖、是否触碰上述禁区、回退难度）、你的推荐及理由。禁止只抛选项不表态。

## 常见任务配方

| 要做 | 动哪里 |
|---|---|
| 新增 IPC 命令 | ① 加 `#[tauri::command]` 并注册进 `generate_handler!`；② 同步 `src/types.ts`；③ 自定义 app 命令默认可用，仅**插件**命令需在 `capabilities/default.json` 显式授权 |
| 新增配置字段 | 后端 `ServerConfig` 加字段、`default()` 给默认值（唯一真源）→ 同步 `src/types.ts` → 前端使用；前端不写默认值字面量 |
| 新增/修改高级参数 | 改 `scripts/gen_structured_params.py` 的 PARAMS 表 → 重跑生成 → 补 i18n 双语文案 |
| 新增用户可见文案 | `src/i18n/messages.ts` zh/en 同时加键 + 组件用 `t()` |
| 发布版本 | 先读 `.dev_docs/release-guide.md`；Release Note 复制 `.dev_docs/release-note-template.md`，不得另起炉灶 |

## 环境

- 开发机为 Windows，脚本为 PowerShell；Node ≥ 18（CI 用 22），Rust stable。
- dev 与 main 工作树**共享 node_modules** 与端口 6060 → 同一时间只能跑一个 dev server，用 `scripts/dev-server.ps1` 启停。
- 本目录是 **dev 工作树**；main 分支被另一工作树（`F:\llama_run\tauri-launcher`）占用，**此处不能 `git checkout main`**，dev→main 合并须到 main 工作树执行。改动先落 dev，勿直提交 main。
- 跑 `gh` 前先 `unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy`（本机代理常未运行，直连报 EOF）；仓库 git 已设 `http.sslBackend openssl`，勿改。
- 运行期配置存于 `%APPDATA%/OhMyLlama/configs.toml`（TOML）；updater 签名私钥仅存本地 `~/.tauri/oh-my-llama.key`，绝不入库（CI 经 secret 注入）。

## 测试约定

- 只有 Rust 单元测试，全部位于 `src-tauri/src/lib.rs` 尾部 `mod tests`；前端无测试框架，UI 改动用 `npm run tauri dev` 手动自测。
- 配置序列化往返、参数构建、PTY 读取、注册表唯一性等纯逻辑已有用例覆盖；改动相关逻辑须保持 `cargo test --lib` 绿，新增同类纯逻辑应补对应用例。

## 术语

- **一键传参**：粘贴整段命令行，由 `src/lib/parseArgs.ts` 解析——已知参数归位字段，未知参数原样保留为自定义参数。
- **配置分享**：一键复制启动参数到剪切板，产出的命令行与后端启动逻辑完全一致。
- **方案 A（更新通道）**：内置 updater，手动检查、进度可见可取消；前端经 JS API 驱动 check/download/install，Rust 侧仅注册 Builder。
- **门禁**：`npm run check` + `cargo test --lib`。

---
*本文件刻意未写入：目录树与组件清单（直接读代码，变化快）、lint/format 规则细节（见 `eslint.config.js` / `.prettierrc.json`）、IPC 命令全量清单（见 `lib.rs` 的 `generate_handler!`）、依赖与技术栈版本（见 `package.json` / `Cargo.toml`）、发布步骤细节（见 `.dev_docs/release-guide.md`）——抄进来即过时。*
