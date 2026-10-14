# 要改 IPC 命令 / 配置字段 / 高级参数 / 设置字段 / 文案，或发布版本时，按什么顺序动哪些文件？

> 父索引：../AGENTS.md

## 任务 → 动哪里

| 任务 | 文件顺序 |
|---|---|
| 新增 IPC 命令 | ① `src-tauri/src/lib.rs` 加 `#[tauri::command]` 并注册进 `generate_handler!` → ② 同步 `src/types.ts` → ③ 自定义 app 命令默认可用；仅插件命令需在 `src-tauri/capabilities/default.json` 显式授权 |
| 新增配置字段 | ① `src-tauri/src/lib.rs` 的 `ServerConfig` 加字段、`default()` 给默认值（唯一真源）→ ② 同步 `src/types.ts` → ③ 前端使用 |
| 新增/修改高级参数 | ① 改 `scripts/gen_structured_params.py` 的 PARAMS 表 → ② 仓库根目录执行 `python scripts/gen_structured_params.py` → ③ 输出 i18n skip 时，手动在 `src/i18n/messages.ts` zh/en 补 `advanced.structured.<key>` |
| 新增 AppSettings 字段 | ① `src-tauri/src/lib.rs` 的 `AppSettings` 加字段 + `#[serde(default)]`，非平凡缺省同步改手写 `impl Default for AppSettings`（derive 会与 serde 缺省不一致，两处缺省必须同源）→ ② 同步 `src/types.ts` → ③ `src/components/SettingsDialog.tsx` 加控件 + `src/i18n/messages.ts` zh/en 补 `settings.*` 键 → ④ 写侧扩展该字段的写命令（写命令按字段分设，如 `save_settings` 签名只收 `update_proxy` 与 `auto_check_updates`），仍先 `load_settings` 取全量再落盘 |
| 新增用户可见文案 | ① `src/i18n/messages.ts` zh/en 同时加键 → ② 组件用 `t()` |
| 发布版本 | ① 读 `.dev_docs/release-guide.md` 全流程 → ② Release Note 复制 `.dev_docs/release-note-template.md` 模板填写，不得另起炉灶 → ③ 版本号只改 `src-tauri/tauri.conf.json` 的 `"version"`（根文件硬性规则 2） |

## 每类改动必须同步的东西

- IPC 命令：`src/types.ts` 是 IPC 类型契约，必须与 Rust 命令签名保持一致；漏同步只在编译期暴露。
- 配置字段：默认值唯一真源在后端、前端经 `get_default_config` 取，见根文件硬性规则 1「默认值唯一真源在后端」。
- 高级参数：初值在生成脚本 `DEFAULTS` 表、只改脚本不改 `params.rs`，见根文件硬性规则 1 末句与硬性规则 6。
- AppSettings 字段：整体读-改-写、`#[serde(default)]` 兼容旧文件，见根文件硬性规则 8。
- 用户可见文案：zh/en 同时加键、en 缺键编译报错，见根文件硬性规则 7。

## capabilities 现状

全仓库仅 `src-tauri/capabilities/` 一处；读时以该目录实际内容为准。

- `default.json`：对主窗口授权 `core:default`、`opener:default`、`dialog:default`、`updater:default`，以及 6 个 `core:window` 动作（minimize / toggle-maximize / maximize / unmaximize / close / start-dragging）。
- `taskbar-widget.json`：只对运行时创建的 `taskbar-metrics` 窗口（窗口标签定义在 `src-tauri/src/taskbar_widget.rs`）授权 `core:event:default`。
- 两份均无 shell、fs、http、process 类权限。新增 capability 后更新本节。

## params.rs 两个陷阱

- `src-tauri/src/params.rs` 文件头「在此表加一行」是生成器模板原话，勿信：手改 `params.rs` 会被下次重跑静默覆盖。唯一入口是改 `scripts/gen_structured_params.py` 的 PARAMS 表后重新生成。
- 脚本仅在 `src/i18n/messages.ts` 尚无任何 `advanced.structured.` 键时才自动插入 i18n；已有则打印 skip。新增参数必须手动在 zh/en 同时补 `advanced.structured.<key>`。

## 收尾 checklist

- [ ] `npm run check`（tsc + eslint + prettier + CSS 选择器检查 + cargo fmt --check + clippy -D warnings）
- [ ] 动了 Rust 逻辑：`cargo test --lib --manifest-path src-tauri/Cargo.toml`
- [ ] 按名过滤单条用例：`cargo test --lib --manifest-path src-tauri/Cargo.toml build_server_args`
