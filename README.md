# Oh My Llama

> 让 `llama-server` 的启动与参数管理变得简单。

Oh My Llama 是一个基于 Tauri 2 的桌面工具，帮助你管理 `llama-server` 的启动配置与参数，告别手动拼命令的痛苦。

---

## ✨ 核心亮点

### 多配置切换

支持多配置切换，不用再在笔记本中翻找你那一堆参数配置了——这里统一管理。可新增、重命名、删除与保存。

![配置管理]()

### 一键传参

看累了各种 llama-serve-launcher 自以为是的把所有参数分成独立输入框而头大？这里支持你把所有参数一键粘贴，Oh My Llama 帮你解析——已知参数归位、识别启动器路径，不认识的参数也原样保留为自定义参数。

### 配置分享

Oops，你调出了非常棒的参数，想立刻分享给社区好友，Oh My Llama 碰巧支持你一键复制所有启动参数——这是一个正循环。复制出的命令行与后端启动逻辑完全一致，对方粘过去就能跑。

---

## 🚀 快速开始

### 下载

前往 [GitHub Releases](https://github.com/GDWhisper/oh-my-llama/releases) 下载最新安装包。

---

## 📁 功能详解

### 配置管理

- **选择配置**：从下拉框快速切换已保存的配置
- **新增配置**：从当前配置创建新配置，或创建空白配置
- **重命名**：点击配置旁的 ✎ 图标即可重命名（默认配置不可重命名）
- **删除**：点击 × 图标删除配置，有二次确认（默认配置不可删除）
- **保存配置**：修改参数后点击保存，持久化到本地

### 一键传参

点击「一键传参」按钮，粘贴完整命令行：

```
llama-server.exe -m models/model.gguf --host 127.0.0.1 --port 8080 -c 4096 -ngl 35 -t 8 -b 512 --temp 0.7 --flash-attn on --main-gpu 0 --alias demo
```

系统会自动解析并将参数填入对应字段，未知参数作为自定义参数保留。

### 配置分享

点击「分享参数」按钮，当前配置会被序列化为完整的启动命令行并复制到剪贴板，你可以直接发给社区好友，对方粘贴即可运行。

### 服务控制

顶部控制栏提供：

- **启动 / 停止**：控制 `llama-server` 进程
- **打开预览**：在浏览器中打开模型预览界面
- **状态指示**：实时显示服务运行状态

### 实时日志

右侧日志面板：

- 实时显示 `llama-server` 的 stdout / stderr 输出
- 自动滚动到底部
- 显示启动时的完整命令行
- 支持一键清空日志

### 参数编辑

- **必要参数**：模型文件、模型目录、端口（通过原生文件浏览器选择）
- **高级参数**：上下文大小、GPU 层数、线程数、批量大小、温度、Flash Attention、mmap / mlock
- **自定义参数**：支持任意额外命令行参数，可自由添加、编辑、删除

---

## ⚙️ 配置存储

所有配置持久化在以下位置：

```
%APPDATA%/OhMyLlama/configs.toml
```

其中 `%APPDATA%` 通常为：

```
C:\Users\<用户名>\AppData\Roaming
```

配置文件采用 TOML 格式，包含默认配置和所有命名配置。

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| 框架 | [Tauri 2](https://tauri.app/) |
| 前端 | React 19 + TypeScript + Vite |
| 后端 | Rust |
| 配置格式 | TOML |
| 进程管理 | 原生进程管理（含 Job Object 兜底） |

---

## 🤝 贡献

欢迎以任何方式参与本项目，优先通过 [Issues](https://github.com/GDWhisper/oh-my-llama/issues) 提出需求或反馈问题，也欢迎提交 PR。

### 开发环境

**环境要求：**

- Node.js >= 18
- Rust >= 1.75（通过 [rustup](https://rustup.rs/) 安装）
- Tauri CLI：`cargo install tauri-cli`

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器（前端端口 6060）
npm run tauri dev
```

### 验证与构建

```bash
# 前端类型检查 + lint
npm run check:frontend

# 后端测试
cargo test --lib --manifest-path src-tauri/Cargo.toml

# 全量检查（前端 + 后端）
npm run check

# 构建
npm run tauri build
```

---

## 📄 License

[FSL-1.1-MIT](license.md)