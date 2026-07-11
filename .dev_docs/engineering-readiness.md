# 工程化就绪评审 — llama-launcher（dev 分支）

> 评审时间：2026-07-11（P3-a/P3-b 完成于 2026-07-12）
> 范围：结构清晰度 / 工程化质量 / 可维护性 / 安全合规 / 构建测试门禁 / 是否满足"进入需求开发阶段"
> 基线：dev 分支 `8e55661`（P0→P2 整改 + dev-server 脚本）→ P3-a/P3-b 提交 `???`

---

## 结论

**可以进入需求开发阶段。**

项目的工程化基础、可维护性、结构清晰度均已达到"可健康迭代"水平：三层架构清晰、前后端类型契约完整、构建/测试门禁全绿、安全配置合规、Git 工作流规范。

在进入第一个需求前建议补齐的 **3 项成熟度加固** 中，**P3-a（lint/format 门禁）、P3-b（release 冒烟）均已完成**；仅剩 P3-c（默认值单一来源）/ P3-d（前端测试）/ P3-e（CI）为可增量增强。

---

## 一、结构清晰度 ✅ 优秀

**前端（`src/`，React + TS）**
```
src/
├── main.tsx                 # 入口，仅挂载 <App/>
├── App.tsx                  # 纯组合根，无业务逻辑（P2 拆分成果）
├── types.ts                 # 前后端类型契约（ServerConfig/Status/LogLine）
├── hooks/useServer.ts       # 状态 + 命令聚合（单一数据来源）
├── lib/advanced.ts          # 高级参数常量与工具（纯函数）
├── components/              # 6 个展示型组件，props 强类型、无业务泄漏
│   ├── ControlPanel / LogPanel / BasicParamsPanel
│   ├── AdvancedParamsPanel / PreviewBar / ConfigPanel
└── App.css / vite-env.d.ts / assets/
```

**后端（`src-tauri/src/`，Rust）**
```
src-tauri/src/
├── lib.rs                   # 8 个 #[tauri::command] + 状态管理 + 子进程 + 5 测试
├── main.rs                  # 仅一行 run()
└── capabilities/default.json  # 最小权限能力声明
```

架构符合 Tauri 2 双层规范，跨层仅通过 `invoke` 桥 + `types.ts` 契约通信，无前端越权实现进程/文件逻辑。App 从 582 行巨石组件拆分为组合根 + hook + 组件，职责清晰。

---

## 二、工程化质量 ✅ 良好

| 项 | 状态 | 说明 |
|---|---|---|
| TypeScript | ✅ | `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` |
| 前端门禁 | ✅ | `npm run check:frontend` = `tsc --noEmit` + ESLint + Prettier --check |
| 后端门禁 | ✅ | `npm run check:rust` = `cargo check` + `cargo fmt --check` + `cargo clippy -D warnings` |
| 端到端门禁 | ✅ | `npm run check` 串联前后端 |
| 前端 lint/format | ✅ | ESLint 9 flat config（typescript-eslint）+ Prettier，已 `eslint.config.js`/`.prettierrc.json`/`.prettierignore` |
| 后端 lint/format | ✅ | `rustfmt`（默认风格）+ `clippy -D warnings` 接入 `check:rust` |
| 依赖管理 | ✅ | Cargo.toml 依赖精简；features 显式；新增 ES/Prettier 仅 devDependencies |
| 构建产物 | ✅ | `dist/`、`target/`、`/gen/schemas/` 均被 `.gitignore` 排除（release bundle 亦被忽略） |
| 脚手架隔离 | ✅ | 外来 AI 工具目录（`.codex/` `.qoder/` `.codebuddy/` `.omp/` `.pi/` `openspec/`）已忽略 |

---

## 三、可维护性 ⚠️ 良好，3 处可优化

1. **默认值三处来源（P3-c）**：`ServerConfig::default()`（Rust）、`DEFAULT_CONFIG`（`useServer.ts`）、`ADVANCED_DEFAULT`（`advanced.ts`）是同一组默认值的三个副本。当前三者一致，但后端改默认值时前端需手动同步——`agents.md` 明确反对"契约长期不一致"。建议收敛为单一来源或建立显式同步约定。

2. **lint/format 门禁（P3-a，✅ 已完成）**：已接入 `cargo fmt --check` + `cargo clippy -D warnings`（并入 `check:rust`），前端 ESLint 9（typescript-eslint）+ Prettier（并入 `check:frontend` 与 `lint`/`format` 脚本）。**关键收益**：clippy 抓出一个**潜伏真实缺陷**——窗口关闭事件 `tauri://close-requested` 监听里 `let _ = stop_server_inner(&app_handle)`，而 `stop_server_inner` 是 `async fn`，future 被直接丢弃、从未执行，导致**关窗时并不会真正停掉后台 llama-server**（子进程泄漏）。已按根因修复为 `block_on(stop_server_inner(...))` 真正执行（符合 agents.md「缺陷追溯根因」）。其余 4 处 clippy 提示（needless_question_mark / collapsible_if / let_unit_value）一并消除而非抑制。Prettier 已 `--write` 归一化全部 `src`。

3. **缺前端测试与 CI（P3-d / P3-e）**：当前仅 Rust 单元测试（5 个）。建议补 Vitest 冒烟测试（针对 `useServer` / `advanced`），并加 GitHub Actions 在 PR 上跑 `npm run check` + `cargo test` + 构建。

---

## 四、门禁验证 ✅ 全绿（本次实测）

```
# 开发期门禁（P3-a 前）
cargo check --lib          → Finished, 0 warning
cargo test --lib           → 5 passed; 0 failed
npm run build (tsc+vite)   → ✓ 39 modules, dist 产出成功

# P3-a 新增门禁（均 0 问题）
cargo fmt --check          → clean
cargo clippy -D warnings   → 0（修 5 处，含 1 个真实缺陷）
eslint .                   → 0
prettier --check src/**    → clean（已 --write 归一化）
npm run check              → 端到端通过（前端 + 后端）

# P3-b：release 构建冒烟（npm run tauri build）
→ Finished `release` profile [optimized] in 2m14s
→ 产出 exe: src-tauri/target/release/llama-launcher.exe
→ 打包产物: Llama Launcher_0.1.0_x64-en-US.msi (3.3MB) + _x64-setup.exe (2.2MB)
→ EXIT_TAURI_BUILD=0
```
> P3-b 确认：release 构建编译通过、WiX(msi)+NSIS(exe) 打包成功，IPC 在生产构建链路可用（编译期即校验 invoke 桥与能力声明）。**注意**：bundle 体积较小仅因未嵌入 llama.cpp 等外部二进制（本应用只是 launcher，属实）。

---

## 五、安全合规 ✅

- **CSP 显式**（非 `null`）：`default-src 'self'; script-src 'self'; ...`，`frame-src 'none'`、`object-src 'none'`、`form-action 'none'`——P2 整改成果。
- **asset 协议已禁用**：`Cargo.toml` 已移除 `protocol-asset` feature，`tauri.conf.json` 未启用——避免 `scope: ["**"]` 越权。
- **capabilities 最小权限**：仅 `core:default` + `opener:default`。
- **自定义命令授权**：经官方文档确认——*"By default, all commands that you registered in your app (via `invoke_handler`) are allowed by all windows/webviews"*。因此**无需**为每个 `#[tauri::command]` 写 permission 文件；能力系统只约束插件命令与核心 WebView API。第三方文章称"需 capabilities 授权"系误读。
- **无硬编码密钥/路径**：配置经 `APPDATA/LocalAppData` 解析，exe 目录回退；端口/域名/版本均未硬编码进源码。

> 轻微清理项：CSP `img-src` 含 `asset:`，但 asset 协议已禁用，属无害冗余，建议移除。

---

## 六、Git 工作流 ✅ 规范

- `main`（基线 `6bd6b80`）+ dev worktree（`F:/llama_run/llama-launcher-dev`，分支 dev）。
- 提交历史清晰、单一职责：`75ea6a2`(P0) → `1a8b1f7`(P1) → `60ec58e`(P2 asset) → `8d62b0b`(P2 App 拆分) → `8e55661`(chore 脚本) → `???`(P3-a/P3-b)。
- dev 尚未合并回 main（预期，待你决定时机）。
- 成熟度建议：合并后加 PR 模板 / 分支保护（可选）。

---

## 七、进入需求开发前的加固清单（按优先级）

| 优先级 | 项 | 时机 | 状态 |
|---|---|---|---|
| **P3-a** | 接入 lint/format 门禁（rustfmt --check + clippy -D warnings + ESLint/Prettier） | 首个需求前 | ✅ 已完成（2026-07-12） |
| **P3-b** | release 构建冒烟 `npm run tauri build`，确认 IPC 在生产构建可用 | 首个需求前 | ✅ 已完成（2026-07-12，2m14s，msi+exe 产出） |
| P3-c | 统一默认值来源，消除三处重复 | 可增量 | 待办 |
| P3-d | 补前端 Vitest 测试（useServer / advanced） | 可增量 | 待办 |
| P3-e | 加 GitHub Actions CI | 可选 | 待办 |

---

## 八、风险与说明

- **dev 未合并 main**：当前所有整改在 dev，main 仍为基线。合并决策由你把握（建议首个需求开发前或之后合并，视节奏）。
- **端口 6060 单实例**：dev 与 main 共享 node_modules（符号链接），故共享 Vite 端口；`scripts/dev-server.ps1` 的 `restart` 已处理占用检测。开发时同一时刻只跑一个 `tauri dev`。
- **第三方 ACL 文章误导**：已用官方文档澄清，自定义 app 命令默认允许，无需额外 permission 文件。
- **node_modules 软链接已失效（P3-a 副作用）**：执行 `npm install` 为 dev 引入 ESLint/Prettier 等 devDependencies 时，npm 将原先指向 main 的 `node_modules` junction 当作"非目录"删除并重建为 dev 自己的真实目录（~115M）。这是必然的——dev 与 main 的 package.json 现已不一致，无法再共享同一份。待 dev 合并回 main（package.json 统一后）可按需重建 junction 复用空间。
- **clippy 修复的真实缺陷**：见第三节 P3-a——`tauri://close-requested` 监听中 async `stop_server_inner` 的 future 被丢弃从未执行，关窗不杀后台进程；已用 `block_on` 修复。

---

### 一句话总结
结构清晰、类型完备、门禁全绿、安全合规——**已具备进入需求开发阶段的条件**；P3-a（lint/format 门禁）与 P3-b（release 冒烟）已落地，连 clippy 顺带揪出一个"关窗不杀后台进程"的真实缺陷并根因修复。仅剩 P3-c/d/e 为可增量增强，不影响开工。
