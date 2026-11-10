# 任务栏小窗：给第二个 WebView2 webview 单独塞启动参数会弄丢条带（2026-11-10）

## 问题现象

dev 上重新开关「任务栏常驻性能显示」后，条带不再出现。重启应用后正常，
**关掉再开一次就又消失**。

现场（`%APPDATA%/OhMyLlama/settings.json` + 顶层窗口枚举）：

- `taskbar_metrics_enabled: true`、勾选项四项齐全——开关命令落盘成功，不是 IPC 权限或写盘失败；
- 小窗窗口被新建出来，但 `IsWindowVisible=false`、尺寸仍是 `INITIAL_LOGICAL` 换算出的
  360×56、位置停在默认 (342,342)，而不是任务栏托盘区左侧；
- 采集器正常：正常态截到 CPU / 内存 / GPU / 显存实时数值，`get_system_metrics` 无异常。

窗口停在「刚创建、前端没上报尺寸」的状态：`taskbar_widget_ready` 没跑起来，
`plan_step` 因 `STATE.size == None` 直接返回，定位线程永远不会 `show()` + 落位。

## 根因

`5ac104b` 为修「开始菜单等系统壳层窗口弹出时条带消失」，在
`taskbar_widget::ensure_window` 的 `WebviewWindowBuilder` 上加了
`.additional_browser_args(BROWSER_ARGS)`（`CalculateNativeWinOcclusion` 等）。
小窗是**进程内第二个 webview**（主窗口是第一个），于是同时踩中两件事：

1. **参数根本没生效。** wry `webview2/mod.rs::create_environment` 对**每个** webview
   都调 `CreateCoreWebView2EnvironmentWithOptions`；同一 user data folder
   （`%LOCALAPPDATA%/com.gdwhisper.oh-my-llama/EBWebView`）只创建一次 environment，
   主窗口先建好且用 wry 默认参数，后续 options 被复用/忽略。实测 WebView2 browser
   进程命令行仍是 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，
   没有 `CalculateNativeWinOcclusion`——遮挡修复是空转。
2. **运行时重建路径被污染。** 关闭开关走 `disable()` 的 `win.destroy()`，再打开要重建
   webview；此时主窗 environment 已稳定，带不同 options 的第二次 environment 创建让
   新 webview 没能完成初始化，窗口壳却在，于是停在隐藏态。启动恢复路径
   （`init_on_startup`，setup 阶段）主窗 environment 尚未稳定反而正常——这正是
   「重启就好、关开一次就坏」的表现来源。

## 修复

回退 `5ac104b`：删掉 `BROWSER_ARGS` 常量、`ensure_window` 里的
`.additional_browser_args(...)`、以及 `browser_args_keep_wry_defaults` 单测。
`npm run check` 全绿，`cargo test --lib` 76 passed / 0 failed。
重新构建后实测：小窗 `IsWindowVisible=true`、落位 (3106,2093)、尺寸 293×62，
关开开关恢复正常。

## 硬性约束（勿重蹈）

- **不要只给第二个 webview 设 `additional_browser_args`。** 要真让参数生效，必须让
  **第一个 webview（主窗口）** 就带上——`src-tauri/tauri.conf.json` 的
  `app.windows[].additionalBrowserArgs`（别名 `additional-browser-args`）——并保证所有
  webview 的参数**完全一致**；否则就得让小窗使用独立的 user data folder，代价是多一套
  WebView2 进程组与数据目录。
- `additional_browser_args` 是**覆盖**语义，不是追加。写它必须复述 wry 默认项
  `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`，否则会丢掉
  迷你菜单 / PDF / SmartScreen 三个关闭项。
- **验证别只看代码**：查 WebView2 browser 进程命令行是否真的带上了目标开关
  （`Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'"` 看 `CommandLine`），
  再枚举顶层窗口确认 `visible` / 位置 / 尺寸。参数没进进程命令行就是没生效。
- 不要靠「再起一个 dev 实例」做本功能的 A/B 对照：多个进程共用同一 EBWebView
  数据目录会互相干扰（实测第二个实例连小窗都建不出来），结论不可信。

## 遗留

「系统壳层窗口弹出时条带消失」仍未修——原修复空转，回退不损失任何已生效行为。
要修就按上面的约束从主窗口统一参数入手并实测；不要在定位线程里用
`hide()/show()` 强制重绘这类症状层补丁绕过。

## 后续（同日）

小窗已改为**原生自绘**（`taskbar_widget.rs` + `taskbar_render.rs`，GDI + `UpdateLayeredWindow`），
不再有第二个 webview，本文描述的 environment 参数复用问题与 `taskbar_widget_ready` 尺寸上报
握手一并消失。保留本文仅作排障记录：若将来又出现「窗口在但不可见」，那是分层窗口的
`UpdateLayeredWindow` 没贴上去，而非 webview 初始化问题。
