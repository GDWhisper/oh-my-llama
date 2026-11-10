# 任务栏小窗改为原生自绘（去掉第二个 WebView2）— 2026-11-10

## 背景

任务栏常驻性能小窗原本是一个独立的 `WebviewWindow`（`widget.html` + `src/widget/`），
内容由 React 渲染、量出尺寸再经 `taskbar_widget_ready` 回报后端定位。它只显示一行数字，
却要常驻一整套 WebView2 进程。实测（本机 3840×2160 / 150% DPI，两个窗口）：

| 进程 | 工作集 | 私有 |
|---|---|---|
| browser | 206.8 MB | 99.6 MB |
| gpu-process（两窗共用） | 139.9 MB | 122.8 MB |
| renderer 主窗口 | 98.6 MB | 52.7 MB |
| **renderer 小窗** | **74.3 MB** | **35.8 MB** |
| utility ×2 | 61.4 MB | 19.2 MB |
| crashpad | 14.9 MB | 4.0 MB |
| 合计 | 595.9 MB | 334.1 MB |

小窗那一份 renderer（任务管理器口径约 36 MB 私有 / 74 MB 工作集）是纯开销。
自绘后这部分进程完全消失。

## 方案取舍

曾评估 **GPUI**（Zed 的 GPU UI 框架）：技术上可行（`tauri-plugin-gpui` 能把 Tauri 窗口
换成 GPUI 渲染，无需 webview），但它作用于**整个窗口**，改不了主窗口里的某块面板；
上游 2026 年已明确减速、crates.io 停在 0.2.2，插件仅 0.1.0（单作者）。为一个 300×40 的
条带引入整套 GPU UI 框架不划算，故选择**裸 Win32 分层窗口 + GDI 自绘**。

也不用 `tauri::Window`：Tauri 2 的无 webview 窗口在 `unstable` feature 后面，且 tao 会在
每次 show/hide 时整段重写 ex-style，旧实现为此每拍纠正 `WS_EX_TOOLWINDOW`，还得把窗口
操作排队到主线程（否则 tao 的 `window_state` 锁与 IPC 线程反向取锁会 AB-BA 死锁）。
裸窗口归自己的线程所有，这两类问题从根上消失。

## 实现

- `src-tauri/src/taskbar_widget.rs`：窗口生命周期、定时器、几何、指标采集、配色。
- `src-tauri/src/taskbar_render.rs`：纯绘制——GDI 文字掩膜 + 预乘 ARGB 合成 +
  `UpdateLayeredWindow`。

线程模型：单线程（`taskbar-widget`）持有窗口与 `Ctx`，`SetTimer` 50ms 驱动：

- 每 50ms：只读 z 序检查（任务栏压上来就立刻重申置顶）。
- 每 1s（收起时 2s）：算尺寸 → `SetWindowPos` 落位 → 贴图，同一拍内完成。
- 每 1.5s（整机 CPU ≥90% 时 5s）：采集指标。
- 空闲时阻塞在 `GetMessage`，不占 CPU。

绘制管线（`taskbar_render::paint`）：

1. 32 位 top-down DIB 作画布，内部一律**预乘 ARGB**。
2. 默认样式：逐像素算圆角矩形覆盖率，写入底色 rgba(10,10,10,0.88)。
3. 文字不能直接用 GDI 画到彩色位图上（GDI 写 32 位 DIB 不维护 alpha，字会整片透明）：
   先画到「黑底白字」掩膜 DIB，取 R 通道当覆盖率，再由 Rust 侧 source-over 合成。
4. **2 倍超采样**（`SUPERSAMPLE`）：文字按 2 倍尺寸光栅化，掩膜取覆盖率后 box 下采样回
   目标尺寸。GDI 的灰度抗锯齿只有十几级灰阶，小字号粗体的斜线/转角会露出阶梯（「狗牙」）；
   2 倍渲染让每个目标像素由 4 个子像素平均，等效灰阶翻两番，1:1 下观感接近 DirectWrite。
   排版必须**同倍率**量（`measure` 全程在超采样坐标下算，最后折回物理尺寸），否则落位会
   差半个像素。
5. 透明样式的晕影：整段文字进掩膜 → 三次 box blur 近似高斯（半径 2/6 两档）→ 叠两层，
   对应原 CSS 的两段 `text-shadow`。
6. `UpdateLayeredWindow` 整窗贴图；贴图前核对客户区尺寸，不一致就放弃本帧。

字体按段选，沿用原 CSS 的字体栈：含 CJK 的标签用 `Microsoft YaHei UI`，数值走等宽，
其余拉丁标签走 `Segoe UI Semibold`。三者在行内**按基线对齐**（不是各自垂直居中），否则
中英文会一行高一行低。

字重分三层（标签 Medium / 主数值 Bold / 明细 400），明细再压一档透明度，让「55%」比
「35.2/63.6G」抢眼。

字体解析有两个坑，都在 `resolve_face` 里处理：

- GDI 没有 `font-family` 链，`CreateFontW` 对不存在的字体名**不报错**，静默回落到系统
  默认字体。候选名必须逐个用 `GetTextFaceW` 读回实际选中的 face 名验证，否则在老系统上
  会悄悄变成 Arial。
- **合成粗体不能要**。可变字体（Cascadia）在 GDI 下只暴露 Regular 实例，请求 700 时 GDI
  会在原字形上硬叠一笔——转角出方块、斜线出阶梯，小字号下就是满屏「狗牙」。判定方法是
  同样请求 400 与 700，看实际选中的面名是否变化（合成不会改面名）；数值字体因此会跳过
  Cascadia 落到 Consolas（它的 Bold 是独立设计的字形）。

标签文案由主窗口经 `set_taskbar_metrics_labels` 按当前语言注入，后端只保留中文兜底。

排版细节（`layout`）：

- 两行排列的轨道宽度**按列各算各的**。跨列共用时中文标签（内存/显存）会把轨道撑到
  两倍全角宽，同列的 CPU/GPU 后面就空出一大截——这是「间距太远」的主因。
- 数值在列内**右对齐**：两行的百分号上下对齐（"44%" 与 "3%" 的 % 落在同一列）。短的
  数值会在标签后留一格空档，这是对齐的必然代价，比「每个数字都贴着自己标签」整齐。
- 明细按第一个 `/` **拆成两段**分别定位：前缀（"35.3"）右对齐到轨道右缘，后缀（"/63.6G"）
  从轨道左缘起排。"35.3/63.6G" 与 "1.0/15.9G" 的斜杠因此落在同一点，两行读起来是一张表。
  实测宽度取「前缀最大宽 + 后缀最大宽」，不是整段最大宽。
- 横向节奏：标签↔百分比 3px、百分比↔明细 6px、项间 10px、内边距 8px（逻辑像素）。

## 踩坑记录

1. **`WS_EX_TOPMOST` 必须建窗即带**：只在落位时 `SetWindowPos(HWND_TOPMOST, …)` 不够。
   Win11 的任务栏宿主（`XamlExplorerHostIslandWindow` / `Shell_TrayWnd`）在置顶带里压着
   普通窗口，条带被任务栏底色整块盖住，而 `IsWindowVisible=1`、`UpdateLayeredWindow`
   返回成功、位图里也确有内容——肉眼就是「什么都没画」。用 z 序链日志才看出来：
   `topmost=false`，上方一串 Chrome/IME 窗口。
2. **不要用 tao 的 `transparent(true)`**：它会置 `WS_EX_NOREDIRECTIONBITMAP`，与分层窗口
   （`UpdateLayeredWindow`）互斥，画面永远不显示。分层与点击穿透分别靠
   `WS_EX_LAYERED` / `WS_EX_TRANSPARENT`，建窗时一次给全。
3. **GDI 不维护 DIB 的 alpha**：见上，必须走掩膜。
4. `UpdateLayeredWindow` 会按传入尺寸反向改窗口大小，所以它和 `SetWindowPos` 的尺寸必须
   严格一致——先落位、再贴图，且在贴图前核对客户区。
5. `Ctx` 用 `Box::into_raw` 泄漏而非随窗口释放：`DestroyWindow` 在 `WM_DESTROY` 里同步回收，
   那一刻调用栈上可能还持有 `&mut Ctx`，释放即悬垂引用。

## 一并删掉的东西

- `widget.html`、`src/widget/`（`TaskbarMetrics.tsx` / `main.tsx` / `widget.css`）。
- `vite.config.ts` 的双入口（`rollupOptions.input.widget`）。
- `src-tauri/capabilities/taskbar-widget.json`（裸窗口没有 webview，不需要 capability）。
- `taskbar_widget_ready` 命令（尺寸改由渲染线程实测）。

## 验证

- 设置：`taskbar_metrics_style` 取 `default` / `transparent`，`layout` 取 `single` / `double`，
  逐一看条带位置、圆角、晕影、对齐。
- 进程：任务管理器里 `oh-my-llama` 只剩主窗口一份 renderer；小窗不再产生 renderer。
- 交互：点击条带区域应穿透到任务栏（`WS_EX_TRANSPARENT`）；Alt-Tab 与任务栏预览里无小窗。
- 几何：自动隐藏任务栏、前台全屏、竖任务栏、DPI 125%/150%/200% 各看一次。

## 回退

`git revert` 本次提交即可（改动集中在 `taskbar_widget.rs` / `taskbar_render.rs` /
`lib.rs` / `App.tsx` / `vite.config.ts` / 删除的前端入口与 capability）。
