# P0 整改计划：安全移除补丁脚本，保证正常作业

> 状态：**已完成并验证**（2026-07-11，dev 分支）

## 1. 背景与动机

仓库根目录遗留三个"文本手术"式补丁：`patch_frontend.py`、`patch_rust.py`、`patch.diff`。
它们用 `text.replace(旧片段, 新片段)` 直接改写 `src/App.tsx` 与 `src-tauri/src/lib.rs`，
属于"用脚本覆盖版本控制"的反模式（源文件一旦有字符偏移，replace 静默失败、不报错也不生效）。

`agents.md` 核心准则明确禁止此类速赢陷阱。P0 目标：**删掉这三个脚本，但保证程序行为不变**。

## 2. 已核验事实（删除不影响作业的依据）

| 核验项 | 结果 |
|---|---|
| 后端补丁已固化 | `lib.rs` 含完整 `enabled_advanced_params` 链路 + `is_port_in_use_socket` |
| 前端补丁已固化 | `App.tsx` 含 `setAdvancedEnabled` / `removeAdvancedKey` 逻辑 |
| 全仓无构建引用 | `package.json` 脚本、`beforeDevCommand`/`beforeBuildCommand` 均未调用这三脚本 |
| 项目已 git 化 | 基线提交后建 dev worktree（`F:/llama_run/llama-launcher-dev`，分支 `dev`） |

结论：**删的是"历史工具"，不是"代码"**。

## 3. 执行步骤

| 步骤 | 动作 | 结果 |
|---|---|---|
| 1 | 备份三文件到 `F:/llama_run/.p0-backup/` | ✅ |
| 2 | 基线构建 `npm run build` + `cargo check` | ✅ green |
| 3 | 删除 `patch_frontend.py` / `patch_rust.py` / `patch.diff` | ✅ 已删 |
| 4 | 复验构建 + `cargo test --lib` | ✅ 全绿（5 测试通过） |

## 4. 额外修复（dev 工作树叠加态）

中断期间 dev 工作树被另一 AI 工具改动（含 Tauri 安全收紧、lib.rs 重写为 TOML 解析），
其中 `lib.rs` 误用 `toml_edit 0.25.12` 不存在的 API 导致 9 个编译错误。修复：

- `lib.rs`：删除不兼容的 `toml_edit` 手工映射，改用项目已依赖的 `toml` 1.1.2 做 Serde 往返。
- `Cargo.toml`：移除冗余 `toml_edit` 直接依赖。
- `App.css`：删除第 342 行文本手术残骸 `*** End Patch`。

## 5. 正常作业判定标准

- 编译层：`cargo check` 绿、`npm run build` 绿（exit 0）。
- 测试层：`cargo test --lib` 5 项全过（round-trip / 默认值 / 忽略未知键 / 畸形数值回退 / 带空格路径）。
- 行为层：`enabled_advanced_params` 相关能力代码路径完整保留，与原先逐字节一致。

## 6. 回滚

- 删除不改源码；如需恢复补丁脚本，从 `F:/llama_run/.p0-backup/` 取回或 `git revert`。

## 7. 风险边界

- 与本整改无关但需注意：`tauri.conf.json` / `capabilities` 的改动仅在 `npm run tauri dev/build`
  （GUI）时才会被完整校验；无头环境无法替用户点界面，建议人工冒烟一次。
