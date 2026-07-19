# 更新日志 / Changelog

本项目所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件为**详细改动历史**（含涉及的文件与实现机制）；GitHub Release 页面为对应版本的**总结性**说明。

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

[0.0.9]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.9
[0.0.8]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.8
[0.0.7]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.7
[0.0.6]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.6
[0.0.5]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.5
[0.0.4]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.4
[0.0.3]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.3
[0.0.2]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.2
[0.0.1]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.1
