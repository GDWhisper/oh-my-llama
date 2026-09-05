# 更新日志 / Changelog

本项目所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件为**详细改动历史**（含涉及的文件与实现机制）；GitHub Release 页面为对应版本的**总结性**说明。

## [0.2.1] - 2026-09-06

### 新增功能
- **重复参数黄字提醒（解析预览 + 高级参数卡片）**：一键传参粘贴的命令行中若同一参数出现多次（含别名，如 `-c` 与 `--ctx-size`），解析预览会以黄字列出重复 flag 并把重复行标黄——只提醒不拦截，不阻止保存、不改变套用行为。实现：`src/lib/parseArgs.ts` 新增 `flagIdentityOf`（flag→归一身份的唯一入口，已知 flag 按落点归一为 `field:<field>` / `structured:<key>`，未收录的自定义 flag 按 `extra:<flag>` 精确同名判定），`buildPlan` 经统一入口 `pushRow` 维护与预览行严格对齐的身份平行数组，汇总出 `dupCount` / `dupFlags`；`src/components/RawParams.tsx` 在预览标题旁显示黄字提醒、行级 `dup` 黄色盖过自定义紫色。高级参数卡片（`src/components/AdvancedParamsPanel.tsx`）同口径复用 `flagIdentityOf`，把生效中的基础/结构化/自定义条目按身份分组计数，同一身份被 ≥2 个生效条目占用即在该身份下所有条目名称旁挂黄字 `DupBadge`（禁用项不参与判定）；`src/i18n/messages.ts` 补 `rawParams.previewDup` / `advanced.dupBadge` 等双语键，`src/App.css` 配套 `.dup-warn` / `.dup-badge` / `.dup` 样式。

- **日志窗口支持放大与 ESC 还原**：`src/components/LogPanel.tsx` 工具栏新增放大/还原悬浮按钮（`src/App.css` 新增 `.term-maximize`），放大态日志面板脱流为固定浮层，盖住顶部标题卡以外的全部区域；浮层 top 用 `useLayoutEffect` 实测标题卡底边（窗口 resize 重测），避免先以回退位置闪一帧；放大态下按 ESC 还原（对话框开着时让位给对话框的自关逻辑）；只切换样式与监听、不重建终端 DOM，贴底跟随/时间显隐等状态原样保留。`src/i18n/messages.ts` 新增 `log.maximize` / `log.restore` 双语键。

- **原始参数编辑态标题与操作按钮吸顶**：`src/App.css` 的吸顶规则由仅 `.advanced-panel .section-header` 扩展为同时命中 `.raw-params.editing .section-header`——原始参数编辑态下，标题与「复原」「完成」按钮随卡片滚到顶部时仍可见可操作（只读态不吸顶，保持现状）；吸顶位置沿用既有 CSS 变量 `--config-manager-h`，钉在常驻吸顶的配置管理卡片正下方不重叠。

### 功能优化
- 无

### Bug 修复
- **模型加载期间无法中途停止服务**：`src-tauri/src/lib.rs` 的 `start_server` 原先要等就绪轮询（最长 90 秒）结束才写 `managed=true`，加载期间 `get_status` 报 `managed=false` → 前端停止按钮置灰、`stop_server_inner` 拒绝停止，用户只能干等或杀进程。修复：进程拉起即记受管态（running 保持 false，就绪后自然翻转）；`start_server` 守卫条件由 `running && managed` 改为「受管且进程仍存活」（否则加载中重复点启动会 spawn 出第二个 llama-server）；新增 `LAST_USER_STOP_PID` 原子标记区分启动等待期进程退出的两种成因——用户手动停止（静默成功收场）与进程自行崩溃（照常报「启动失败」）；前端 `useServer.ts` 轮询门控补 `starting` 态，保证启动期间 ~1.5s 内点亮停止按钮并及时感知就绪。
- **慢加载不再误报「启动较慢」，报错透传具体原因**：`start_server` 等待超时且进程存活时，原先返回 Err 弹「启动较慢」提示，实为模型加载慢的误报；改为静默转后台监控（写入一条 info 日志说明已转后台，`get_status` 轮询接管，端口就绪自动翻转为运行中），窗口内进程退出才判启动失败。另外 `src/hooks/useServer.ts` 的启动错误提示原只认 `Error` 实例，后端以 String 返回的具体原因（端口占用/路径不存在/进程退出等）被笼统兜底文案吞掉，现在优先透传后端原文。

## [0.2.0] - 2026-09-05

### 新增功能
- **推理性能指标展示**：新增 `src-tauri/src/perf.rs`，解析 llama-server 日志中的 timings 行（兼容时间戳/slot 前缀与 ConPTY 折断行拼接），维护预处理/生成速度的最近一次与进程生命周期平均（Σtokens/Σ时间），经新事件 `perf://update` 推送前端；服务启停即清零测量窗口。`src/components/MetricsPanel.tsx` 展开态显示预处理/生成的「最近·平均」与累计请求数，`src/types.ts` 同步 `PerfSnapshot` IPC 契约，`src/i18n/messages.ts` 补 `metrics.*` 双语键。
- **运行日志落盘**：llama-server 运行日志逐行写入 `%APPDATA%/OhMyLlama/logs/llama-server_*.log`，滚动保留 20 份；`src-tauri/src/lib.rs` 新增 `open_logs_dir` 命令（注册进 `generate_handler!`），`src/components/LogPanel.tsx` 工具栏新增「日志文件」按钮直达目录。
- **多模态投影（--mmproj）与聊天模板文件（--chat-template-file）支持文件选择器**：`scripts/gen_structured_params.py` 引入 `FILE_PICKER` 旁路标注，`ParamSpec` 新增 `widget` 字段（仅提示前端控件形态，序列化与 `to_args` 语义不变），重跑生成同步 `src-tauri/src/params.rs`；`src/components/AdvancedParamsPanel.tsx` 按 `spec.widget === 'file'` 数据驱动渲染「输入 + 浏览」，选中即回填提交，无逐参数硬编码。

### 功能优化
- **显卡型号并入 GPU 行，收起态预览补生成速度**：`src/components/MetricsPanel.tsx` / `MetricsPanel.css` 将显卡型号并入 GPU 一行显示，收起态摘要附预处理/生成速度。
- **文件浏览默认目录更贴心**：聊天模板文件（`--chat-template-file`）浏览默认从 llama-server 路径所在目录打开；mmproj 浏览默认从已设置的模型目录打开（`src/components/AdvancedParamsPanel.tsx`）。

### Bug 修复
- **上下文长度输入清空后不再自动补 0**：`src/components/AdvancedParamsPanel.tsx` 数字字段清空后保持空白（原失焦即回填 `0`，打断连续输入），`src/i18n/messages.ts` 补占位提示键。
- **启动失败提示改用 Toast**：`src/hooks/useServer.ts` 启动失败提示由弹窗改为与其他操作一致的轻量 Toast。

## [0.1.10] - 2026-09-05

### 新增功能
- **日志时间显隐开关**：`src/components/LogPanel.tsx` 工具栏新增「时间」切换按钮，可在日志行前显示/隐藏时间戳；开关状态存入设置（`src-tauri/src/lib.rs` 的 `AppSettings` 新增 `log_show_timestamp` 字段，`#[serde(default)]`，旧 `settings.json` 向后兼容；新增 `get_log_show_timestamp` / `set_log_show_timestamp` 命令注册进 `generate_handler!`），`src/types.ts` 同步 IPC 契约。关闭时后端日志正文不再含时间列，日志正文铺满整行；`src/i18n/messages.ts` 新增 `log.toggleTimestamp` / `log.showTimestamp` / `log.hideTimestamp` 中英双键。
- **路径字段「打开」按钮（系统文件管理器直达）**：`src/components/PathField.tsx` 为 llama-server 路径与模型目录输入框在已有值时显示「打开」按钮，一键在系统文件管理器中定位该目录/文件。`src-tauri/src/lib.rs` 新增 `open_in_file_manager` 命令（Windows 走 `explorer /select,`、macOS 走 `open -R`、Linux 走 `xdg-open`，按目标存在性自动选择暴露文件还是目录），`src/components/BasicParamsPanel.tsx` 为模型目录字段接线；`src/i18n/messages.ts` 新增 `path.open` 中英双键，`src/App.css` 配套按钮样式。

### 功能优化
- **下拉展开时自动滚动到当前选中项**：共享 hook `src/hooks/useDropdownSearch.ts` 在下拉展开时把当前选中项 `scrollIntoView` 定位到可视区顶部，长列表（如模型候选）展开后无需手动寻找当前值；`src/components/ConfigManager.tsx` / `src/components/ModelSelect.tsx` 接线传递选中值。
- **「浏览」按钮文案去掉省略号**：`src/i18n/messages.ts` 的 `path.browse` 文案由「浏览…」改为「浏览」，与「打开」按钮并列时视觉更一致。

### Bug 修复
- **日志时间戳与墙钟差 8 小时**：`src-tauri/src/lib.rs` 的日志时间戳此前按 UTC 计算（显示与本地时间差 8 小时），改用本地时区（`Local`）格式化。

## [0.1.9] - 2026-09-04

### 新增功能
- **模型目录「最近使用」候选**：模型目录输入框升级为与 llama-server 路径输入框同款的「输入 + 候选」组合框，两处共用同一套后端路径历史机制。`src-tauri/src/lib.rs` 将原 llama-server 专属的 `server_key` / `remember_recent_server` / `server_candidates` 泛化为 `path_key` / `remember_recent_path` / `path_candidates`（候选来源由调用方按路径种类提取：`llama_server_path` / `model_dir`，合并、归一化去重、排序与 MRU 上限 10 的语义全部共享，纯函数可直接单测）；`AppSettings` 新增 `recent_model_dirs` 字段（`#[serde(default)]`，旧 `settings.json` 向后兼容），新增 `list_recent_model_dirs` / `remove_recent_model_dir` 命令（注册进 `generate_handler!`），`start_server` 成功拉起后在记 llama-server 路径的同时 `touch_model_dir_used`。前端 `src/types.ts` 将 `ServerCandidate` 更名为 `PathCandidate`（载荷注释同步），`src/hooks/useServer.ts` 新增 `modelDirCandidates` / `forgetModelDir` / `refreshModelDirCandidates`（与路径候选同批刷新：挂载、窗口聚焦、启动成功后），`src/components/BasicParamsPanel.tsx` 为模型目录字段传入 `suggestions` / `onRemoveSuggestion`，`src/components/PathField.tsx` 类型注解同步（组合框本体零改动即复用）。llama-server 路径与模型目录历史各自独立记账、互不串扰。
- **选择配置下拉可搜索**：`src/components/ConfigManager.tsx` 的下拉框获得与「选择模型」同款的搜索能力——抽出共享 hook `src/hooks/useDropdownSearch.ts`（过滤 / 打开聚焦 / 点外关闭 / 空间不足向上展开 / 回车选中首项，`ModelSelect` 与 `ConfigManager` 共用，消除两处重复逻辑）。配置条目统一渲染：默认配置按展示文案参与搜索且不显示 ✎/×，命名配置按名称过滤并保留重命名 / 删除按钮。`src/i18n/messages.ts` 新增 `config.searchPlaceholder` / `config.noMatch` 中英双键；视觉复用 `.model-search` 系列样式，零新增 CSS。

### 功能优化
- **首次启动语言跟随系统**：`src/i18n/I18nProvider.tsx` 的 `detectLang` 在无已保存语言偏好（首次启动）时改为按 `navigator.language` 判定——`zh` 前缀 → 中文，其余 → English（原固定返回中文）；`localStorage` 不可用同样退回系统语言检测，仅当 `navigator` 也不可用时才兜底中文。已手动切换过语言的用户行为不变（保存的偏好优先）。
- **设置浮窗「更新」卡片版本行布局**：`src/App.css` 的 `.settings-meta-row` 由两端分布（`space-between`）改为左侧聚拢成组，版本标签、版本号、NEW 徽标与检查按钮视觉归拢。

### Bug 修复
- 无

## [0.1.8] - 2026-09-03

### 新增功能
- **日志面板按需扩窗「加载更早日志」**：`src/components/LogPanel.tsx` 引入渲染窗口（`INITIAL_VISIBLE_LOGS = 800` / `LOAD_OLDER_STEP = 800`），默认只渲染过滤结果的尾部 800 行，仍有更早日志时顶部出现「↑ 加载更早日志」按钮按批扩窗（`src/i18n/messages.ts` 新增 `log.loadOlder` 中英双键，`src/App.css` 新增 `.term-older`）。满载 5000 行 × 每行 4 节点 ≈ 2 万 DOM 节点，此前每次批量 flush 都对全表做 reconciliation；改为窗口化后不引入虚拟滚动依赖即把开销降一个量级，流式场景（用户只关心最新输出）代价恒定。

### 功能优化
- **CPU 占用优化（前端渲染与轮询链路）**：静态审查结论与实施记录见 `docs/cpu-memory-audit-2026-09-03.md`（无内存泄露；2 处高优先级 CPU 热点 + 2 处中优先级持续开销，四项均已落地）。`src/hooks/useServer.ts`：`log://line` 增量行先写入 `logBufferRef`（ref 承载，高频写不参与渲染），由 `LOG_FLUSH_MS = 200` 定时器批量 flush 进 state，渲染频率与日志行频解耦（模型加载期 llama-server 以 `\r` 原地刷进度，逐行 `setLogs` 会让整棵 App 以行频重渲染）；行 key 由 `${ts}-${index}` 改单调递增 id（新增前端派生类型 `LogLine = ServerLogLine & { id }`，IPC 契约 `src/types.ts` 不变），消除后端有界缓冲满载 `shift()` 后全列表 key 变化导致的整列表重挂载；`setStatus` 前经 `sameStatus` 浅比较去重，服务静止时不再每 1.5s 触发全树重渲染；`handleClearLogs` 与 `log://clear` 一并丢弃未 flush 的缓冲行，保持清空时序语义。轮询频率随窗口可见性切换（可见 1.5s / 隐藏或托盘常驻 8s，`visibilitychange` 重建定时器），`src/components/MetricsPanel.tsx` 同构处理；状态轮询再加门控——仅 `managed || running` 时探测，空闲态 `useInterval` 传 `delay = null` 完全停表（外部起停服务属用户自身行为，OML 不为外部状态兜底探测；本应用启动撞端口时 `start_server` 即报失败，用户有反馈；冷启动必无受管进程，挂载时一次性 `loadStatus` 确认初始态）。
- **后端进程探测与状态锁优化**：`src-tauri/src/lib.rs` 的 `is_process_running` 原每次调用 `System::new_all()` + `refresh_processes()` 全量枚举整机进程表（受管期间每 1.5s、启动等待期每 500ms 各一次），改为 `static PROCESS_PROBE_SYS: LazyLock<Mutex<System>>` 常驻实例 + `refresh_process(pid)` 单点增量刷新（与 `metrics.rs` 的 `SYSTEM` 分离，二者刷新语义不同、互不干扰）；`get_status` 的 `probe_health` 移出状态锁执行（该探测同步阻塞最长约 2.3s = 连接超时 800ms + 读超时 1500ms，端口被「TCP 可连但不回 HTTP」的服务占用时才会走满），消除劣化路径下 `stop_server` / `start_server` / `open_preview` 排队等锁；`owned_alive` 仍在拿锁后计算，语义不变。
- **设置浮窗「更新」卡片整合**：`src/components/SettingsDialog.tsx` 将原先分散的版本信息、「检查更新」/「自动检查」开关与「更新代理」合并为单一「更新」卡片（`sectionIcons.proxy` 改为 `update`，新增 `settings.update` / `settings.updateHint` 文案），版本行与待更新徽标、检查按钮同排；「关于」卡片改为应用简介（新增 `about.desc`）+ 仓库入口。`src/App.css` 配套 `.settings-meta-row` 等样式，降低设置页信息密度。

### Bug 修复
- **外部服务占用端口被误标为本应用「运行中」**：后端 `get_status` 只要配置端口上有 `/health` 应答就置 `running = true`，归属差异只体现在 `managed`，而展示层判定只看 `running`——外部终端启动的 llama-server 或恰巧占用端口的其他 HTTP 服务会被渲染成自己的服务「运行中」，且此时停止按钮恰为禁用，状态与可执行操作自相矛盾。修复：展示态由四态扩为五态，判定收敛为纯函数 `src/lib/statusState.ts`（新增 `serverStatusState` / `StatusState`，供 `src/App.tsx` 头部徽章与 `src/components/ControlPanel.tsx` 控制区共用），`running && !managed` 判为「外部服务」并以蓝色信息态呈现（新增 `status.external`），地址行明确提示占用（新增 `control.externalAddr`）、「打开预览」禁用，停止按钮的红色危险态改由 `managed` 判定（仅受管含加载中时出现）。后端语义未动，仍忠实表达「端口有应答但不归本应用管」。
- **关闭询问弹窗选「直接退出」后应用无响应**：`src-tauri/src/lib.rs` 的 `resolve_close_choice` 是 `async` 命令（跑在 tokio worker 线程上），原先调用 `graceful_exit`，而后者内部 `tauri::async_runtime::block_on` 会在 runtime 线程上嵌套创建 runtime，触发 tokio panic「Cannot start a runtime from within a runtime」——表现为点「直接退出」后既不退出也无任何报错。改为直接 `stop_server_inner(&app).await` 后再 `app.exit(0)`（`app.exit` 先于 `Ok` 返回终止进程，前端该次 invoke 响应丢失属预期）；`graceful_exit` 补注释限定其仅可用于主线程 / 事件循环上下文（托盘菜单、`on_window_event`），该约束同源适用于 v0.1.7「退出统一走 graceful_exit」的托盘路径。

## [0.1.7] - 2026-09-02

### 新增功能
- **关闭窗口可最小化到系统托盘**：`src-tauri/Cargo.toml` 为 tauri 启用 `tray-icon` feature；`src-tauri/src/lib.rs` 创建托盘——左键单击恢复窗口，右键菜单「显示 / 退出」，菜单文案由前端经 `set_tray_labels` 命令按 i18n 下发（切语言后同步）。关闭分流收拢到 `on_window_event`：选托盘时仅隐藏窗口、服务照常运行；退出统一走 `graceful_exit` 先停服再退出，替换原先端 `tauri://close-requested` 监听（`prevent_close` 下该事件仍会发出，曾会在托盘场景误停服务）。`AppSettings` 新增 `minimize_to_tray` 三态偏好（`None`=每次询问 / `Some(true)`=托盘 / `Some(false)`=直接退出），旧 `settings.json` 缺字段按 `None` 解析、向后兼容。前端新建 `src/components/CloseBehaviorDialog.tsx`：首次关闭窗口时弹窗询问，勾选「记住选择」固化偏好；设置浮窗新增「关闭窗口时」三选一。`src/types.ts` 同步 `AppSettings`，`src/i18n/messages.ts` 补双语文案，`src/App.tsx` 接线。
- **llama-server 路径「输入 + 候选」组合框**：`src/components/PathField.tsx` 由纯输入框升级为聚焦即弹候选列表。候选两来源：本机最近启动成功过的路径（`settings.json` 新增 `recent_servers` 字段，MRU 上限 10，`lib.rs` 在启动成功时经 `remember_recent_server` 记录）+ 各命名配置里已填的路径（每次现扫 `configs.toml`，不落盘、不改配置结构），因此首次启动前也有内容。判重统一走 `server_key`（trim + `\` 转 `/` + 小写），与前端候选过滤同构，避免「看着一样其实两行」；配置路径按 `server_key` 排序补在后面，抵消 HashMap 迭代顺序不稳定。被命名配置占用的路径不显示删除 ×；`save_settings` 改为读-改-写，避免新字段覆盖 `settings.json` 其他设置。新增 `list_recent_servers` 命令与 `ServerCandidate` 类型（`src/types.ts` 同步），`src/components/BasicParamsPanel.tsx` 换用组合框。
- **配置命名弹窗「填入模型名称」按钮**：`src/components/NameDialog.tsx` 新增一键把所选模型文件名回填到名称输入框（自动去掉目录与 `.gguf` 后缀，`src/lib/advanced.ts` 新增 `modelBasename`）。三种弹窗形态取各自候选：「另存为」取当前表单模型，「重命名」取被重命名配置的模型（下拉框可重命名非激活配置，不能沿用表单值），「新建空配置」无候选则不显示按钮。按钮 `mousedown` 阻止默认行为以保持输入框焦点，回填后回车仍是提交。`src/hooks/useServer.ts` 提供各形态候选模型，`src/i18n/messages.ts` 补双语文案。
- **应用内展示更新说明**：更新弹窗原先只有占位正文（`latest.json.notes` 恒为空），用户在应用内看不到新版本改了什么。新建 `src/components/ReleaseNotes.tsx` 渲染 Markdown 子集（标题 / 列表 / 引用 / 粗体 / 链接），`ready` 态保留 version/body 在「重启安装」确认界面继续展示；新增「在 GitHub 查看完整说明」链接，`REPO_URL` 抽到 `src/lib/repo.ts` 与设置页共用。CI `.github/workflows/release.yml` 新增「Read release notes」步骤，按 tag 名读 `.dev_docs/release-notes-vX.Y.Z.md` 注入 `releaseBody`（同时落 GitHub Release 正文与 `latest.json.notes`）；发布指南与模板改为要求说明文件在打标签前随版本号一起 commit。

### 功能优化
- **轻量提示（toast）可手动关闭**：原 toast 为纯 div + 2.2s `setTimeout`，鼠标悬停也会消失、误操作时看不清内容。抽成 `src/components/Toast.tsx`：底部进度条动画走完才关闭，悬停暂停动画，点 × 立即关闭；消失时机直接监听该动画的 `animationend`，倒计时与动画同源、不会与 CSS 时长失步；`src/hooks/useServer.ts` 只存消息与用于重挂载重置动画的序号，避免每帧刷新进度导致整个 App 重渲染。
- **设置浮窗分组卡片化**：`src/components/SettingsDialog.tsx` 选项按组以卡片呈现，选项行整行可点、图标辅助扫读（`src/App.css` 配套样式），降低长表单的视觉密度。
- **自动检查更新对已忽略版本静默**：`src/hooks/useUpdater.ts` 新增 `dismissedRef`——用户点过「以后再说」或关闭弹窗的版本，自动检查不再重复弹提示与徽标，直到出现更高版本；手动检查不受此限制（那是用户主动要的反馈）。

### Bug 修复
- **手动「检查更新」被误判为自动检查**：设置页按钮 `onClick={onCheckUpdate}` 把点击事件对象透传进 `check(auto)`，事件对象为 truthy 被当成自动检查——v0.1.6 中手动检查无更新时毫无反馈、发现更新也不弹主窗（仅角落提示）。`check` 签名改为 `auto?: boolean` 且只认字面 `true`（`auto === true`），手动检查恢复正常弹窗与「已是最新」反馈。

## [0.1.6] - 2026-08-27

### 新增功能
- **HuggingFace / 推测解码参数识别（一键传参）**：`src/lib/parseArgs.ts` 在 `FLAG_INFO` 新增 `--hf` / `--hfd` / `--spec-draft` / `--spec-draft-n-max` / `--spec-draft-n-min` / `--spec-draft-p-min` 等条目（`kind:'known'`，原样转发并在「原始参数」卡片以友好文案展示），并在解析时剥离 shell 行续接符 `\`（多行命令行行尾的续接符不是参数内容）。`src/i18n/messages.ts` 新增对应 `preview.hf` / `preview.hfd` / `preview.spec_draft*` 中英文案。粘贴含 HuggingFace 仓库或推测解码（draft model）的命令行不再因换行续接符而解析错位。

### 功能优化
- **性能卡片 GPU 单行显示**：`src/components/MetricsPanel.tsx` + `MetricsPanel.css` 将 GPU 型号、显存、温度合并到同一行（展开态由「型号单独一行 + 显存/温度另起一行」改为「型号一行 + 显存·温度同行」），提升窄栏可读性；收起态保持单行紧凑。复用既有 `metrics.vram` / `metrics.temp` 文案。

### Bug 修复
- **日志实时性 + ConPTY 秒退**：后端 `src-tauri/src/lib.rs` 改用 `portable-pty` 伪终端（PTY）启动 llama-server（`Cargo.toml` 新增 `portable-pty` 依赖），替代原管道重定向——管道下子进程 stdout 被 CRT 全缓冲，表现为「原生日志直到进程退出才一次性涌出」；PTY 让子进程按行缓冲，遇换行即 flush。同时修复 ConPTY 生命周期管理（master PTY 宿主句柄随 `wait_process` 持有到子进程退出，避免刚启动即崩溃）；非 Windows 由 portable-pty 的 `setsid` 建立进程组、Windows 保留 Job Object（`CREATE_NO_WINDOW` 不再需要）。`src/hooks/useServer.ts` 新增 `listenGuarded`，消除 React StrictMode 双挂载下残留事件监听导致的日志双份；日志实时推送处补充空行分隔，流式可读性更佳。

## [0.1.5] - 2026-08-09

### 新增功能
- **支持 Linux 平台**：新增 Linux 安装包（`.deb` / `.rpm` / `.AppImage`），由 CI 在 `ubuntu-22.04` 构建。后端进程守护在非 Windows 上采用 **POSIX 进程组**方案：`start_server` 在 spawn 前经 `std::os::unix::process::CommandExt::process_group(0)` 把 llama-server 放入新进程组（组长即其自身），停止时 `request_graceful_stop` 对进程组发 `SIGINT`（终端 Ctrl-C 的等价信号），兜底强杀 `terminate_process` 向进程组发 `SIGKILL`（ESRCH 忽略）。Windows 侧 Job Object（`KILL_ON_JOB_CLOSE`，launcher 崩溃时内核回收子进程）语义原样保留——统一抽象为 `ProcessGuard`（Windows 持 `Option<JobHandle>` / 非 Windows 空结构体，`is_active()` 判定守护是否建立，字段有真实读取点避免 dead_code 误报）。`src-tauri/src/lib.rs`（全部 Windows 专属 import——`AsRawHandle` / `CommandExt` / `windows_sys`——加 `#[cfg(windows)]` 门控；`signal_console_ctrl_c` 更名 `request_graceful_stop` 并分平台实现）+ `src-tauri/Cargo.toml`（`windows-sys` 移入 `[target.'cfg(windows)'.dependencies]` 非 Windows 不编译；新增 `libc = "0.2"`，为 tauri 依赖树既有 crate、Cargo.lock 已锁定，零新增下载）。
- **支持 macOS（Apple Silicon / arm64）**：新增 macOS 安装包（`.dmg` / `.app.tar.gz`），由 CI 在 `macos-latest`（GitHub 原生 arm64 runner）构建。当前为**未签名版**（Gatekeeper 需右键打开；macOS 自动更新通道待 Apple Developer 证书就绪后启用）。推理侧无需适配——llama.cpp 官方提供 arm64 Metal 预编译二进制。
- **CI 三平台构建矩阵**：`.github/workflows/release.yml` 矩阵由单平台扩展为 `windows-latest` / `ubuntu-22.04`（新增 Tauri v2 官方 Linux 系统依赖安装步骤：`libwebkit2gtk-4.1-dev` 等）/ `macos-latest`；`latest.json` 由 tauri-action 自动聚合三平台更新资产。新增 `.github/workflows/build-check.yml`：dev 分支推送 / 手动触发时在三平台跑 `npm run check` 门禁 + `npm run tauri build` 完整打包冒烟（不发版、不上传产物），使非 Windows 编译问题在合并进 main 前即暴露。

### 功能优化
- 无

### Bug 修复
- 无

## [0.1.4] - 2026-08-08

### 新增功能
- **高级参数内联原始参数对照**：每个高级参数标签直接显示「名称（原始参数）」，如 `上下文长度（--ctx-size）`、`Top-P（--top-p）`。原始 flag 用等宽字体渲染（`App.css` 新增 `.param-flag`，字体栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`），解决中文无衬线字体里 `--` 偏高、不居中的问题；flag 与括号包进 `.param-flag-wrapper`（`white-space: nowrap`），避免布尔型参数标签被拆行错位。`src/lib/advanced.ts`（新增 `ADVANCED_FLAG` 映射表，为 9 个传统高级键各配规范长 flag：`--ctx-size` / `--n-predict` / `--n-gpu-layers` / `--threads` / `--batch-size` / `--temp` / `--flash-attn` / `--mmap` / `--mlock`）+ `src/components/AdvancedParamsPanel.tsx`（`withFlag` 改为返回 ReactNode，flag 包进等宽 `<span className="param-flag">`，友好名缺译回退到 flag 时不再重复包裹）+ `src/App.css`（`.param-flag` / `.param-flag-wrapper` + `.bool-field` 增加 `white-space: nowrap`）。

### 功能优化
- **「调整参数」选择器整合**：原「传统可选参数」与「官方参数注册表」分两区块渲染，搜索框被传统参数 chips 挤到第二行。现合并为单一选择器——搜索框置顶，下方 chips 同时含两类参数，按中文名 / key / flag 统一过滤；点击传统参数 chip 走 `onAddKey`，结构化参数 chip 走 `onAddStructuredKey`。`src/components/AdvancedParamsPanel.tsx`（新增 `AddableItem` 类型统一描述两类可添加参数，合并 `advanced-chooser` 与 `structured-chooser` 为统一 `structured-chooser`，复用既有样式）。
- **高级参数标题与「调整参数」按钮吸顶**：滚动到卡片底部时，标题与按钮钉在侧栏配置管理卡片正下方，始终可操作，且不影响配置管理卡片原有吸顶。实现上用 `ResizeObserver` 测量配置管理卡片实时高度写入 CSS 变量 `--config-manager-h`（`App.tsx` 新增 effect，依赖 `configReady = config != null` 以正确跨越加载门控时序——首次挂载时 `ConfigManager` 未渲染，`[]` 依赖会提前跑空永不重试，故在 `config` 就绪后才测量）；`.advanced-panel .section-header` 的 `top` 由 `0` 改为 `var(--config-manager-h)`，z-index(4) 低于配置管理卡片(5) 互不遮挡。

### Bug 修复
- **布尔型参数标签错位**：等宽 flag 与中文全角括号被浏览器拆行，导致 `mmap（--mmap）` 等名称、括号、flag 错位到不同行。已通过 `.param-flag-wrapper { white-space: nowrap }` 与 `.bool-field { white-space: nowrap }` 修复。`src/App.css`。
- **自定义参数删除按钮行为不一致**：自定义参数（`ExtraArgRow`）无条件显示删除按钮，而标准 / 结构化参数仅在「调整参数」开启时显示。现自定义参数删除按钮统一受 `adjustingAdvanced` 控制，与另两类参数一致。`src/components/AdvancedParamsPanel.tsx`（`ExtraArgRow` 新增 `removable` 属性，两个调用点传 `removable={adjustingAdvanced}`）。

## [0.1.3] - 2026-08-02

### 新增功能
- **服务状态新增「无响应」指示**：受管进程仍存活、但持续不响应（如系统睡眠后 CUDA/GPU 上下文失效挂死）时，顶栏状态徽章显示橙色「无响应」，与「运行中 / 加载中 / 已停止」三者区分。判定锚定「曾可服务」——仅当 `managed && 曾观测到 running===true && 连续 !running ≥ 60s（UNRESPONSIVE_MS）` 才置位；从没 Ready 过（大模型仍在慢加载）的进程**永不**进「无响应」，从而从结构上排除慢加载误判。`src/hooks/useServer.ts`（新增 `unresponsive` 状态 + `wasReadyRef`/`unreachableSinceRef` 两 ref + 模块常量 `UNRESPONSIVE_MS`，逻辑落在 `loadStatus` 内单一真源；`running===true` 或 `managed===false` 时清零）+ `src/App.tsx`（四态分支解构 `unresponsive`）+ `src/i18n/messages.ts`（新增 `status.unresponsive` 中「无响应」/英「Unresponsive」）+ `src/App.css`（新增 `.status.unresponsive` 橙 `#ffedd5`/`#9a3412`）。

### 功能优化
- **顶栏状态徽章升级为感知「加载中」**：原徽章只看 `running` 布尔（二态：运行中/已停止），导致「本应用已拉起进程、但模型尚未就绪（GET /health 未返回 200）」时误标红「已停止」。现感知 `managed` 字段，新增黄色「加载中」态，与控制区「模型加载中…」、启动按钮「启动中…」口径一致。`src/App.tsx`（状态推导三态→四态分支）+ `src/i18n/messages.ts`（新增 `status.loading` 中「加载中」/英「Loading」）+ `src/App.css`（新增 `.status.loading` 黄 `#fef3c7`/`#92400e`）。
- **系统唤醒即刷新服务状态**：原前端每 1.5s 轮询 `get_status` 一个 JS 定时器，系统睡眠/休眠期间被挂起，唤醒后需等最多一个周期才反映「睡眠中进程被回收/挂死」。现新增监听 Tauri 应用级事件 `tauri://resume`，系统唤醒即刻触发 `refreshNow()`（从轮询体抽出的 `useCallback` 单一真源，轮询与唤醒事件共用），状态秒级回正。`src/hooks/useServer.ts`（抽出 `refreshNow` + `resume` effect，补 `useCallback` import）。

### Bug 修复
- **修复系统睡眠/休眠后状态不刷新**：外部终端/任务管理器杀掉受管进程本已由 1.5s 轮询 + 后端 `owned_alive = managed && is_process_running(pid)` 自检复位正确捕捉；唯一缺口在系统睡眠——唤醒后状态延迟反映。已通过上面的 `tauri://resume` 即时刷新闭环解决（纯前端、零新依赖、不破分层）。

## [0.1.2] - 2026-08-02

### 功能优化
- **高级参数面板升级为数据驱动注册表（覆盖约 162 个官方 llama-server 参数）**：原高级参数仅含少量固定字段 + 约 150 个「已知 flag 原样透传」（粘贴进 extra_args，无结构化 UI）。现新增后端 `src-tauri/src/params.rs` 的 `PARAM_REGISTRY`（`&'static [ParamSpec]`，由 `scripts/gen_structured_params.py` 从识别表一次性生成，含类型 / 默认值 / 取值范围 / 枚举选项），`ServerConfig` 仅增 `enabled_structured_params` / `disabled_structured_params` / `structured_params` 三字段（枚举表（HashMap）置于结构体末尾以满足 TOML 序列化「表须在标量后」约束）；`build_server_args` 通用序列化启用项（bool 真值输出裸 flag、其余空值视为未设置）；前端 `get_param_registry` 拉取注册表后通用渲染 `AdvancedParamsPanel` 的 `StructuredParamRow`（按 ptype 分派 checkbox / number / select / input、可搜索过滤、支持临时禁用），未知 flag 仍原样透传。对应 `src-tauri/src/lib.rs` + `src-tauri/src/params.rs`（新增）+ `src/types.ts` + `src/lib/parseArgs.ts`（`structuredKeyOf` 复用 `preview.<key>` 后缀路由 known 解析到结构化、零新增识别字段）+ `src/hooks/useServer.ts`（拉注册表 + 四个结构化操作）+ `src/components/AdvancedParamsPanel.tsx` + `src/i18n/messages.ts`（中/英 `advanced.structured.*` 162 条 + 搜索文案）+ `src/App.tsx` / `src/components/RawParams.tsx`（接线传 registry）+ `scripts/gen_structured_params.py`（新增）。
- **i18n 模块拆分**：`src/i18n/index.tsx` 拆为 `I18nProvider.tsx`（组件）与 `useI18n.ts`（context + hook），桶文件仅 re-export，消除 `react-refresh/only-export-components` 告警，符合 Fast Refresh 单一导出约定。对应 `src/i18n/index.tsx` + `src/i18n/I18nProvider.tsx`（新增）+ `src/i18n/useI18n.ts`（新增）+ `src/main.tsx`（改从 `./i18n/I18nProvider` 导入组件）。
- **AGENTS.md 补充奥卡姆剃刀与可维护性平衡准则**：新增必须主动抽象的 3 条触发信号（逻辑重复 / 修改影响面大 / 业务易变），优先「未来改起来省力」而非「当下代码最少」。

### Bug 修复
- **运行中检测误报（端口已通但模型未就绪）**：原 `running` 用裸 TCP connect 探活，llama.cpp 某些构建先 bind 端口、后加载模型，导致端口刚 bind、模型未加载完成就误报「运行中」、点开预览连不上。现改用 llama.cpp 始终开启的 `GET /health` 就绪探针（`probe_health` + `HealthProbe` 枚举：Unreachable / Loading / Ready，TCP connect + 手写最小 HTTP，`200` / 非 503 = Ready、`503` = Loading、连不上 = Unreachable；纯标准库 `TcpStream` 无新依赖），`running = matches!(probe_health, Ready)`；`start_server` 改为 `wait_until_ready` 轮询 `/health` 直到 200（≤90s，不持锁）。前端 `ControlPanel` 启动按钮按 `managed` 禁用（防加载中重复拉起）、`managed && !running` 显示「模型加载中…」。对应 `src-tauri/src/lib.rs` + `src/components/ControlPanel.tsx` + `i18n/messages.ts`（新增 `control.loading`）。
- **启动阶段原生日志不实时 / 丢失**：原重写 `start_server` 时把原生日志读取（`wait_process` 的 `spawn`）挪到阻塞等端口就绪（`wait_until_ready`，≤90s）之后，导致模型加载期输出堵在 OS 管道无人读——前端「原生」模式启动阶段看不到实时日志、且管道写满反压 llama-server 拖垮启动。现把 `wait_process` 的 `spawn` 挪回 `cmd.spawn()` 之后、`wait_until_ready` 之前，与就绪探测安全并发。对应 `src-tauri/src/lib.rs`。
- **原生日志契约：raw = 完整日志（命令行 + 全部输出）**：确立 raw（原生）模式展示全部行——`cmd`（我们发出的命令行）+ `raw`（子进程原样输出）+ 应用结构化消息（`info` / `warn` / `error`）；brief（简要）模式仅应用结构化消息（`level` 既非 `raw` 也非 `cmd`）。后端 `pump_reader` / `channel` 只传纯文本、`consumer` 仅 append 一条 `level="raw"`（修复此前每行记两条导致的重复行）；渲染统一加 `[level]` 前缀（含 `[cmd]` / `[raw]`）。对应 `src-tauri/src/lib.rs` + `src/components/LogPanel.tsx`。

## [0.1.1] - 2026-07-28

### 新增功能
- **下拉选项悬浮提示（仅截断项）**：模型选择器与配置管理下拉框中，文本过长被省略号截断的选项，鼠标 hover 时显示完整文本的悬浮提示，且**仅当该项确实被截断**时才弹出（短文本不弹窗）。新建 `src/components/TruncatedText.tsx`（纯展示、零外部依赖）：用 `scrollWidth > clientWidth + 1` 判断真实溢出，提示经 `createPortal` 挂到 `document.body` 并以 `position: fixed`（按视口坐标）渲染，避免被下拉列表的 `overflow` 裁剪；下方空间不足时自动翻到选项上方；`pointer-events: none` 不挡点击。接入 `ModelSelect.tsx`（模型名选项 + 收起态触发器）与 `ConfigManager.tsx`（配置名选项含 default + 触发器）；`App.css` 新增 `.option-tooltip` 样式，`.select-value` 补 `min-width: 0` 以支持内部截断。高级参数面板的 2 个原生 `<select>`（n_gpu_layers / flash_attn）选项均很短不会截断、且原生弹窗由 OS 渲染无法逐项提示，按奥卡姆剃刀未改造。

### 功能优化
- **「分享参数」更名「分享配置」**：配置管理卡片分享按钮文案 `config.share` 中英文案由「分享参数」/「Share Params」改为「分享配置」/「Share Config」（`src/i18n/messages.ts`），同步 README 与 `App.tsx` / `parseArgs.ts` 注释；`IconButton` 的 `label` 同时驱动 `title` 与 `aria-label`，一并更新。
- **分享 / 复制语义区分**：分享复制当前选中配置的**已落盘快照**（不含未保存改动），复制复制框内**当前态**（含未保存改动）。`App.tsx` 的 `shareConfig` 复制来源由 live `config` 改为 `activeName === 'default' ? defaultConfig : configs[activeName]`（`defaultConfig` 纳入解构），`saved ?? config` 兜底；`RawParams.tsx` 的【复制】保持 `configToCommand(config)`（框内当前态）不变。
- **分享成功提示带配置名**：新增 i18n `app.share.copiedNamed`（`已复制 {name} 的参数到剪切板` / `Copied {name} parameters to clipboard`），`shareConfig` 传入 `activeName === 'default' ? t('config.default') : activeName`；原 `app.share.copied`（「已复制启动参数到剪切板」）保留给【复制】按钮。

## [0.1.0] - 2026-07-22

### 新增功能
- **模型选择器支持搜索**：原模型下拉框为原生 `<select>`，无法内置搜索，模型较多时难以定位。现新建 `src/components/ModelSelect.tsx` 以可搜索 combobox 替换，复用项目既有 `.select-box` 自定义下拉样式与点击外部关闭交互（`mousedown` 监听）；列表顶部搜索框对 `.gguf` 文件名做大小写不敏感子串过滤，打开时自动聚焦并清空上次查询；支持 `Enter` 选过滤后首项、`Esc` 关闭；区分「该目录下无 .gguf 模型」与「没有匹配的模型」两种空态；未选模型目录时整体禁用。`BasicParamsPanel.tsx`（用 `<ModelSelect>` 替换原生 `<select>`）+ `ModelSelect.tsx`（新建）+ `i18n/messages.ts`（新增 `basic.searchModel` / `basic.noMatch`，中英）+ `App.css`（删旧 `.model-select` 死样式，新增 `.select-trigger:disabled` 与 `.model-search*` 吸顶搜索框样式）。

- **高级参数卡片支持「临时禁用」**：每个高级参数卡片（除常驻必选的上下文长度 ctx_size 外）新增「禁用 / 启用」开关；禁用后卡片仍显示、已填值保留，但本次启动不把该参数写入 llama-server 命令行（默认值由后端 `ServerConfig::default()` 单一真源，前端无硬编码）。自定义参数（extra_args）行同样支持临时禁用，采用双列表方案：`extra_args` 仅存启用项、`disabled_extra_args` 存禁用但保留的文本，切换即在这两列表间移动整组 `[flag, value]`。后端 `build_server_args`（Rust）与前端 `configToCommand`（预览 / 分享）统一按「启用且未禁用」判断，保证启动命令与「原始参数」卡片展示一致。`src-tauri/src/lib.rs`（新增 `disabled_advanced_params` / `disabled_extra_args` 字段含 `#[serde(default)]` 向后兼容旧配置 + `build_server_args` 跳过禁用项 + 单测 `build_server_args_skips_disabled`）+ `src/types.ts` + `src/hooks/useServer.ts`（`disabledAdvancedKeys` 状态、`toggleDisableKey`、`applyEnabled`/`add`/`remove`/`clearAdvanced` 同步禁用态）+ `src/components/AdvancedParamsPanel.tsx`（每卡禁用开关 + 双列表自定义参数行）+ `src/lib/parseArgs.ts`（`configToCommand` 跳过禁用项）+ `src/App.tsx`（`applyPlan` 套用粘帖命令时清空禁用列表、extra-arg 增删改列表感知 + `toggleExtraArg`）+ `i18n/messages.ts`（中/英 `advanced.disable` / `advanced.enable` / `advanced.disabled`）+ `App.css`（`.field.disabled` 置灰 + `.disabled-badge` 徽标 + `.field-actions`）。

### 功能优化
- **模型下拉框按视口空间自适应展开方向**：原生 `<select>` 无法翻转，自定义 `ModelSelect` 打开时用 `useLayoutEffect`（依赖 `open, models, query`）在绘制前测量 trigger 视口位置、列表实际高度与上下剩余空间——下方放得下则向下（默认），放不下而上方更宽裕则翻转为向上展开（`App.css` 新增 `.select-list.drop-up { top:auto; bottom:calc(100% + 4px) }`）；搜索过滤改变列表高度时重新决策，因在绘制前完成故无闪烁。`ModelSelect.tsx` + `App.css`。

### Bug 修复
- **运行时往模型目录新增模型后列表不刷新**：原下拉框只在 `config.model_dir` 字符串变化时才通过 `useEffect` 扫描一次目录，导致程序运行期间往同一目录下载新 `.gguf` 后，列表停留于启动时的旧快照、必须重启应用才能看到，且「重新选同一目录」因路径字符串不变也不会重扫。现于 `src/hooks/useServer.ts` 的 `model_dir` effect 内额外监听 `window` 的 `focus` 与 `document` 的 `visibilitychange`（可见态），切回窗口 / 从最小化恢复即调用 `loadModels(dir)` 重新向 `list_models` 后端命令拉取并刷新下拉框，无需重启、纯前端、零新依赖。`src/hooks/useServer.ts`。

## [0.0.9] - 2026-07-20

### 新增功能
- **「原始参数」卡片（替代「一键传参」）**：配置管理下方新增只读卡片，以 `configToCommand(config)` 实时派生完整启动命令行，与「必要参数 / 高级参数」卡片共用同一 `config` 工作态，天然实时同步。点击【编辑】进入编辑态——textarea 预填当前命令，改动经 ~300ms 防抖实时回写 `config` 并即时反映到必要/高级卡片；【复原】回到进入编辑时的配置快照（`onRestore` = `setConfig` + `applyEnabled`），【完成】退出并做最终归一化（清掉打字中途产生的脏 `extra_args`）。`src/components/RawParams.tsx`（由 `ParamPaste.tsx` `git mv` 重命名）+ `src/App.tsx` + `src/lib/parseArgs.ts`。
- **未保存改动提示**：`useServer` 新增派生 `isDirty`（`JSON.stringify(config)` 与已落盘基线 `configsRef[name]`/默认配置深比较），覆盖所有面板改动；配置管理标题旁常驻带圈 i 图标，脏时亮起。`src/hooks/useServer.ts` + `src/components/ConfigManager.tsx` + `App.css`（`.unsaved-icon`/`.panel-header-left`）。
- **「恢复配置」按钮**：选择配置下拉框右侧新增环形箭头图标按钮，将当前 live 配置回滚为当前选中配置的已保存版本（`selectConfig(activeName)`）；干净时置灰禁用，有未保存改动时点击弹红色确认框，避免误丢。`src/components/ConfigManager.tsx` + `src/App.tsx`（守卫 `requestRestore`）+ `i18n/messages.ts`（新增 `config.restore*`）。

### 功能优化
- **启动命令展示位置调整**：原生日志置顶的启动参数展示已彻底移除（`useServer` 的 `commandLine` state、相关监听与 `LogPanel` 置顶块全删），统一由「原始参数」卡片展示。`src/hooks/useServer.ts` + `src/components/LogPanel.tsx` + `src/App.tsx`。
- **「原始参数」只读/编辑框体统一**：两态提炼为同一 `.raw-box` 基类（几何/配色/字体只写一处），差异仅 `.raw-box--edit` 修饰符（可拖拽缩放/光标/聚焦描边），根除手动同步导致的尺寸漂移；滚动条改为优雅隐身（`scrollbar-width:none` + `::-webkit-scrollbar{width:0}`），零宽度不占排版空间，切换时文字零位移仍可滚轮/拖选滚动。`src/App.css` + `src/components/RawParams.tsx`。
- **复制按钮提示**：「原始参数」卡片【复制】复制后弹 toast（成功/失败），复用 `app.share.copied`/`copyFailed` 文案。`src/components/RawParams.tsx` + `src/App.tsx`（注入 `showToast`）。
- **`--timeout` 无损往返**：`parseArgs.ts` 注册 `--timeout` 为 `ignore` 类已知 flag，复制出的命令粘回时不污染 `extra_args`，保证往返一致。`src/lib/parseArgs.ts`。
- **文档**：双语 README 核心亮点之上添加概览图，删除英文版空 src 错误图片引用（commit 6360691）。`README.md` / `README_En.md` / `public/overview.png`。

### Bug 修复
- **切配置串台**：在「原始参数」编辑态切换/恢复配置时，残留的旧配置编辑文本与待触发防抖定时器会把旧参数误写进新配置。`useServer` 新增 `configEpoch`，每次从已落盘版本载入 `config` 时 +1；`RawParams` 编辑态重置 effect 依赖由 `[configName]` 扩为 `[configName, configEpoch]`，切换/恢复时强制退出编辑态、清空草稿、清理防抖；自身防抖回写不 bump epoch，不会误重置进行中的编辑。`src/hooks/useServer.ts` + `src/components/RawParams.tsx`。

## [0.0.8] - 2026-07-19

### 新增功能
- **系统性能面板（CPU / 内存 / NVIDIA GPU 实时占用）**：日志面板上方新增性能监控卡片，每 1.5s 轮询一次。后端新增 `src-tauri/src/metrics.rs`（`sysinfo` 采 CPU 全局占用与内存总量/已用，`global_cpu_info().cpu_usage()`；`nvml-wrapper 0.10` 动态加载 `nvml.dll` 采 N 卡利用率、显存已用/总量、温度，无 N 卡/驱动时优雅降级为空列表），以 `static SYSTEM/NVML: LazyLock` 全局单例复用；新增 `get_system_metrics` 命令返回蛇形序列化的 `MetricsSnapshot`，在 `lib.rs` 注册。前端新增 `src/components/MetricsPanel.tsx` + `.css`，挂到 `App.tsx` 日志面板上方。i18n 补 `metrics.*`（中/英）。`src-tauri/Cargo.toml` 新增 `nvml-wrapper` 依赖。

### 功能优化
- **性能面板改为纯数值 + 收起/展开**：移除占用条/迷你折线/每核热力条等图形，改为浅色主题纯文本数值（与全局白卡一致）；卡片头部加朴素文字「收起/展开」按钮（无图标）——展开=完整分行列值（CPU% / 内存 used/total% / GPU 名称·显存·温度），收起=单行紧凑（`CPU x% · 内存 x% · GPU x% · 显存 x%`，多卡以 `/` 分隔，无 N 卡/无总量时不显示显存）。i18n 补 `metrics.collapse/expand`。`src/components/MetricsPanel.tsx` + `.css`。
- **更新代理支持裸本地地址**：`save_settings`（`src-tauri/src/lib.rs`）不再强制要求 `http://` 前缀——填写裸地址（如 `127.0.0.1:7897`、`localhost`）时自动补全为 `http://`；仅当显式写了非 `http`/`https` 的协议（含 `://`）才报错，提示改为「仅支持 http:// 或 https://」。同步去掉设置项中「裸地址自动按 http 处理」的冗余提示文案（`i18n/messages.ts`），交由系统静默处理。
- **应用图标改为苹果风圆角正方形**：`src-tauri/app-icon.svg` 圆角半径由直角 `rx=4` 提升至 `rx=5.6`（≈22% 边长，iOS/macOS 图标标准圆角比例），背景平滑圆角、白色 OML 像素字保持硬边；`tauri icon` 重生成 `src-tauri/icons` 全套平台图标并同步 `src-tauri/app-icon.png` 母版与前端 `public/llama.png`(favicon)。

## [0.0.7] - 2026-07-18

### 新增功能
- （本版本无新增功能。）

### 功能优化
- （本版本无功能优化。）

### Bug 修复
- **「更新代理」设置保存报错**：正式版在「设置 → 更新代理」填写地址（如 `127.0.0.1:7897`）点保存，报错 `invalid args updateProxy for command save_settings: command save_settings missing required key updateProxy`，导致代理设置无法保存。根因为 Tauri v2 默认把命令的蛇形形参名（Rust 侧 `save_settings(_app, update_proxy)`）按**驼峰**暴露给 JS，而前端 `invoke` 当初错传蛇形 `update_proxy`。修复仅改前端传参键名为驼峰 `{ updateProxy: proxy }`（`src/components/SettingsDialog.tsx`），与项目其它命令（`oldName`/`newName`/`config` 等）约定一致；Rust 侧 `save_settings` 及返回值结构体 `AppSettings` 的 `update_proxy` 字段均不变。

## [0.0.6] - 2026-07-18

### 功能优化
- **替换应用图标为像素风 OML 品牌图标**：弃用 Tauri 默认图标，改为极客像素风——黑底圆角方 + 白色像素字体 **OML**（Oh My Llama 缩写）。新增矢量母版 `src-tauri/app-icon.svg`（逐像素 `<rect>` 手工绘制、`shape-rendering="crispEdges"` 保证硬边像素感、无 AI 水印），由其渲染 1024² PNG 源图后通过 `tauri icon` 一键重生成 `src-tauri/icons` 全套平台图标（ico/icns/png/Windows StoreLogo/64×64/iOS/Android），覆盖原默认图标；前端 favicon 改用同源 `public/llama.png`，移除占位的 `public/vite.svg`，`index.html` 引用同步更新。经实测确认运行图标（标题栏/任务栏/Dock）与安装图标（安装器 exe / .app 包）均统一为新图标。

### 新增功能
- （本版本无新增功能。）

### Bug 修复
- （本版本无专门缺陷修复。）

## [0.0.5] - 2026-07-16

### 新增功能
- **更新代理设置（显式可选）**：设置浮窗新增「更新代理」输入项，仅当用户主动填写 `http(s)://` 地址时，更新检查才经由该代理；留空则更新直连系统网络（启动时主动 `remove_var` 清掉 `HTTPS_PROXY/HTTP_PROXY` 等，避免被未运行的本地代理坑住）。后端新增 `AppSettings` 结构（与服务器启动配置 `ServerConfig` 解耦）及 `read_settings`/`save_settings` 两个命令，单独持久化到 `APPDATA/OhMyLlama/settings.json`，不污染 `configs.toml`，也不干预用户代理客户端的全局/规则模式；`save_settings` 写入后立即 `apply_update_proxy_env` 生效，无需重启。`src-tauri/src/lib.rs` + `src/types.ts`（`AppSettings` 接口）+ `src/components/SettingsDialog.tsx` + `i18n/messages.ts`（中/英 `settings.updateProxy*`）。

### 功能优化
- **更新失败报错细化**：`UpdateDialog` 新增 `classifyUpdateError`，将底层 Rust/reqwest 抛出的原始错误归类为代理未连通 / 连接超时 / 404 未发布 / 签名校验失败 / 通用，给出对应中文提示，并以等宽文本 `<pre>` 原样展示底层英文错误供排查；新增 `update.errProxy`/`errTimeout`/`errNotFound`/`errSignature`/`errGeneric`/`errorDetail` 等 i18n 键（中/英）。`src/components/UpdateDialog.tsx` + `i18n/messages.ts`。
- **布尔参数表现优化**：`mmap`/`mlock` 由「字段内额外占一行的独立 checkbox（名称 `mmap` 文字hardcode）」改为与参数名称**同行**的紧凑复选框（名称在前、复选框紧贴名称），`AdvancedParamsPanel` 通过 `isBool` 分支渲染 `.bool-field`，并移除原 field 内冗余的 `mmap`/`mlock` checkbox 块；`App.css` 新增 `.bool-field`。`src/components/AdvancedParamsPanel.tsx` + `App.css`。
- **分享参数改为带边框图标**：「分享参数」按钮由文字按钮改为带边框 SVG 图标（仿设置齿轮按钮的 `.icon-btn` 白底灰边方盒样式），置于配置管理卡片标题行右上角；同步提取公共组件 `IconButton`（`label` 同时驱动 `title` 与 `aria-label`，`children` 传 SVG），标题栏齿轮按钮与配置管理分享按钮均改用之。`src/components/IconButton.tsx`（新建）+ `src/components/ConfigManager.tsx` + `src/App.tsx` + `App.css`（`.icon-btn`/`.panel-header`/`.settings-*`)。

### Bug 修复
- （本版本无专门缺陷修复；更新报错细化与布尔参数排版归为功能优化。）

## [0.0.4] - 2026-07-16

### 功能优化
- **日志面板交互重构**：「回到底部」按钮由滚动容器内的绝对定位改为固定在日志区右下角（新增不滚动的 `.terminal-viewport` 包裹层，相对其定位），始终可见可点；自动跟随改用 `useLayoutEffect` 在绘制前同步置底，消除流式输出下的滚动竞态，阈值由 24px 放宽至 32px；新增 `wheel`（上滚即时解锁）与 `pointerdown/up`（拖拽期间暂停）监听以精确识别用户意图；切模式（简要/原生）后若处锁定态则重新贴底。`LogPanel.tsx` + `App.css`。
- **「一键传参」面板常驻显示**：移除配置管理卡片的「一键传参」入口按钮（及 `onParamPaste` prop），面板改为始终渲染于配置管理与必要参数卡片之间；移除面板自身的关闭 × 与「取消」按钮，套用后清空输入框避免重复套用；清理 `messages.ts` 的 `config.paramPaste` 键（中/英）与 `App.css` 的 `.param-close` 样式。`App.tsx` / `ConfigManager.tsx` / `ParamPaste.tsx` / `i18n/messages.ts`。
- **保存配置按钮统一并常驻顶部**：移除「必要参数」「高级参数」两张卡片内的「保存配置」按钮及其 `saving`/`onSave` prop；仅保留配置管理卡片右侧一处。配置管理卡片加 `position:sticky; top:0; z-index:5`，侧栏滚动时（含下拉列表 `z-index:20` 与全屏弹窗 `z-index:1000`）仍钉在顶部，始终可点保存。`BasicParamsPanel.tsx` / `AdvancedParamsPanel.tsx` / `App.tsx` / `App.css`。

### Bug 修复
- **日志「回到底部」按钮不可点**：原 `.term-jump` 绝对定位在会滚动的 `.terminal` 内部，仅滚到底时落在视口内可见，而上滚查阅历史时正需该按钮却已被滚出视口，形同虚设。已通过新增不滚动包裹层并相对其定位修正。
- **流式输出下自动跟随被误解除**：原 `useEffect` 异步置底 + 24px 阈值在日志快速追加时，程序化置底触发的 scroll 事件读到尚未一致的 `scrollHeight`/`scrollTop`，误判为用户上滚而中断自动跟随；改用 `useLayoutEffect` 与 32px 阈值消除竞态。

## [0.0.3] - 2026-07-14

### 新增功能
- **国际化（i18n）框架 — 中 / English 双语**：新增无第三方依赖的轻量 i18n 层（`src/i18n/`：字典 `messages.ts`、`I18nProvider` + `useI18n` 钩子），语言选择持久化并即时切换。全部界面组件（`ConfigManager` / `BasicParamsPanel` / `PathField` / `AdvancedParamsPanel` / `LogPanel` / `NameDialog` / `ConfirmDialog` / `App` / `useServer` 等）改为 `t(key)` 取文案；中英字典键在编译期保持一致（TypeScript 键类型约束），漏键即报错。
- **设置浮窗（齿轮入口）**：标题栏右上角新增齿轮按钮（Material Design 标准 settings 路径）打开居中 Modal `SettingsDialog`（复用 `.modal-overlay`/`.modal`，支持 Esc 与遮罩关闭）。语言切换由标题栏移入设置浮窗，`LangSwitch` 支持 `variant='segment'`（标题栏分段）与 `'list'`（浮窗内列表式单选，「中文 / English」带选中勾）两种形态。服务状态标签移至「Oh My Llama」标题左侧。
- **应用内更新通道（方案 A：`tauri-plugin-updater`）**：设置浮窗「关于」分组新增「检查更新」按钮，**手动触发**（不做启动自动检查、暂不提供开关）。Rust 侧 `Cargo.toml` 引入 `tauri-plugin-updater`、`lib.rs` 注册插件、`capabilities/default.json` 加 `updater:default`、`tauri.conf.json` 加 `plugins.updater`（`endpoints` 指向 Release 的 `latest.json`、`pubkey` 公钥、Windows `installMode: passive`）。前端新增 `src/hooks/useUpdater.ts`（状态机 idle→checking→available→downloading→ready→no-update→error）与 `src/components/UpdateDialog.tsx`（版本对比 + 发布说明 + 进度条 + 取消 + 「重启安装」）。下载**可见、可取消**（`Update.close()` best-effort 中断），安装**必须显式确认**，绝不后台静默安装。CI（`release.yml`）加 `TAURI_SIGNING_PRIVATE_KEY` 注入 + `includeUpdaterArtifacts: true` + `updaterJsonPreferNsis: true`，产出 `.sig` 与 `latest.json`。

### 功能优化
- **语言按钮样式自适应**：设置浮窗内语言选项 `.lang-list` 由竖向改为 `row + flex-wrap`（空间足够并排、不够自动换行）；`.lang-list-item` 去除占满整行的 `width:100%`，改为按字体自适应的内边距（`0.55em 1.1em`）+ `white-space:nowrap`，选中勾图标改 `1em` 跟随字体；`.modal-body` 加 `gap:18px`，语言栏与关于栏之间留出间距。
- **英文文档**：新增 `README_En.md`（`README.md` 全文英译），两文件顶部加语言互索引（`中文 | English`，当前语言加粗、另一语言超链接互指）。
- **发布文档**：`.dev_docs/release-guide.md` 补「六、更新机制（方案 A）」章节（密钥/签名/CI 产物/发版生效/坑）；`agents.md` 同步索引。

### Bug 修复
- **清理既有 Rust 告警**（`check:rust` 要求 `-D warnings`，与本版功能无关但阻断门禁）：`lib.rs` 测试中 3 处 `..ConfigStore::default()` 因字段已全赋值触发 `clippy::needless_update`，已删除；仅测试使用的 `serialize_config_value` 触发 lib 目标 `dead_code`，加 `#[cfg(test)]` 限定。

## [0.0.2] - 2026-07-14

### 新增功能
- **配置管理【保存为新配置】**：`ConfigManager` 新增按钮，点击后基于当前表单参数调用 `confirmName` 的 `save-as-new` 分支，以新名称另存为独立命名配置并立即激活，不覆盖原配置（默认配置与命名配置均适用）。`NameDialog` 文案改为「将以当前参数生成一个新的配置（不影响原配置）」。
- **后端 `file_size` 命令**：`src-tauri/src/lib.rs` 新增 `#[tauri::command] fn file_size(path: String) -> Option<u64>`。空路径或文件不存在返回 `None`，否则返回字节数；已注册进 `invoke_handler`。前端 `useServer` 新增 `modelSize` 状态与 `loadModelSize`（调用 `invoke('file_size')`），在模型路径变化 `useEffect` 与 1.5s `useInterval` 两处加载，文件缺失 / 空时置 `null`。

### 功能优化
- **标题卡片模型大小展示**：`ControlPanel` 接收 `modelSize` prop，在「当前模型」行后附 `· X.X GB`（`modelSize / 1024 / 1024 / 1024` 取一位小数），仅模型存在且有大小时显示。
- **地址文案统一**：未启动由「请先启动服务」改为「服务地址：服务未启动」；启动后由「预览地址：…」改为「服务地址：…」（保留 `.preview-url` 类名）。
- **按钮配色（非修复部分）**：【启动】补 `variant="secondary"` 保持白底；服务运行中【停止】切换为 `danger` 红色；`ControlPanel` 从 `extra_args` 偶数索引检测 `--no-webui`，命中则【打开预览】置灰（`disabled` + `title="预览因参数已禁用"`）。
- **一键传参拆分为两个按钮**：`ParamPaste` 底部由单个【确认添加】改为【覆盖参数】（整体替换 `extra_args`，与原行为一致）与【追加参数】（拼接至现有 `extra_args` 之后）；两按钮均为白底、`disabled` 当无解析结果。
- **追加模式剔除必要参数**：`applyPlan(plan, 'append')` 仅套用高级参数并启用对应高级键、拼接自定义参数，**不覆盖** `model / host / port / llama_server_path / model_dir`（这些必要参数保持当前配置；`model_dir` 派生仅在覆盖模式执行）。若粘贴内容含必要参数，弹窗列出并引导点击【覆盖参数】。
- **重复参数提醒移入弹窗**：追加前在 `setConfig` 之外比对现有 `extra_args` 的 `[flag, value]` 对，找出完全相同的自定义参数，在追加确认弹窗内非阻塞列出（列表超 3 个折叠为「等 N 个」），不再使用 toast。

### Bug 修复
- **按钮禁用态误显蓝底**：根因为通用规则 `button:disabled { background:#93c5fd }` 特异度 (0,1,1) 高于 `.btn-secondary { background:#fff }` (0,1,0)，致使任何禁用态按钮（运行中置灰的【启动】、未运行时的【打开预览】）回退为浅蓝。`App.css` 新增 `.btn-secondary:disabled { background:#fff; color:#9ca3af; border-color:#e5e7eb; cursor:not-allowed }`（特异度 0,2,0）压制通用规则，禁用态保持白底灰字。

## [0.0.1] - 2026-07-13

### 新增功能
- 首次发布。
- **多配置管理**：切换 / 新增 / 重命名 / 删除 / 保存配置（默认配置不可重命名与删除）。
- **一键传参**：粘贴 `llama-server` 完整命令行，自动解析并将参数套用到对应字段，未知参数以自定义参数（`extra_args`）保留。
- **配置分享**：当前配置序列化为完整启动命令行并复制到剪贴板，便于直接分享给他人运行。
- **实时进程控制**：启动 / 停止服务、打开预览，并实时显示进程状态。
- **后端进程守护**：基于 Windows Job Object 的进程守护与优雅退出（`KILL_ON_JOB_CLOSE` + `CTRL_C_EVENT`），服务停止时一并清理子进程。

### 说明
- 本版本仅提供 Windows 安装包（`.exe` NSIS / `.msi`），无需预先安装 Node / Rust。

[0.1.8]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.8
[0.1.7]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.7
[0.1.6]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.6
[0.1.3]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.3
[0.1.2]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.2
[0.1.1]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.1
[0.1.0]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.1.0
[0.0.9]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.9
[0.0.8]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.8
[0.0.7]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.7
[0.0.6]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.6
[0.0.5]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.5
[0.0.4]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.4
[0.0.3]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.3
[0.0.2]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.2
[0.0.1]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.1
