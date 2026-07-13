# Oh My Llama

让 `llama-server` 的启动与参数管理变得简单：支持**多配置一键切换**、**一键粘贴完整命令行自动解析传参**、**一键分享启动参数**，告别手动拼命令。

## 功能亮点

### 多配置切换
下拉框在多个配置间一键切换，支持新增、重命名（✎）、删除（×，二次确认）与保存。
内置**默认配置**为只读模板，在其基础上修改并保存时会提示「另存为新配置」（名称留空则按日期时间自动生成）。所有保存成功都会弹出绿色「保存成功」提示。

### 一键传参
粘贴 `llama-server` 的完整命令行（如 `F:\llama-turbo\llama-server.exe -m models\xx.gguf --host 127.0.0.1 --port 8080 -ngl 99`），自动：
- 捕获**启动器路径**（exe 及其绝对路径）；
- 将已知参数映射为对应高级参数并自动启用；
- 未知参数以「自定义参数」原样追加，确保与启动时完全一致；
- `-m / --model` 附带推导 `model_dir`，让模型下拉框仍能定位目录。

### 配置分享
一键将当前配置序列化为与后端启动逻辑完全一致的 `llama-server` 命令行（含空格路径自动加引号、`extra_args` 原样追加），复制到剪切板并提示，方便直接分享启动方案。

## 常规功能
顶部服务控制（启动 / 停止 / 打开预览）、必要参数与高级参数编辑（含自定义参数可编辑可删除）、右侧实时日志（自动置底、显示启动命令行、可清空）。

## 配置存储
所有配置持久化在 `%APPDATA%/OhMyLlama/configs.toml`（`%APPDATA%` 通常为 `C:\Users\<用户名>\AppData\Roaming`）。

## 开发
```bash
npm install
npm run tauri dev
```
预览端口统一为 `6060`。验证：前端 `npm run check`，后端 `cargo test --lib --manifest-path src-tauri/Cargo.toml`。

## 技术栈
基于 Tauri 2 构建，前端使用 React + TypeScript，后端使用 Rust。
