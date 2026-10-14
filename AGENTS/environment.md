# 开发机与运行期环境有哪些读代码看不出的约束？

> 父索引：../AGENTS.md

## 开发机：同一时间只能跑一个 dev server

dev 工作树与 main 工作树（`F:\llama_run\tauri-launcher`）共享同一份 `node_modules`，也共享同一个 Vite 端口 6060（`vite.config.ts:17`）。同一时间只能跑一个 dev server；同时跑会互相踩：端口被占导致一方起不来，`npm install` 装的依赖会被另一个工作树的版本覆盖。

启停一律走脚本，不要在第二个终端里直接 `npm run tauri dev` 硬抢：

```powershell
powershell scripts/dev-server.ps1 -Action start|stop|restart   # 三个动作三选一
.\scripts\dev-server.ps1 start                                 # 位置参数写法等价
```

- `-Dir` 可选，默认取脚本所在仓库根；`-Port` 可选，默认 6060。
- `start` 发现端口已被占用会直接报错退出（`scripts/dev-server.ps1:219`），此时用 `restart`，或先 `stop`。
- `restart` 杀整棵进程树——vite、tauri CLI、cargo、app 一起杀（`scripts/dev-server.ps1:131`），不是只杀 vite。
- `stop` 后端口释放但 `oh-my-llama.exe` 仍在跑时，那是已安装的发布版，脚本故意不动它（`scripts/dev-server.ps1:197`），不要手工补刀。

## 开发机：工具链只给指针

环境要求见 `README.md:72`「开发环境」一节：Node 22（Vite 7 不支持 Node 18，与 CI 一致）、Rust stable、Tauri CLI 用项目 devDependency（`npm run tauri`，无需全局 `cargo install tauri-cli`）。本文不复制，只补 README 没有的两条：

- `scripts/gen_app_icons.py` 依赖 PIL（`scripts/gen_app_icons.py:46`），跑前确认 Python 环境装了 Pillow。
- `scripts/gen_structured_params.py` 只用标准库（`scripts/gen_structured_params.py:4`），任何 Python 3 都能跑。

两个脚本都不在 `package.json` 与 CI 里，是纯开发期手工脚本，均在仓库根目录执行。

## 开发机：非 Windows 编译错误只有 CI 能抓

本机 Rust 工具链只装 Windows target，`npm run check` 的 clippy 也只在 Windows 上跑。Linux / macOS 专属问题——平台 API 不存在（如 `WebviewWindow::hwnd()` 仅 Windows 有）、非 Windows 下的 dead_code——本地门禁一律放行，只由 CI 的 `build-check.yml` / `release.yml` 三平台暴露。改到平台相关代码（`cfg` 分支、窗口 API、平台专属常量）时，本机过完 Windows 门禁就推 dev 让 CI 验，别指望本地复现。

本机补验非 Windows 走不通，不要浪费时间：`rustup target add` 的镜像源缺 rust-std 组件（404），即便从官方源手动下载解压进工具链 sysroot，Linux target 也会在 `dbus-sys` 上要系统的 libdbus、macOS target 在 `ring` 上要 `cc`，Windows host 两者皆无，编不到本项目代码就断。

另注意分工：`release.yml` 不跑 clippy `-D warnings`，dead_code 在 release 构建里只是 warning——非 Windows 的死代码能带着发布出去，只有 `build-check.yml` 拦得住（v0.2.9 的 `INITIAL_LOGICAL` 即此情况：release 三平台绿、build-check 红）。

## 运行期数据：`%APPDATA%/OhMyLlama/` 下有什么

目录取 `APPDATA`，缺失时回落 `LOCALAPPDATA`（`src-tauri/src/lib.rs:989`）。三个各管一件事：

| 文件 | 内容 | 排障时看它 |
|---|---|---|
| `configs.toml` | 全部命名配置与当前激活项（`src-tauri/src/lib.rs:996`） | 启动参数不对、配置丢失 |
| `settings.json` | 应用设置（`src-tauri/src/lib.rs:283`） | 设置项不生效、重启后复位 |
| `logs/` | llama-server 运行日志 | 模型加载失败、进程退出、参数不生效 |

- `logs/` 每次成功拉起 llama-server 新建一个 `llama-server_<时间戳>.log`，只保留最新 20 份；「清空日志」只清面板缓冲，不动文件（`src-tauri/src/lib.rs:2130`）。
- `settings.json` 整体读-改-写落盘——见根文件『硬性规则』第 8 条。
- 首次升级时，exe 旁边的旧 `config.toml` / `config/llama-config.toml` 会迁移成一条命名配置（`src-tauri/src/lib.rs:1020`）；平时这两个文件不参与运行。

## 更新通道：签名私钥只在本地

更新走 Tauri v2 `tauri-plugin-updater`：手动检查（设置 → 关于 → 检查更新），端点指向 GitHub Releases 的 `latest.json`。check/download/install 由前端经 JS API 调用，Rust 侧只注册 Builder（`src-tauri/Cargo.toml:24-26`）——不要把更新流程写进 Rust。通道机制全貌见 `.dev_docs/release-guide.md:113` 第六节，本文只约束密钥。

签名私钥 `~/.tauri/oh-my-llama.key` 只存本地，**绝不入库**：

- 私钥入库等于交出更新包签名能力——拿到它的人能签发所有客户端都会接受的假更新。
- 私钥丢失 = 无法再签发更新，已装版本的用户收不到后续升级；本地必须备份（`.dev_docs/release-guide.md:121`）。
- CI 不读仓库里的密钥：私钥全文存 GitHub 仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`，`release.yml` 经环境变量注入 `tauri-action` 由其签名（`.dev_docs/release-guide.md:120`）。
- 公钥在 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`；换公钥必须同步重新签名，否则旧客户端校验失败、更新装不上（`.dev_docs/release-guide.md:119`）。
