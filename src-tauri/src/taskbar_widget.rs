//! 任务栏常驻性能小窗（TrafficMonitor 风格，仅 Windows 提供）。
//!
//! 形态：一个无边框 / 分层（逐像素 alpha）/ 置顶 / 点击穿透 / 不抢焦点（WS_EX_NOACTIVATE）
//! 的**原生窗口**，贴在任务栏托盘区左侧（竖任务栏则贴托盘区上方）。条带由 Rust 侧用
//! GDI + `UpdateLayeredWindow` 自绘（见 `taskbar_render`）——不再为它起一个 webview 实例。
//!
//! 为什么自绘：原先小窗是独立 WebView2 窗口（页面 `widget.html`），内容由前端渲染、
//! 量出尺寸再经 `taskbar_widget_ready` 回报后端。代价是常驻一个渲染进程（实测工作集约
//! 74 MB / 私有约 36 MB），而它只显示一行数字。自绘后这部分进程完全消失。
//!
//! 为什么是**裸 Win32 窗口**而不是 `tauri::Window`：Tauri 2 的无 webview 窗口
//! （`WindowBuilder` / `Manager::get_window`）在 `unstable` feature 后面，且 tao 会在每次
//! show/hide 时整段重写 ex-style——旧实现为此在定位线程里每拍纠正 WS_EX_TOOLWINDOW，
//! 还得把全部窗口操作排队到主线程上执行（否则 tao 的 window_state 锁与 IPC 线程反向取锁
//! 会 AB-BA 死锁，2026-10-13 实测整应用 hung）。裸窗口由本模块自己的线程创建并持有，
//! 上述两类问题从根上不存在：没有 tao 记账要同步，也没有跨线程的窗口 API 调用。
//!
//! 关键取舍（都是会踩的坑）：
//! - 窗口必须**先**带 WS_EX_LAYERED 创建，再用 `UpdateLayeredWindow` 贴图；开
//!   WS_EX_NOREDIRECTIONBITMAP（tao 的 `transparent(true)` 就会）与分层窗口互斥，
//!   画面永远不显示。点击穿透靠 WS_EX_TRANSPARENT。
//! - **WS_EX_TOPMOST 必须在建窗时就带上**（2026-11-10 实测踩坑）：只在落位时
//!   `SetWindowPos(HWND_TOPMOST, …)` 不够——Win11 的任务栏宿主
//!   （`XamlExplorerHostIslandWindow` / `Shell_TrayWnd`）在置顶带里压着普通窗口，
//!   条带会被任务栏底色整块盖住，而 `IsWindowVisible` 仍为 1、`UpdateLayeredWindow`
//!   也返回成功，肉眼「什么都没画出来」。同样地，判「被压住」的 `taskbar_above` 在
//!   窗口本身不置顶时也读不出真相：它只在置顶带内比较 z 序。
//! - 窗口线程用 `SetTimer` + 消息循环驱动（空闲时 GetMessage 阻塞，0% CPU），
//!   不用 sleep 轮询：50ms 一拍做「任务栏是否压在条带上」的只读 z 序检查，
//!   1s/2s 一拍做完整核对（落位 / 显隐 / 尺寸），1.5s 一拍采集指标。
//! - 尺寸由本线程按文字实测得出（物理像素），随即 `SetWindowPos` 落位再贴图：同一个
//!   线程内同步完成，不存在「窗口尺寸与位图不一致」的中间态。
//! - 任务栏矩形取自 Shell_TrayWnd、托盘区取其子窗 TrayNotifyWnd；找不到托盘区时退回
//!   任务栏右缘（可能与托盘图标重叠，属兜底）。
//! - 点击任务栏会把 shell 提到置顶带最上层盖住条带（实测 0.3~0.5s，肉眼就是一下闪烁），
//!   故 50ms 检查命中即重申置顶；完整核对里不无脑置顶，免得与托盘弹出面板抢层。
//! - 标签文案（CPU / 内存 / GPU / 显存）由主窗口按当前语言注入
//!   （`set_taskbar_metrics_labels`）：自绘没有 i18n 环境，后端只保留中文兜底。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use tauri::AppHandle;

use crate::{load_settings, resolve_app_data, save_settings_json, AppSettings};

/// 可显示的参数键：顺序即条带内显示顺序（前端复选框与设置持久化共用）。
pub const ITEM_KEYS: [&str; 4] = ["cpu", "mem", "gpu", "vram"];

/// 条带样式键（与设置卡片单选组、前端归一化对齐）：default = 近黑圆角底；
/// transparent = 无底色，文字直接叠在任务栏上（取色由任务栏明暗驱动）。
pub const STYLE_DEFAULT: &str = "default";
pub const STYLE_TRANSPARENT: &str = "transparent";
/// 排列键：single = 单行；double = 两行（仅横任务栏生效；竖任务栏本就逐项成行）。
pub const LAYOUT_SINGLE: &str = "single";
pub const LAYOUT_DOUBLE: &str = "double";

/// 指标轮询间隔（毫秒）：与主面板同频，避免同一个采集器被两处不同节奏地刷新。
#[cfg(windows)]
const INTERVAL_MS: u64 = 1500;
/// 整机 CPU 高负载时放慢轮询（快照自带全局占用，判定零成本）：负载越高压在监控上的
/// CPU 越添乱，5s 一拍仍够看趋势；占用回落后自动回到常速。阈值按显示值口径取 90。
#[cfg(windows)]
const BUSY_PCT: f32 = 90.0;
#[cfg(windows)]
const SLOW_INTERVAL_MS: u64 = 5000;
/// 高占用告警线（显示值达到即染红）：条带只有一格字号，两档分不出主次，一档够传达
/// 「该看一眼」。
#[cfg(windows)]
const HOT_PCT: i32 = 80;
/// 定时器节拍（毫秒）：50ms 做只读 z 序检查，顺手把「该重算了吗」一并判掉。
#[cfg(windows)]
const TICK_MS: u32 = 50;
/// 完整核对节拍（毫秒）：显示中 1s 一拍；收起期间（任务栏自动隐藏 / 前台全屏 /
/// explorer 重启间隙）没人看，降到 2s。
#[cfg(windows)]
const FULL_TICK_MS: u64 = 1000;
#[cfg(windows)]
const HIDDEN_TICK_MS: u64 = 2000;
/// 首帧最多等标签注入这么久（主窗口 webview 未就绪时用中文兜底），避免英文界面闪中文。
#[cfg(windows)]
const LABELS_WAIT_MS: u64 = 2000;
/// 条带与托盘区之间的间隙（逻辑像素，按 DPI 换算为物理像素）。
#[cfg(windows)]
const GAP_LOGICAL: f64 = 6.0;
/// 任务栏与其所在显示器的可见交叠低于该值（物理像素）视为「已自动隐藏」。
#[cfg(any(windows, test))]
const VISIBLE_MIN_PX: i32 = 8;
/// 首帧尺寸（物理像素）：仅建窗用，真实尺寸由文字实测得出。
#[cfg(windows)]
const INITIAL_SIZE: (i32, i32) = (240, 32);

/// 一项的标签文案（按语言注入；默认值见 `Labels::default`）。
#[derive(Clone)]
struct Labels {
    cpu: String,
    mem: String,
    gpu: String,
    vram: String,
}

impl Default for Labels {
    fn default() -> Self {
        // 中文兜底：主窗口 webview 起来后会立刻用当前语言覆盖（见
        // `set_taskbar_metrics_labels`）。刻意不在这里读系统语言——用户可能在应用内
        // 选过与系统不同的语言，读系统反而更常错。
        Self {
            cpu: "CPU".into(),
            mem: "内存".into(),
            gpu: "GPU".into(),
            vram: "显存".into(),
        }
    }
}

/// 小窗当前生效的设置（内存副本；真源仍是 settings.json）。
#[derive(Clone)]
struct WidgetSettings {
    items: Vec<String>,
    style: String,
    layout: String,
    detailed: bool,
}

impl Default for WidgetSettings {
    fn default() -> Self {
        Self {
            items: ITEM_KEYS.iter().map(|k| (*k).to_string()).collect(),
            style: STYLE_DEFAULT.to_string(),
            layout: LAYOUT_SINGLE.to_string(),
            detailed: false,
        }
    }
}

/// 跨线程共享的小窗状态。窗口本身由小窗线程独占（见模块头），这里只放**数据**：
/// IPC 线程写、小窗线程读，全部是短临界区的 Mutex / 原子量。
struct Shared {
    /// 代际号：每次 enable 自增。线程发现自己不再是当代即主动销毁窗口退出，
    /// 保证「关→开」快速连点时旧窗口不会残留。
    generation: AtomicU64,
    /// 窗口句柄（isize）：仅用于让 `disable` 能 `PostMessage(WM_CLOSE)` 唤醒阻塞中的
    /// 消息循环。窗口归小窗线程所有，这里只做只读转发。
    #[cfg(windows)]
    hwnd: Mutex<Option<isize>>,
    /// 请求尽快重算一帧（设置 / 语言变更）。定时器 50ms 内必然看到。
    wake: AtomicBool,
    /// 当前设置 / 标签 / 最近一次指标快照（小窗线程只读）。
    settings: Mutex<WidgetSettings>,
    labels: Mutex<Labels>,
    /// 标签是否已由主窗口注入（未注入时首帧最多等 `LABELS_WAIT_MS`）。
    labels_ready: AtomicBool,
    #[cfg(windows)]
    metrics: Mutex<Option<crate::metrics::MetricsSnapshot>>,
}

static STATE: LazyLock<Shared> = LazyLock::new(|| Shared {
    generation: AtomicU64::new(0),
    #[cfg(windows)]
    hwnd: Mutex::new(None),
    wake: AtomicBool::new(true),
    settings: Mutex::new(WidgetSettings::default()),
    labels: Mutex::new(Labels::default()),
    labels_ready: AtomicBool::new(false),
    #[cfg(windows)]
    metrics: Mutex::new(None),
});

// ── IPC 命令 ───────────────────────────────────────────────────────────

/// 开关 / 勾选项 / 样式 / 排列 / 详细数据落盘并立即生效：开启时确保小窗存在，关闭时
/// 销毁小窗。返回落盘后的全量设置（前端以后端返回值校准，与其它设置命令一致）。
/// 设置面板命令与托盘菜单开关共用同一核心（托盘入口见 [`toggle`]）。
fn apply(
    app: &AppHandle,
    enabled: bool,
    items: Vec<String>,
    style: String,
    layout: String,
    detailed: bool,
) -> Result<AppSettings, String> {
    let items = normalize_items(&items)?;
    // style/layout 宽松归一化（未知值落回默认）：settings.json 可被手改，也可能来自更新版本。
    let style = normalize_style(&style).to_string();
    let layout = normalize_layout(&layout).to_string();
    // 勾选全空 = 无内容可显示，按关闭落盘（前端在勾掉最后一项时会同步关掉开关）。
    let enabled = enabled && !items.is_empty();

    // 先做运行时生效、再落盘：启用失败（建窗失败）不留下「已开启」的设置，
    // 否则下次启动会反复尝试恢复一个起不来的小窗。
    if enabled {
        enable(app)?;
    } else {
        disable(app);
    }

    let app_data = resolve_app_data()?;
    // 读-改-写：只动本命令负责的五个字段（见 lib.rs 的 AppSettings 注释）。
    let mut settings = load_settings(&app_data);
    settings.taskbar_metrics_enabled = enabled;
    settings.taskbar_metrics_items = items;
    settings.taskbar_metrics_style = style;
    settings.taskbar_metrics_layout = layout;
    settings.taskbar_metrics_detailed = detailed;
    save_settings_json(&app_data, &settings)?;
    // 落盘后再更新内存副本：enable() 是从磁盘读的（启动路径的真源），此刻磁盘还是旧值。
    if enabled {
        *STATE.settings.lock().unwrap() = WidgetSettings {
            items: settings.taskbar_metrics_items.clone(),
            style: settings.taskbar_metrics_style.clone(),
            layout: settings.taskbar_metrics_layout.clone(),
            detailed: settings.taskbar_metrics_detailed,
        };
    }
    STATE.wake.store(true, Ordering::Relaxed);
    // 托盘「性能监控」复选对齐：开关有两个入口（设置面板 / 托盘菜单），都经此同步。
    crate::sync_tray_metrics_check();
    // 同时广播给已打开的设置浮窗：托盘改的开关它看不到，不对齐本地 enabled 的话，
    // 随后改样式/排列会把陈旧 enabled 一起写回，把用户刚从托盘关掉的小窗又打开。
    let _ = tauri::Emitter::emit(app, "taskbar-metrics://enabled", enabled);
    Ok(settings)
}

#[tauri::command]
pub async fn set_taskbar_metrics(
    app: AppHandle,
    enabled: bool,
    items: Vec<String>,
    style: String,
    layout: String,
    detailed: bool,
) -> Result<AppSettings, String> {
    let _g = crate::diag::cmd("cmd_set_taskbar_metrics");
    apply(&app, enabled, items, style, layout, detailed)
}

/// 主窗口按当前语言注入条带标签（自绘没有 i18n 环境）。
///
/// 四个标签都在 `src/i18n/messages.ts` 的 `metrics.*` 里，本命令只是把它们搬过进程边界；
/// 后端不维护第二份译文（`Labels::default` 的中文仅为 webview 就绪前的兜底）。
#[tauri::command]
pub fn set_taskbar_metrics_labels(cpu: String, mem: String, gpu: String, vram: String) {
    let _g = crate::diag::cmd("cmd_set_taskbar_metrics_labels");
    // 标签来自自家前端，截断只为防呆：异常长度会把条带撑得过宽。
    let clip = |s: String| -> String { s.chars().take(24).collect() };
    *STATE.labels.lock().unwrap() = Labels {
        cpu: clip(cpu),
        mem: clip(mem),
        gpu: clip(gpu),
        vram: clip(vram),
    };
    STATE.labels_ready.store(true, Ordering::Relaxed);
    STATE.wake.store(true, Ordering::Relaxed);
}

/// 托盘菜单开关：翻转持久化开关态，勾选 / 样式 / 排列 / 详细数据沿用现值。
/// 与设置面板的开关同走 apply（同一真源、同一生效路径）。
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    let _g = crate::diag::cmd("cmd_tray_toggle_metrics");
    let app_data = resolve_app_data()?;
    let settings = load_settings(&app_data);
    let (enabled, items) = next_toggle_state(&settings);
    apply(
        app,
        enabled,
        items,
        settings.taskbar_metrics_style,
        settings.taskbar_metrics_layout,
        settings.taskbar_metrics_detailed,
    )
    .map(|_| ())
}

/// 托盘点击后的目标状态：开关取反；勾选为空（此前被全部取消过）时回落默认全选——
/// 空勾选 = 无内容可显示，直接开会被 apply 按关闭处理，菜单勾选态随之翻回，
/// 用户看到「点了没反应」（设置面板勾掉最后一项后重开同款语义）。
pub(crate) fn next_toggle_state(settings: &AppSettings) -> (bool, Vec<String>) {
    let items = if settings.taskbar_metrics_items.is_empty() {
        crate::default_taskbar_metrics_items()
    } else {
        settings.taskbar_metrics_items.clone()
    };
    (!settings.taskbar_metrics_enabled, items)
}

/// 本平台是否支持任务栏小窗（前端据此决定设置卡片是否渲染）。目前仅 Windows。
#[tauri::command]
pub fn get_taskbar_widget_support() -> bool {
    cfg!(windows)
}

/// 启动恢复：设置里开着且勾选项非空时，随应用启动重建小窗。
pub fn init_on_startup(app: &AppHandle) {
    if !cfg!(windows) {
        return; // 仅 Windows；非 Windows 上即使 settings.json 里是开启的也不建窗
    }
    let Ok(dir) = resolve_app_data() else {
        return;
    };
    let settings = load_settings(&dir);
    if !settings.taskbar_metrics_enabled || settings.taskbar_metrics_items.is_empty() {
        return;
    }
    if let Err(err) = enable(app) {
        // 恢复失败不拦启动：小窗是外围功能，用户可在设置里重开。
        eprintln!("[taskbar-widget] 启动恢复失败: {err}");
    }
}

// ── 开关实现 ───────────────────────────────────────────────────────────

#[cfg(windows)]
fn enable(_app: &AppHandle) -> Result<(), String> {
    // 重复开启（连点开关 / 启动恢复与手动开启重叠）时先停旧线程，保持单例。
    stop_thread();
    // 设置以磁盘为真源读一次（apply 会在落盘后覆盖内存副本）。
    let dir = resolve_app_data()?;
    let settings = load_settings(&dir);
    *STATE.settings.lock().unwrap() = WidgetSettings {
        items: settings.taskbar_metrics_items.clone(),
        style: settings.taskbar_metrics_style.clone(),
        layout: settings.taskbar_metrics_layout.clone(),
        detailed: settings.taskbar_metrics_detailed,
    };
    let generation = STATE.generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn_widget(generation)
}

#[cfg(not(windows))]
fn enable(_app: &AppHandle) -> Result<(), String> {
    Err("任务栏小窗仅支持 Windows。".into())
}

fn disable(_app: &AppHandle) {
    stop_thread();
}

/// 让小窗线程退出：先把代际号推进（线程在下一拍发现自己是旧代即自毁），再向窗口投
/// `WM_CLOSE` 唤醒阻塞在 `GetMessage` 上的消息循环。不 join——线程最多 50ms 内自清。
fn stop_thread() {
    STATE.generation.fetch_add(1, Ordering::SeqCst);
    #[cfg(windows)]
    {
        if let Some(hwnd) = STATE.hwnd.lock().unwrap().take() {
            use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            unsafe { PostMessageW(hwnd as windows_sys::Win32::Foundation::HWND, WM_CLOSE, 0, 0) };
        }
    }
}

// ── 窗口线程（仅 Windows）─────────────────────────────────────────────

/// 小窗线程的私有状态。窗口归本线程独占，故这里不需要任何锁。
#[cfg(windows)]
struct Ctx {
    /// 建窗时的代际号：与 `STATE.generation` 不符即说明已被 disable / 重建。
    generation: u64,
    started: std::time::Instant,
    next_full: std::time::Instant,
    next_poll: std::time::Instant,
    /// 上次落位的 (x, y, w, h)（物理像素）：几何没变就不重复 SetWindowPos。
    placed: Option<(i32, i32, u32, u32)>,
    shown: bool,
}

#[cfg(windows)]
impl Ctx {
    /// 完整核对：算尺寸 → 落位 → 显隐 → 贴图。全部在本线程内同步完成。
    fn full_tick(&mut self, hwnd: windows_sys::Win32::Foundation::HWND) {
        let Some(geo) = geometry() else {
            self.hide(hwnd);
            return;
        };
        if geo.suppressed {
            self.hide(hwnd);
            return;
        }
        // 首帧等一次标签注入：主窗口 webview 就绪通常只要几百毫秒，等不到就用兜底。
        if !STATE.labels_ready.load(Ordering::Relaxed)
            && self.started.elapsed() < std::time::Duration::from_millis(LABELS_WAIT_MS)
        {
            return;
        }

        let dpi = dpi_of(hwnd);
        let settings = STATE.settings.lock().unwrap().clone();
        let labels = STATE.labels.lock().unwrap().clone();
        let snap = STATE.metrics.lock().unwrap().clone();
        let items: Vec<_> = settings
            .items
            .iter()
            .filter_map(|key| build_item(key, &labels, snap.as_ref(), settings.detailed))
            .collect();
        if items.is_empty() {
            self.hide(hwnd);
            return;
        }
        let style = crate::taskbar_render::StripStyle {
            transparent: settings.style == STYLE_TRANSPARENT,
            // 读不到明暗时按深色处理（与原前端 prefers-color-scheme 的兜底一致）。
            light: taskbar_is_light().unwrap_or(false),
            vertical: geo.vertical,
            double: settings.layout == LAYOUT_DOUBLE,
        };
        let Some(frame) = crate::taskbar_render::measure(&items, &style, dpi as f32) else {
            return;
        };
        let place = compute_placement(&geo, frame.w, frame.h, dpi);
        let key = (place.x, place.y, place.w_px, place.h_px);
        if self.placed != Some(key) || !self.shown {
            let _w = crate::diag::cmd("widget_place");
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
            };
            unsafe {
                SetWindowPos(
                    hwnd,
                    HWND_TOPMOST,
                    place.x,
                    place.y,
                    place.w_px as i32,
                    place.h_px as i32,
                    SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
            self.placed = Some(key);
            self.shown = true;
        }
        // 落位与贴图在同一拍内完成：客户区尺寸此刻必然等于位图尺寸（SetWindowPos 同步生效）。
        let _w = crate::diag::cmd("widget_paint");
        let _ = crate::taskbar_render::paint(hwnd, &frame);
    }

    fn hide(&mut self, hwnd: windows_sys::Win32::Foundation::HWND) {
        if !self.shown {
            return;
        }
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        unsafe { ShowWindow(hwnd, SW_HIDE) };
        self.shown = false;
        self.placed = None;
    }

    /// 采集一拍指标，并按整机占用决定下一拍间隔。
    fn poll(&mut self) {
        let _g = crate::diag::cmd("widget_metrics_poll");
        let snap = crate::metrics::get_system_metrics();
        let interval = if snap.cpu_usage >= BUSY_PCT {
            SLOW_INTERVAL_MS
        } else {
            INTERVAL_MS
        };
        *STATE.metrics.lock().unwrap() = Some(snap);
        self.next_poll = std::time::Instant::now() + std::time::Duration::from_millis(interval);
    }
}

/// 建窗并进入消息循环；建窗结果经 channel 回传给 `enable`，失败要让设置不落成「已开启」。
#[cfg(windows)]
fn spawn_widget(generation: u64) -> Result<(), String> {
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("taskbar-widget".into())
        .spawn(move || match create_window(generation) {
            Ok(hwnd) => {
                let _ = tx.send(Ok(()));
                message_loop(hwnd);
            }
            Err(err) => {
                let _ = tx.send(Err(err));
            }
        })
        .map_err(|err| format!("启动任务栏小窗线程失败: {err}"))?;
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "任务栏小窗创建超时。".to_string())?
}

/// 注册窗口类并建窗。
///
/// `Ctx` 用 `Box::into_raw` 泄漏而非随窗口释放：`DestroyWindow` 会在 `WM_DESTROY` 里
/// 同步回收，而那一刻调用栈上可能还持有 `&mut Ctx`（`full_tick` 里触发的重建路径），
/// 释放即悬垂引用。小窗一生只会建个位数次，每份百来字节，泄漏是这里最省事也最安全的选择。
#[cfg(windows)]
fn create_window(generation: u64) -> Result<windows_sys::Win32::Foundation::HWND, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, RegisterClassW, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
    };

    let class: Vec<u16> = "OhMyLlamaTaskbarWidget\0".encode_utf16().collect();
    let title: Vec<u16> = "Oh My Llama\0".encode_utf16().collect();
    let ctx = Box::into_raw(Box::new(Ctx {
        generation,
        started: std::time::Instant::now(),
        next_full: std::time::Instant::now(),
        next_poll: std::time::Instant::now(),
        placed: None,
        shown: false,
    }));

    unsafe {
        let hinstance = GetModuleHandleW(ptr::null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: ptr::null_mut(),
            hCursor: ptr::null_mut(),
            hbrBackground: ptr::null_mut(),
            lpszMenuName: ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        // 类已注册（同进程内重建小窗）不算错误：ERROR_CLASS_ALREADY_EXISTS = 1410。
        if RegisterClassW(&wc) == 0 && GetLastError() != 1410 {
            return Err("注册任务栏小窗窗口类失败。".into());
        }
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            0,
            0,
            INITIAL_SIZE.0,
            INITIAL_SIZE.1,
            ptr::null_mut(),
            ptr::null_mut(),
            hinstance,
            ctx as *const std::ffi::c_void,
        );
        if hwnd.is_null() {
            return Err("创建任务栏小窗失败。".into());
        }
        *STATE.hwnd.lock().unwrap() = Some(hwnd as isize);
        Ok(hwnd)
    }
}

#[cfg(windows)]
fn message_loop(hwnd: windows_sys::Win32::Foundation::HWND) {
    use std::ptr;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetTimer, TranslateMessage, MSG,
    };

    // 定时器驱动一切：空闲时 GetMessage 阻塞，不占 CPU。
    let timer = unsafe { SetTimer(hwnd, 1, TICK_MS, None) };
    if timer == 0 {
        eprintln!("[taskbar-widget] SetTimer 失败，小窗将不再刷新");
    }
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    loop {
        let ret = unsafe { GetMessageW(&mut msg, ptr::null_mut(), 0, 0) };
        if ret <= 0 {
            break; // 0 = WM_QUIT，-1 = 错误
        }
        unsafe {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    // 只清自己那一份：旧线程可能比新线程晚收尾，无条件清空会把新窗口的句柄抹掉，
    // 之后 disable 就发不出 WM_CLOSE（虽仍靠代际号兜底，但会多挂 50ms）。
    let mut slot = STATE.hwnd.lock().unwrap();
    if *slot == Some(hwnd as isize) {
        *slot = None;
    }
}

/// 窗口过程：只处理定时器、DPI 变化与关闭；其余交给 `DefWindowProcW`。
#[cfg(windows)]
unsafe extern "system" fn wndproc(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, DestroyWindow, GetWindowLongPtrW, PostQuitMessage, SetWindowLongPtrW,
        CREATESTRUCTW, GWLP_USERDATA, WM_CLOSE, WM_DESTROY, WM_DPICHANGED, WM_NCCREATE, WM_TIMER,
    };

    // 建窗时把 Ctx 指针存进 GWLP_USERDATA（此后每拍从那里取回）。
    if msg == WM_NCCREATE {
        let create = &*(lparam as *const CREATESTRUCTW);
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        return DefWindowProcW(hwnd, msg, wparam, lparam);
    }

    let ctx = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Ctx;
    match msg {
        WM_TIMER if ctx.is_null() => 0,
        WM_TIMER => {
            let ctx = &mut *ctx;
            // 旧代际（disable 后又重开）：自毁，避免两个条带叠着画。
            if STATE.generation.load(Ordering::SeqCst) != ctx.generation {
                DestroyWindow(hwnd);
                return 0;
            }
            let now = std::time::Instant::now();
            if STATE.wake.swap(false, Ordering::Relaxed) {
                ctx.next_full = now;
                ctx.next_poll = now;
            }
            if now >= ctx.next_full {
                ctx.full_tick(hwnd);
                let interval = if ctx.shown {
                    FULL_TICK_MS
                } else {
                    HIDDEN_TICK_MS
                };
                ctx.next_full =
                    std::time::Instant::now() + std::time::Duration::from_millis(interval);
            } else if ctx.shown && taskbar_above(hwnd) {
                // 被任务栏压住（点击 shell 后的 0.3~0.5s）：立刻顶回，不等下一完整拍。
                reassert_topmost(hwnd);
            }
            if ctx.shown && std::time::Instant::now() >= ctx.next_poll {
                ctx.poll();
                // 采集到新值：下一拍（≤50ms）重画，不必等 1s 的完整核对。
                ctx.next_full = std::time::Instant::now();
            }
            0
        }
        // DPI 变化（拖到别的显示器 / 改缩放）：尺寸与字号都要重算。
        WM_DPICHANGED => {
            STATE.wake.store(true, Ordering::Relaxed);
            0
        }
        WM_CLOSE => {
            DestroyWindow(hwnd);
            0
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// 条带当前所处显示器的 DPI 比例（1.0 = 96 DPI）。
#[cfg(windows)]
fn dpi_of(hwnd: windows_sys::Win32::Foundation::HWND) -> f64 {
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 {
        1.0
    } else {
        f64::from(dpi) / 96.0
    }
}

/// 标准百分比文本：0-100 取整 + 触线判定；缺值显示占位符，不让条带出现 NaN。
#[cfg(windows)]
fn pct_text(value: Option<f32>) -> (String, bool) {
    match value {
        Some(v) if v.is_finite() => {
            let rounded = f64::from(v).clamp(0.0, 100.0).round() as i32;
            (format!("{rounded}%"), rounded >= HOT_PCT)
        }
        _ => ("—".to_string(), false),
    }
}

/// 紧凑容量对（GB 一位小数，单位只写一次）：如 22.1/31.9G——条带横向空间有限。
#[cfg(windows)]
fn gb_pair(used_mb: u64, total_mb: u64) -> Option<String> {
    (total_mb > 0).then(|| {
        format!(
            "{:.1}/{:.1}G",
            used_mb as f64 / 1024.0,
            total_mb as f64 / 1024.0
        )
    })
}

/// 按当前设置与快照拼出一项（与主面板同口径：多卡取第一张）。
#[cfg(windows)]
fn build_item(
    key: &str,
    labels: &Labels,
    snap: Option<&crate::metrics::MetricsSnapshot>,
    detailed: bool,
) -> Option<crate::taskbar_render::Item> {
    use crate::taskbar_render::Item;
    let gpu = snap.and_then(|s| s.gpus.first());
    let (label, (value, hot), extra) = match key {
        "cpu" => (
            labels.cpu.as_str(),
            pct_text(snap.map(|s| s.cpu_usage)),
            None,
        ),
        "mem" => (
            labels.mem.as_str(),
            pct_text(snap.map(|s| s.mem_usage)),
            detailed
                .then(|| snap.and_then(|s| gb_pair(s.mem_used_mb, s.mem_total_mb)))
                .flatten(),
        ),
        "gpu" => (labels.gpu.as_str(), pct_text(gpu.map(|g| g.usage)), None),
        "vram" => {
            let pct = gpu.and_then(|g| {
                (g.vram_total_mb > 0)
                    .then(|| (g.vram_used_mb as f32 / g.vram_total_mb as f32) * 100.0)
            });
            (
                labels.vram.as_str(),
                pct_text(pct),
                detailed
                    .then(|| gpu.and_then(|g| gb_pair(g.vram_used_mb, g.vram_total_mb)))
                    .flatten(),
            )
        }
        _ => return None,
    };
    Some(Item {
        label: label.to_string(),
        value,
        extra,
        hot,
    })
}

// ── 校验与归一化 ───────────────────────────────────────────────────────

/// 校验并归一化勾选项：未知键报错（IPC 边界），顺序固定为 ITEM_KEYS（与显示顺序一致）。
fn normalize_items(items: &[String]) -> Result<Vec<String>, String> {
    for item in items {
        if !ITEM_KEYS.contains(&item.as_str()) {
            return Err(format!("未知的显示参数: {item}"));
        }
    }
    Ok(ITEM_KEYS
        .iter()
        .filter(|key| items.iter().any(|item| item == *key))
        .map(|key| (*key).to_string())
        .collect())
}

/// 样式归一化：未知值落回默认样式（宽松——settings.json 可被手改，也可能来自更新版本）。
fn normalize_style(style: &str) -> &'static str {
    if style == STYLE_TRANSPARENT {
        STYLE_TRANSPARENT
    } else {
        STYLE_DEFAULT
    }
}

/// 排列归一化：未知值落回单行。
fn normalize_layout(layout: &str) -> &'static str {
    if layout == LAYOUT_DOUBLE {
        LAYOUT_DOUBLE
    } else {
        LAYOUT_SINGLE
    }
}

// ── 几何（纯函数；Win32 调用在下方 cfg(windows) 块）───────────────────

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[cfg(any(windows, test))]
impl Rect {
    fn width(&self) -> i32 {
        self.right - self.left
    }

    fn height(&self) -> i32 {
        self.bottom - self.top
    }

    fn intersects(&self, other: &Rect) -> Rect {
        Rect {
            left: self.left.max(other.left),
            top: self.top.max(other.top),
            right: self.right.min(other.right),
            bottom: self.bottom.min(other.bottom),
        }
    }
}

/// 竖任务栏（宽 ≤ 高）判定；横任务栏的条带横排，竖任务栏的条带逐项成行。
#[cfg(any(windows, test))]
fn is_vertical(bar: &Rect) -> bool {
    bar.height() > bar.width()
}

/// 任务栏是否正在显示：自动隐藏时它被移到屏幕外，只留一两个像素在屏内。
#[cfg(any(windows, test))]
fn taskbar_shown(bar: &Rect, monitor: &Rect) -> bool {
    let ix = bar.intersects(monitor);
    let visible = if is_vertical(bar) {
        ix.width()
    } else {
        ix.height()
    };
    visible >= VISIBLE_MIN_PX
}

/// 小窗左上角（物理像素）：横任务栏贴托盘区左侧、垂直居中；竖任务栏贴托盘区上沿、水平居中。
/// 托盘区缺失时退回任务栏右 / 下缘；位置统一钳在任务栏内，避免算出屏外坐标。
#[cfg(any(windows, test))]
fn compute_position(bar: &Rect, tray: Option<&Rect>, w: i32, h: i32, gap: i32) -> (i32, i32) {
    if is_vertical(bar) {
        let y = tray
            .map(|t| t.top - h - gap)
            .unwrap_or(bar.bottom - h - gap);
        let x = bar.left + (bar.width() - w) / 2;
        (x, y.max(bar.top))
    } else {
        let x = tray
            .map(|t| t.left - w - gap)
            .unwrap_or(bar.right - w - gap);
        let x = x.max(bar.left);
        let y = bar.top + (bar.height() - h) / 2;
        (x, y)
    }
}

/// 前台窗口是否整屏盖住其所在显示器（全屏视频 / 游戏时收起条带）。
/// 桌面窗口（Progman / WorkerW）不算——点桌面时它也铺满全屏，但任务栏仍可见。
#[cfg(any(windows, test))]
fn covers_monitor(fg: &Rect, monitor: &Rect, fg_class: &str) -> bool {
    if matches!(fg_class, "Progman" | "WorkerW") {
        return false;
    }
    fg.left <= monitor.left
        && fg.top <= monitor.top
        && fg.right >= monitor.right
        && fg.bottom >= monitor.bottom
}

// ── Win32 采集与定位（仅 Windows）──────────────────────────────────────

#[cfg(windows)]
struct Placement {
    x: i32,
    y: i32,
    w_px: u32,
    h_px: u32,
}

/// 条带在任务栏上的落位：尺寸由文字实测给出（物理像素），这里只换算间隙与坐标。
#[cfg(windows)]
fn compute_placement(geo: &Geometry, w_px: u32, h_px: u32, dpi: f64) -> Placement {
    let gap = (GAP_LOGICAL * dpi).round() as i32;
    let (x, y) = compute_position(&geo.bar, geo.tray.as_ref(), w_px as i32, h_px as i32, gap);
    Placement { x, y, w_px, h_px }
}

#[cfg(windows)]
struct Geometry {
    bar: Rect,
    tray: Option<Rect>,
    /// 任务栏之外是否还有别的理由不显示：自动隐藏或前台全屏。
    suppressed: bool,
    vertical: bool,
}

#[cfg(windows)]
fn geometry() -> Option<Geometry> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowExW, FindWindowW};

    unsafe {
        // Shell_TrayWnd = 主任务栏窗口；找不到（explorer 重启间隙）即视为不可用。
        let bar_hwnd = FindWindowW(windows_sys::w!("Shell_TrayWnd"), std::ptr::null());
        if bar_hwnd.is_null() {
            return None;
        }
        let bar = window_rect(bar_hwnd)?;
        let monitor = monitor_rect(bar_hwnd)?;
        let tray = {
            let hwnd = FindWindowExW(
                bar_hwnd,
                std::ptr::null_mut(),
                windows_sys::w!("TrayNotifyWnd"),
                std::ptr::null(),
            );
            if hwnd.is_null() {
                None
            } else {
                window_rect(hwnd)
            }
        };
        let suppressed = !taskbar_shown(&bar, &monitor) || foreground_fullscreen();
        Some(Geometry {
            tray,
            suppressed,
            vertical: is_vertical(&bar),
            bar,
        })
    }
}

#[cfg(windows)]
fn window_rect(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<Rect> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowRect;

    let mut rect: RECT = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetWindowRect(hwnd, &mut rect) };
    (ok != 0).then_some(Rect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    })
}

#[cfg(windows)]
fn monitor_rect(hwnd: windows_sys::Win32::Foundation::HWND) -> Option<Rect> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    unsafe {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let r = info.rcMonitor;
        Some(Rect {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        })
    }
}

#[cfg(windows)]
fn foreground_fullscreen() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetForegroundWindow};

    unsafe {
        let fg = GetForegroundWindow();
        if fg.is_null() {
            return false;
        }
        let Some(rect) = window_rect(fg) else {
            return false;
        };
        let Some(monitor) = monitor_rect(fg) else {
            return false;
        };
        let mut buf = [0u16; 64];
        let len = GetClassNameW(fg, buf.as_mut_ptr(), buf.len() as i32);
        let class = String::from_utf16_lossy(&buf[..len.max(0) as usize]);
        covers_monitor(&rect, &monitor, &class)
    }
}

/// 任务栏当前是否浅色：读 HKCU 的 `SystemUsesLightTheme`。任务栏与开始菜单等系统壳层
/// 跟随的是「Windows 模式」这个键，而**不是**应用的 `AppsUseLightTheme`——两者被分开
/// 设置过时必须取前者，否则透明样式的文字色会选反（白字贴浅色任务栏）。
/// None = 读不到（键/值缺失或类型不对），由调用方按深色兜底。
#[cfg(windows)]
fn taskbar_is_light() -> Option<bool> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
        REG_DWORD,
    };

    let sub_key: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let name: Vec<u16> = "SystemUsesLightTheme"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: 两个缓冲均为 NUL 结尾的 UTF-16 且存活至调用结束；key 仅在成功时被写入。
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            sub_key.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut key,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let mut kind = 0u32;
    let mut data = 0u32;
    let mut bytes = std::mem::size_of::<u32>() as u32;
    // SAFETY: key 有效；name 为 NUL 结尾 UTF-16；data/bytes 如实给出缓冲容量。
    let rc = unsafe {
        RegQueryValueExW(
            key,
            name.as_ptr(),
            std::ptr::null(),
            &mut kind,
            &mut data as *mut u32 as *mut u8,
            &mut bytes,
        )
    };
    // SAFETY: key 来自成功的 RegOpenKeyExW，此处释放一次。
    unsafe { RegCloseKey(key) };
    (rc == ERROR_SUCCESS && kind == REG_DWORD && bytes == 4).then_some(data != 0)
}

/// 任务栏是否压在条带之上：从本窗口沿 z 序向上最多找 32 个窗口，命中任务栏即算
/// 「被压住」。托盘弹出面板（Wi-Fi/音量等）弹出时面板自身是直接上层、任务栏不在
/// 近处，故不命中、不抢层。
#[cfg(windows)]
fn taskbar_above(our: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindow, GW_HWNDPREV};

    unsafe {
        let bar = FindWindowW(windows_sys::w!("Shell_TrayWnd"), std::ptr::null_mut());
        if bar.is_null() || bar == our {
            return false;
        }
        let mut cur = our;
        for _ in 0..32 {
            let prev = GetWindow(cur, GW_HWNDPREV);
            if prev.is_null() {
                return false; // 已到顶：任务栏不在上方
            }
            if prev == bar {
                return true;
            }
            cur = prev;
        }
        false
    }
}

/// 条带被任务栏压住时重申置顶（点击任务栏会把 shell 提到置顶带最上层）。
#[cfg(windows)]
fn reassert_topmost(our: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    unsafe {
        SetWindowPos(
            our,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

// ── 单元测试（纯几何 / 归一化，全部可跨平台跑）─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(l: i32, t: i32, r: i32, b: i32) -> Rect {
        Rect {
            left: l,
            top: t,
            right: r,
            bottom: b,
        }
    }

    /// 1920×1080、任务栏在下（高 40）、托盘区靠右（左缘 1600）：条带贴托盘区左侧、垂直居中。
    #[test]
    fn bottom_bar_places_left_of_tray() {
        let bar = rect(0, 1040, 1920, 1080);
        let tray = rect(1600, 1040, 1912, 1080);
        let (x, y) = compute_position(&bar, Some(&tray), 300, 24, 6);
        assert_eq!(x, 1600 - 300 - 6);
        assert_eq!(y, 1040 + (40 - 24) / 2);
    }

    /// 任务栏在顶：垂直居中逻辑相同。
    #[test]
    fn top_bar_centers_vertically() {
        let bar = rect(0, 0, 1920, 40);
        let tray = rect(1600, 0, 1912, 40);
        let (x, y) = compute_position(&bar, Some(&tray), 300, 24, 6);
        assert_eq!(x, 1294);
        assert_eq!(y, 8);
    }

    /// 托盘区缺失（TrayNotifyWnd 找不到）：退回任务栏右缘。
    #[test]
    fn missing_tray_falls_back_to_bar_edge() {
        let bar = rect(0, 1040, 1920, 1080);
        let (x, _) = compute_position(&bar, None, 300, 24, 6);
        assert_eq!(x, 1920 - 300 - 6);
    }

    /// 条带比托盘区左侧空间还宽：钳到任务栏左缘，不出屏。
    #[test]
    fn clamps_to_bar_left() {
        let bar = rect(0, 1040, 1920, 1080);
        let tray = rect(100, 1040, 1912, 1080);
        let (x, _) = compute_position(&bar, Some(&tray), 300, 24, 6);
        assert_eq!(x, 0);
    }

    /// 竖任务栏（左侧）：条带贴托盘区上沿、水平居中。
    #[test]
    fn vertical_bar_places_above_tray() {
        let bar = rect(0, 0, 60, 1080);
        let tray = rect(0, 1000, 60, 1080);
        let (x, y) = compute_position(&bar, Some(&tray), 48, 64, 6);
        assert_eq!(x, 6);
        assert_eq!(y, 1000 - 64 - 6);
    }

    /// 自动隐藏：任务栏滑出屏幕只剩 2px 可见 → 视为未显示。
    #[test]
    fn auto_hidden_bar_detected() {
        let monitor = rect(0, 0, 1920, 1080);
        assert!(!taskbar_shown(&rect(0, 1078, 1920, 1080), &monitor));
        assert!(taskbar_shown(&rect(0, 1040, 1920, 1080), &monitor));
        // 竖任务栏滑出只剩 2px 宽
        assert!(!taskbar_shown(&rect(58, 0, 60, 1080), &monitor));
        assert!(taskbar_shown(&rect(0, 0, 60, 1080), &monitor));
    }

    /// 全屏判定：铺满整个显示器才算；桌面窗口（Progman/WorkerW）与普通窗口都不算。
    #[test]
    fn fullscreen_detection_excludes_desktop() {
        let monitor = rect(0, 0, 1920, 1080);
        assert!(covers_monitor(
            &rect(0, 0, 1920, 1080),
            &monitor,
            "Chrome_WidgetWin_1"
        ));
        assert!(!covers_monitor(
            &rect(0, 0, 1920, 1080),
            &monitor,
            "WorkerW"
        ));
        assert!(!covers_monitor(
            &rect(0, 0, 1920, 1080),
            &monitor,
            "Progman"
        ));
        assert!(!covers_monitor(
            &rect(0, 0, 1920, 1000),
            &monitor,
            "Notepad"
        ));
    }

    /// 勾选项归一化：未知键报错；已知键按 ITEM_KEYS 顺序去重归位。
    #[test]
    fn normalize_items_validates_and_orders() {
        assert!(normalize_items(&["bogus".to_string()]).is_err());
        let got =
            normalize_items(&["vram".to_string(), "cpu".to_string(), "cpu".to_string()]).unwrap();
        assert_eq!(got, vec!["cpu".to_string(), "vram".to_string()]);
        assert!(normalize_items(&[]).unwrap().is_empty());
    }

    /// 样式 / 排列归一化：已知值原样返回；未知值（手改的 settings.json / 更新版本遗留）落回默认。
    #[test]
    fn normalize_style_and_layout_fall_back() {
        assert_eq!(normalize_style(STYLE_TRANSPARENT), STYLE_TRANSPARENT);
        assert_eq!(normalize_style(STYLE_DEFAULT), STYLE_DEFAULT);
        assert_eq!(normalize_style("hologram"), STYLE_DEFAULT);
        assert_eq!(normalize_style(""), STYLE_DEFAULT);
        assert_eq!(normalize_layout(LAYOUT_DOUBLE), LAYOUT_DOUBLE);
        assert_eq!(normalize_layout(LAYOUT_SINGLE), LAYOUT_SINGLE);
        assert_eq!(normalize_layout("triple"), LAYOUT_SINGLE);
        assert_eq!(normalize_layout(""), LAYOUT_SINGLE);
    }
}
