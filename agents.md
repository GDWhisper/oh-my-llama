# agents.md — 智能体协作准则（AI Agent Guidelines）

> **适用范围**：任何在本项目（`oh-my-llama`，Tauri 2 + React/TypeScript 桌面应用）中工作的 AI 代码代理、代码生成模型或自动化助手，**必须**严格遵守本文件。本文件优先级高于模型的默认习惯。
>
> **如何使用**：每次动手改代码前先读完本文件；当任务触及"停止并请示"条款时，先停、先问，不要自行推进。
>
> **动手前另请重点阅读文末「七、不得回退的工程护栏」**——其中列出的工程化不变量禁止以任何理由回退或绕过。

---

## 〇、当前工程结构（动手前必读）

本项目已完成 P0→P2 整改与 P3 工程化加固（lint/format 门禁、默认值后端单一真源、release 构建冒烟）。任何改动都**不得破坏以下已确立的结构与不变量**；不清楚某段代码为何存在时，先读完本节与第七节，不要"顺手简化"。

### 目录与职责
```
oh-my-llama/                    # 前端 React/TS + 构建配置
├── src/
│   ├── main.tsx                   # 入口，仅挂载 <App/>
│   ├── App.tsx                    # 纯组合根；含"加载配置中…"门控（config 为 null 时拦截渲染）
│   ├── types.ts                   # 前后端类型契约（ServerConfig / ServerStatus / ServerLogLine）
│   ├── hooks/useServer.ts         # 状态 + 命令聚合；配置值全部来自后端，无硬编码默认值
│   ├── lib/advanced.ts            # 高级参数常量与纯函数工具
│   └── components/                # 6 个展示型组件（props 强类型，无业务逻辑）
│       ├── ControlPanel / LogPanel / BasicParamsPanel
│       └── AdvancedParamsPanel / PreviewBar / ConfigPanel
├── src-tauri/
│   ├── src/lib.rs                 # 9 个 IPC 命令 + 5 个单元测试；ServerConfig::default() 为默认值唯一真源
│   ├── src/main.rs                # 入口，调用 lib.rs 的 run()
│   ├── Cargo.toml                 # 依赖精简，features 显式
│   ├── tauri.conf.json            # CSP 显式（非 null）；assetProtocol 已禁用
│   └── capabilities/default.json  # 最小权限：core:default + opener:default
└── .dev_docs/engineering-readiness.md   # 工程化就绪评审报告（含 P3 各状态）
```

### 已确立的关键不变量
- **默认值唯一真源在后端**：`ServerConfig::default()`（Rust）+ `get_default_config` 命令；前端 `useServer` 挂载时并行拉取 `read_config`+`get_default_config` 并占位回退，`config` 初始 `null`。前端无任何硬编码默认值。
- **门禁必须常绿**：`npm run check`（tsc + eslint + prettier + cargo fmt + clippy `-D warnings`）与 `cargo test --lib`（5 项）必须保持通过。
- **安全配置已收紧**：CSP 显式、asset 协议禁用、capabilities 最小权限——不得回退。
- **Git 工作流**：dev 分支为集成分支；重大改动先落 dev，勿直提交 main。

### IPC 命令清单（新增命令须同步三处）
`read_config` · `get_default_config` · `save_config` · `get_status` · `start_server` · `stop_server` · `open_preview` · `read_logs` · `clear_logs`
> 新增 / 修改命令时：① 在 `invoke_handler!` 注册；② 同步 `src/types.ts`；③ 确认 capabilities 覆盖（**自定义 app 命令默认允许**，仅插件命令与核心 JS API 才需显式授权，不要因此误加冗余 permission）。

---

## 一、核心准则（Core Principles）

### 1. 长期主义（Long-termism）
- 一切改动以**项目长期可维护性**为第一优先级。宁可多花一步做对，也不图一时省事留下技术债。
- 禁止"能跑就行"式补丁：不依赖巧合、隐藏副作用、复制粘贴或注释掉报错来绕过问题。
- 代码要像写给未来的维护者（包括你自己）看的说明书一样清晰；复杂逻辑必须有注释解释**为什么**，而非复述**是什么**。

### 2. 严守分层（Strict Layering）
本项目为标准 Tauri 2 双层架构，层级边界不可混淆：

- **表现层 / 前端（`src/`，React + TypeScript）**
  - 只负责 UI 渲染与用户交互；通过 `@tauri-apps/api` 的 `invoke` 调用后端命令。
  - **禁止**在前端直接实现进程管理、文件读写、系统交互等本属后端的逻辑。
  - **禁止**在前端硬编码业务默认值之外的系统路径。

- **核心层 / 后端（`src-tauri/src/`，Rust + Tauri）**
  - 只通过 `#[tauri::command]` 暴露能力、用 `tauri::State` 管理状态、用 `std::process` 管理子进程。
  - **禁止**后端命令直接操作 DOM 或返回未经序列化的内部类型。**禁止在代码里硬编码**端口/域名/版本/binary 名等配置项。

- **配置层（`tauri.conf.json`、`capabilities/`、`Cargo.toml`、`package.json`、`vite.config.ts`）**
  - 能力、权限、构建与打包的单一事实来源；权限遵循**最小可用**原则。

- 跨层通信**只**走 Tauri 的 invoke 桥（命令 + 类型契约），不绕开契约私自耦合前后端。

### 3. 缺陷修复必须追溯根因（Root-cause First）
- 修复任何缺陷前，先**复现并定位根因**，从软件工程角度判断它属于哪一层、哪一类问题（逻辑错误 / 边界条件 / 并发 / 资源泄漏 / 配置错误）。
- **禁止**在症状层打补丁：例如用 `unwrap` 吞错、用 `sleep` 等时序手法绕过竞态、用更宽松的权限掩盖越界访问、用文本替换脚本（patch 类脚本）覆盖源码。
- 修复后必须验证：同一根因不应以另一种形式复发；若修复会触碰其他层，需回到第二节的停止条款评估。

###  4. 奥卡姆剃刀（如无必要，勿增实体）
- 不引入不必要的抽象层、配置项、依赖、工具函数或开关。能用既有机制解决就不要新增；新实体的存在必须由其带来的真实收益证明，而非"将来可能用到"。
---

## 二、必须停止编码并请示的触发条件（STOP & ASK）

当任务落入以下任一情形时，**立即停止编写/修改代码**，向用户说明并等待明确指示，不得自行推进：

### 情形 1：必须破坏现有分层架构，或修改核心基础类
- 触发：必须破坏现有分层、修改核心基础类 / 共享状态结构、或新增大规模跨层耦合，才能完成当前任务。
- 先停下来说明：将破坏哪一层、影响哪些已有调用方、是否存在**不破坏分层**的可行替代方案。

### 情形 2：需引入新的外部依赖，或做重大框架升级
- 触发：需要新增 npm / crates 依赖，或将框架或语言版本做破坏性升级（如 Tauri 1→2、React 大版本、Vite 大版本、Rust edition 变更等）。
- 先停下来说明：为什么现有依赖不足以解决问题、候选依赖的安全 / 维护 / 体积成本、是否可用更轻量的原生方案。**若给出候选依赖选项，须逐条说明选中它的影响并给出你的推荐理由（格式见第三节）。**

### 情形 3：多方案各有明显取舍，且无法判定最优
- 触发：存在多种实现路径，在**性能 / 可维护性 / 复杂度**上有明显权衡，而当前信息不足以判断哪条更优。
- 先停下来给出 2–3 个方案的对比（含取舍与你的倾向），由用户拍板；**不要替用户做架构决策**。**对比必须包含每个选项的影响与你的推荐理由（格式见第三节），不得只抛选项让用户盲选。**

---

## 三、请示时应当提供的内容

每次停止请示，至少包含：

- **背景**：要解决的真实问题是什么（不是"要改哪一行"）。
- **已排除项**：已经考虑过但被否的简单方案及原因。
- **候选方案**：对情形 2 / 3，列出 2–3 个候选方案（避免过多导致选择疲劳）。
- **每个选项的影响（强制）**：以"选项"形式请示时，**禁止只罗列选项**——必须给每个选项用一两句话写清"选中它会带来什么影响"：改动触及哪些文件 / 层、是否引入新依赖及其安全 / 体积 / 维护成本、是否触碰既有不变量（见第七节）、后续回退难度等。让用户能在知情前提下判断，而不是盲选。
- **推荐理由（强制）**：若你倾向于某个（或某几个）选项，**必须同时写明推荐原因**——为什么它更优、更符合本项目准则（长期主义 / 严守分层 / 奥卡姆剃刀 / 门禁常绿等），或为何其他方案次优。**禁止只抛选项、不表态、不给理由，把架构与取舍决策完全推给用户。**
- **影响面**：预计改动触及哪些文件 / 层 / 对外契约（命令签名、权限、配置）。

> **反例（禁止）**：只问"用 A 还是 B？"后附两个干瘪选项，不解释各自代价、也不表态。**正例**：给出 A/B，分别说明各自影响（A 引入 X 依赖、改动 Y 文件；B 不改依赖但需自写 Z、可维护性较差），并明确"推荐 A，因为……"。

---

## 四、明确禁止的"速赢"陷阱（Don'ts）

- 禁止用 `text.replace` 类脚本对源码做"文本手术"（会导致静默失效、版本历史失真）；所有改动交给版本控制。
- 禁止以"本地能跑"为由关闭安全机制（如把 `tauri.conf.json` 的 `csp` 置 `null`、把 asset 协议 `scope` 放宽为 `**`）作为绕过手段。
- 禁止把构建产物 / 工具运行时缓存（如 `dist/`、`target/`、`/gen/schemas/`、`.codegraph/`）提交进仓库。
- 禁止让 Rust 命令与前端类型契约（`src/types.ts`）长期不一致而不同步。
- 禁止以"门禁太严 / CI 太慢 / 本地能跑"等理由关闭或绕过 `npm run check` 中的任一环节（`cargo clippy -D warnings`、`eslint`、`prettier`、`cargo fmt --check`）；告警要修根因，不要靠 `#[allow]` 或删配置项掩盖（详见第七节）。

---

## 五、工作流约定（建议）

1. 动手前先读相关层代码，确认改动落点符合分层。
2. 小步提交、单一职责；一次 commit 解决一个问题。
3. 涉及命令签名 / 权限 / 配置变更时，同步更新 `types.ts`、capabilities 与文档。
4. 不确定时，回到第二节的停止条款。

---

## 七、不得回退的工程护栏（DO NOT REVERT）

以下均为已落地的工程化成果，**禁止以"简化""本地能跑""门禁太严""CI 太慢"等任何理由回退或绕过**。回退会直接抵消历史整改，属本准则重点防范行为。

1. **Lint / Format 门禁（`npm run check` 必须常绿）**
   - 禁止移除 `eslint.config.js` / `.prettierrc.json` / `.prettierignore`，或从 `check:frontend` 中剔除 eslint / prettier。
   - 禁止把 `check:rust` 的 `cargo clippy ... -D warnings` 改为不带 `-D warnings`，或给代码加 `#[allow(clippy::...)]` 让红变绿——**修根因，不修告警**。
   - 提交前确保 `cargo fmt` 已执行，`cargo fmt --check` 不报错。

2. **默认值后端单一真源**
   - 禁止在前端重新引入 `DEFAULT_CONFIG`、`ADVANCED_DEFAULT` 或任何硬编码的 `ServerConfig` 默认值字面量。
   - 禁止删除 `App.tsx` 的加载门控（`if (!config) return <加载中…>`）或将 `config` 初始值改回硬编码对象。
   - 新增配置字段时，默认值**只在后端** `ServerConfig::default()` 定义一处，前端通过 `get_default_config` 获取。

3. **安全配置已收紧（不可回退）**
   - `tauri.conf.json` 的 `csp` 必须保持显式策略，**禁止置 `null`**。
   - `assetProtocol` 保持禁用，**禁止重新启用**（除非确有前端使用 asset 协议的需求，并同步收紧 `scope` 而非放宽到 `**`）。
   - `capabilities/default.json` 维持最小权限；新增权限须说明必要性，不得为"图省事"批量放开。

4. **测试必须保留且常绿**
   - `src-tauri/src/lib.rs` 的 5 个单元测试不得删除，不得用 `#[ignore]` 跳过来让门禁通过；改动相关逻辑后须使 `cargo test --lib` 仍绿。

5. **禁止文本手术补丁**：不得重新引入 `patch_frontend.py` / `patch_rust.py` / `patch.diff` 之类的源码文本替换脚本（历史已清除，见第四节 Don'ts）。

6. **提交纪律**
   - 禁止 `git commit --no-verify`、`npm install --ignore-scripts` 等绕过门禁的手段。
   - 重大改动先落 dev 分支，勿直提交 main；一次 commit 单一职责。
