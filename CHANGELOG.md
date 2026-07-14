# 更新日志 / Changelog

本项目所有重要变更都记录在此文件。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 本文件为**详细改动历史**（含涉及的文件与实现机制）；GitHub Release 页面为对应版本的**总结性**说明。

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

[0.0.2]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.2
[0.0.1]: https://github.com/GDWhisper/oh-my-llama/releases/tag/v0.0.1
