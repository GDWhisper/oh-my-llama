//! 任务栏常驻性能小窗（TrafficMonitor 风格，仅 Windows 提供）。
//!
//! 形态：一个无边框 / 透明 / 置顶 / 点击穿透 / 不抢焦点（WS_EX_NOACTIVATE）的
//! WebView2 条带窗，贴在任务栏托盘区左侧（竖任务栏则贴托盘区上方）。条带内容与
//! 尺寸由前端页面（`widget.html`）渲染并经 `taskbar_widget_ready` 上报——Rust 侧
//! 不画字，省掉自绘 GDI 的一整套字体 / DPI / 本地化逻辑，代价是多一个 webview 实例。
//!
//! 关键取舍（都是会踩的坑）：
//! - 用 `win.destroy()` 而非 `win.close()`：本应用的 `on_window_event` 把任何窗口的
//!   CloseRequested 都当主窗口关闭分流处理（隐藏主窗或整个退出），小窗走 close 会误触发。
//! - 窗口先建为隐藏，等前端量出真实尺寸再定位 + 显示，避免首帧跳位。
//! - `focusable(false)`（→ WS_EX_NOACTIVATE）保证 show() 与点击都不抢焦点；
//!   `set_ignore_cursor_events(true)` 让鼠标事件穿透到任务栏本身。
//! - 任务栏矩形取自 Shell_TrayWnd、托盘区取其子窗 TrayNotifyWnd；找不到托盘区时
//!   退回任务栏右缘（可能与托盘图标重叠，属兜底）。
//! - 点击任务栏会把 shell 提到置顶带最上层，把条带盖住；故每拍检查 z 序，被压住
//!   才重申置顶——不做每秒无脑置顶，避免与托盘弹出面板（Wi-Fi/音量等）抢层。
//!   完整核对 1s 一拍太慢：实测点击任务栏（托盘区收展 / 任务栏空白均然）后条带被
//!   盖住 0.3~0.5s，肉眼就是一下闪烁。故定位线程另挂一个 50ms 轻量检测（只读 z 序，
//!   不碰任何 tao 窗口 API），发现任务栏压在条带上就立即排队顶回，不等下一完整拍。
//! - 条带样式（默认/透明）、排列（单行/两行）与日/夜间取色都是前端呈现；Rust 侧只经
//!   `taskbar-widget://settings` 转发设置、每拍广播任务栏明暗（见 `taskbar_is_light`）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};
#[cfg(windows)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::{load_settings, resolve_app_data, save_settings_json, AppSettings};

/// 小窗的窗口 label（与 capabilities/taskbar-widget.json、前端事件目标一致）。
pub const WIDGET_LABEL: &str = "taskbar-metrics";

/// 可显示的参数键：顺序即条带内显示顺序（前端复选框与设置持久化共用）。
pub const ITEM_KEYS: [&str; 4] = ["cpu", "mem", "gpu", "vram"];

/// 条带样式键（与设置卡片单选组、前端归一化对齐）：default = 近黑圆角底；
/// transparent = 无底色，文字直接叠在任务栏上（由后端广播的任务栏明暗驱动取色）。
pub const STYLE_DEFAULT: &str = "default";
pub const STYLE_TRANSPARENT: &str = "transparent";
/// 排列键：single = 单行；double = 两行（仅横任务栏生效；竖任务栏本就逐项成行，保持单列）。
pub const LAYOUT_SINGLE: &str = "single";
pub const LAYOUT_DOUBLE: &str = "double";

/// 定位线程节拍（毫秒）：任务栏移动 / 自动隐藏 / 全屏切换都靠这一周期兜住。
#[cfg(windows)]
const TICK_MS: u64 = 1000;
/// 条带收起期间（任务栏自动隐藏 / 前台全屏 / explorer 重启间隙）的完整拍节拍：
/// 没人看就放慢几何核对，恢复检测 2s 一次足够（条带不在屏上，落位精度无感）。
#[cfg(windows)]
const HIDDEN_TICK_MS: u64 = 2000;
/// 条带收起期间的循环睡眠：被压检测无从做起（条带不在屏上，任务栏压不到它），
/// 不必 50ms 醒一次；200ms 醒来看是否该排下一拍即可。
#[cfg(windows)]
const HIDDEN_SLEEP_MS: u64 = 200;
/// 高频检测节拍（毫秒）：只做「任务栏是否压在条带上」的只读 z 序检查，命中即排队
/// 顶回。比完整拍快一个量级，把点击任务栏后条带被盖住的时间压到人眼难辨。
#[cfg(windows)]
const PRESS_CHECK_MS: u64 = 50;
/// 条带与托盘区之间的间隙（逻辑像素，按 DPI 换算为物理像素）。
#[cfg(windows)]
const GAP_LOGICAL: f64 = 6.0;
/// 任务栏与其所在显示器的可见交叠低于该值（物理像素）视为「已自动隐藏」。
#[cfg(any(windows, test))]
const VISIBLE_MIN_PX: i32 = 8;
/// 前端上报真实尺寸前的窗口粗尺寸（逻辑像素）。仅 Windows 建窗用；非 Windows 上
/// 整个文件不进构建路径的门控区，留着就是 dead_code（clippy -D warnings 会拦）。
#[cfg(windows)]
const INITIAL_LOGICAL: (f64, f64) = (240.0, 32.0);

struct Shared {
    /// 定位线程停止旗标；None = 线程未运行。取走并置位即要求线程在一拍内退出。
    stop: Mutex<Option<Arc<AtomicBool>>>,
    /// 前端量出的条带逻辑尺寸（CSS px）；None = 尚未上报（窗口保持隐藏）。
    size: Mutex<Option<(f64, f64)>>,
    /// 上一拍已生效的窗口状态（去重用，避免重复落位 / 重复发事件）。
    tick: Mutex<TickState>,
    /// 小窗原生句柄（isize）缓存：供定位线程做只读 z 序检测。句柄在窗口生命周期内
    /// 不变，故只在未缓存时写一次；窗口销毁（disable）时清空，防拿失效句柄乱找。
    #[cfg(windows)]
    hwnd: Mutex<Option<isize>>,
    /// 条带当前是否收起（由 `apply_step` 的显隐分支维护，定位线程只读）：收起期间
    /// 核对降频、被压检测停跑（见 `spawn_supervisor`）。
    #[cfg(windows)]
    hidden: AtomicBool,
}

#[derive(Default)]
struct TickState {
    pos: Option<(i32, i32)>,
    size_px: Option<(u32, u32)>,
    vertical: Option<bool>,
    /// 任务栏是否浅色（SystemUsesLightTheme）。None = 读不到（键/值缺失），不广播，
    /// 前端按系统 prefers-color-scheme 兜底。
    theme_light: Option<bool>,
    shown: bool,
}

static STATE: LazyLock<Shared> = LazyLock::new(|| Shared {
    stop: Mutex::new(None),
    size: Mutex::new(None),
    tick: Mutex::new(TickState::default()),
    #[cfg(windows)]
    hwnd: Mutex::new(None),
    #[cfg(windows)]
    hidden: AtomicBool::new(false),
});

/// `step()` 是否正在主线程上执行（可重入守卫）。
///
/// 窗口操作会**同步**回调到本线程（`SetWindowPos` → 窗口过程），而 `step()` 自身又是由
/// IPC（`taskbar_widget_ready`）触发的，二者叠加就可能让 `step()` 在主线程上二次进入。
/// `std::sync::Mutex` 不可重入，二次进入即主线程自锁死（整应用 hung、托盘点不动）。
/// 挡掉即可：本拍的活由外层那次做完，被挡的这次下一拍自会补上。
static STEPPING: AtomicBool = AtomicBool::new(false);

/// 已排进主线程队列但尚未开跑的 `step()` 数量上限——最多一个。
/// 主线程繁忙（长任务 / 系统挂起）时若每拍都追加，队列会无界增长；而多排几次也没有
/// 额外收益（第二拍看到的仍是同一份状态），故已有排队就直接跳过本拍。
static STEP_QUEUED: AtomicBool = AtomicBool::new(false);

/// RAII：离开 `step()` 时清除「执行中」标记（panic 路径同样生效，不留死标记）。
struct StepGuard;

impl Drop for StepGuard {
    fn drop(&mut self) {
        STEPPING.store(false, Ordering::SeqCst);
    }
}

// ── IPC 命令 ───────────────────────────────────────────────────────────

/// `taskbar-widget://settings` 事件载荷：一份设置快照。字段名是跨层契约
/// （前端见 src/widget/TaskbarMetrics.tsx），改名须两处同步。
#[derive(Clone, serde::Serialize)]
struct WidgetSettings {
    items: Vec<String>,
    style: String,
    layout: String,
    detailed: bool,
}

/// 开关 / 勾选项 / 样式 / 排列 / 详细数据落盘并立即生效：开启时确保小窗存在并启动
/// 定位线程，关闭时销毁小窗。返回落盘后的全量设置（前端以后端返回值校准，与其它设置命令一致）。
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
    let items = normalize_items(&items)?;
    // style/layout 宽松归一化（未知值落回默认）：settings.json 可被手改，也可能来自更新版本。
    let style = normalize_style(&style).to_string();
    let layout = normalize_layout(&layout).to_string();
    // 勾选全空 = 无内容可显示，按关闭落盘（前端在勾掉最后一项时会同步关掉开关）。
    let enabled = enabled && !items.is_empty();

    // 先做运行时生效、再落盘：启用失败（平台不支持/建窗失败）不留下「已开启」的设置，
    // 否则下次启动会反复尝试恢复一个起不来的小窗。
    if enabled {
        enable(&app)?;
    } else {
        disable(&app);
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
    // 让已打开的小窗立刻按新设置重绘（样式/排列/详细数据变更会经 ResizeObserver 触发
    // 尺寸重报，由定位线程跟随新尺寸重新落位）；小窗刚被销毁时该事件无人接收，属预期。
    let _ = app.emit_to(
        WIDGET_LABEL,
        "taskbar-widget://settings",
        WidgetSettings {
            items: settings.taskbar_metrics_items.clone(),
            style: settings.taskbar_metrics_style.clone(),
            layout: settings.taskbar_metrics_layout.clone(),
            detailed: settings.taskbar_metrics_detailed,
        },
    );
    Ok(settings)
}

/// 前端量出的条带逻辑尺寸（CSS px）：窗口尺寸与位置到此才校准并首次显示。
#[tauri::command]
pub fn taskbar_widget_ready(app: AppHandle, width: f64, height: f64) {
    let _g = crate::diag::cmd("cmd_taskbar_widget_ready");
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return;
    }
    *STATE.size.lock().unwrap() = Some((width, height));
    // 不等下一拍：立即定位 + 显示，避免开启后约 1 秒空窗。
    // 本命令跑在 tokio worker 上（同步命令），故经主线程排队执行——窗口 API 必须在
    // 事件循环线程上调用（见 `spawn_supervisor` 的注释）。
    queue_step(&app);
}

/// 把一拍 `step()` 排到主线程上执行。**所有调用点都必须走这里**，不能直调 `step()`。
///
/// 经 `run_on_main_thread`（wry 侧 PostThreadMessage 投递 `Message::Task`）排队，由事件
/// 循环线程取走执行。已有排队未跑时跳过本拍：主线程繁忙（长任务 / 系统挂起）期间每拍
/// 都追加会让队列无界增长，而多排一次也没有额外收益（第二拍看到的仍是同一份状态）。
fn queue_step(app: &AppHandle) {
    if STEP_QUEUED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    let run = move || {
        STEP_QUEUED.store(false, Ordering::SeqCst);
        step(&handle);
    };
    if app.run_on_main_thread(run).is_err() {
        // 主线程已不可用（应用正在退出）：清掉标记，让下一次调用还能正常排队。
        STEP_QUEUED.store(false, Ordering::SeqCst);
    }
}

/// 本平台是否支持任务栏小窗（前端据此决定设置卡片是否渲染）。目前仅 Windows。
#[tauri::command]
pub fn get_taskbar_widget_support() -> bool {
    cfg!(windows)
}

/// 启动恢复：设置里开着且勾选项非空时，随应用启动重建小窗与定位线程。
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
fn enable(app: &AppHandle) -> Result<(), String> {
    // 重复开启（连点开关 / 启动恢复与手动开启重叠）时先停旧线程，保持单例。
    stop_thread();
    let created = ensure_window(app)?;
    if created {
        // 换了新窗口：等前端重新上报尺寸，并清掉旧的落位记录。
        *STATE.size.lock().unwrap() = None;
        *STATE.tick.lock().unwrap() = TickState::default();
        *STATE.hwnd.lock().unwrap() = None;
    }
    let stop = Arc::new(AtomicBool::new(false));
    *STATE.stop.lock().unwrap() = Some(stop.clone());
    spawn_supervisor(app.clone(), stop);
    Ok(())
}

#[cfg(not(windows))]
fn enable(_app: &AppHandle) -> Result<(), String> {
    Err("任务栏小窗仅支持 Windows。".into())
}

fn disable(app: &AppHandle) {
    stop_thread();
    // destroy（而非 close）：close 会走主窗口那套 CloseRequested 分流（隐藏主窗/退出应用），
    // 绝不能用于小窗（见模块头「关键取舍」）。
    if let Some(win) = app.get_webview_window(WIDGET_LABEL) {
        let _ = win.destroy();
    }
    *STATE.size.lock().unwrap() = None;
    *STATE.tick.lock().unwrap() = TickState::default();
    #[cfg(windows)]
    {
        *STATE.hwnd.lock().unwrap() = None;
        // 复位「收起」标志：下次启用的首个完整拍会重新判定，不停在降频分支。
        STATE.hidden.store(false, Ordering::Relaxed);
    }
}

fn stop_thread() {
    if let Some(stop) = STATE.stop.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}

/// 定位线程：完整核对（落位 / 显隐 / 主题）可见时每秒一次；另以 50ms 轻量检测盯着
/// 「任务栏是否压在条带上」——点击任务栏（托盘区收展 / 任务栏空白）时 Windows 把任务栏
/// 提到条带之上盖住它，等下一完整拍才顶回的话，实测被盖住 0.3~0.5s，肉眼就是一下闪烁。
/// 检测命中即排队顶回，把被盖时间压到人眼难辨。disabled 后一拍内退出。
/// 条带收起期间（任务栏自动隐藏 / 前台全屏 / explorer 重启间隙）没人看：完整核对降频到
/// 2s 一拍，被压检测停跑（条带不在屏上，任务栏压不到它），循环睡眠放到 200ms。
/// 可见性只由任务栏几何与前台全屏驱动——**与主窗口是否隐藏到托盘无关**：主窗口托盘
/// 常驻时主面板停表（省 CPU 的既有优化），而本小窗是常驻监控，继续显示与刷新。
///
/// 本线程**不做任何窗口操作**，只把一拍 `step()` 排到主线程（见 `queue_step`）：
/// tao 的窗口 API 会在调用方线程上同步取窗口自己的 `window_state` 锁，而主线程另有路径
/// （IPC / 窗口过程回调）也来取这把锁与 `STATE.tick`——两边跨线程反向取锁即 AB-BA 死锁
/// （2026-10-13 休眠唤醒后实测：两线程互等，整应用 hung、托盘点不动）。
/// 统一到主线程后，所有窗口操作与 `STATE.tick` 都在同一线程串行发生，锁序天然一致。
/// 高频检测因此也只做只读 user32 调用（`pressed_by_taskbar`），不碰 tao 窗口 API。
#[cfg(windows)]
fn spawn_supervisor(app: AppHandle, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        // 初始值拨到「已到点」：进线程立即做一次完整核对（同原行为）。
        let mut next_full = std::time::Instant::now() - std::time::Duration::from_millis(TICK_MS);
        while !stop.load(Ordering::Relaxed) {
            if STATE.hidden.load(Ordering::Relaxed) {
                if next_full.elapsed() >= std::time::Duration::from_millis(HIDDEN_TICK_MS) {
                    next_full = std::time::Instant::now();
                    queue_step(&app);
                }
                std::thread::sleep(std::time::Duration::from_millis(HIDDEN_SLEEP_MS));
            } else {
                if next_full.elapsed() >= std::time::Duration::from_millis(TICK_MS) {
                    next_full = std::time::Instant::now();
                    queue_step(&app);
                }
                if pressed_by_taskbar() {
                    queue_step(&app);
                }
                std::thread::sleep(std::time::Duration::from_millis(PRESS_CHECK_MS));
            }
        }
    });
}

/// 建立小窗（已存在则复用）：返回是否新建。
#[cfg(windows)]
fn ensure_window(app: &AppHandle) -> Result<bool, String> {
    if app.get_webview_window(WIDGET_LABEL).is_some() {
        return Ok(false);
    }
    let win = WebviewWindowBuilder::new(app, WIDGET_LABEL, WebviewUrl::App("widget.html".into()))
        .title("Oh My Llama")
        .inner_size(INITIAL_LOGICAL.0, INITIAL_LOGICAL.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        // focusable(false) → WS_EX_NOACTIVATE：show()/点击均不激活，绝不抢走用户当前窗口的焦点。
        .focusable(false)
        .focused(false)
        // 先隐藏：前端上报尺寸并定位后再显示，避免首帧出现在屏幕角落。
        .visible(false)
        .build()
        .map_err(|err| format!("创建任务栏小窗失败: {err}"))?;
    win.set_ignore_cursor_events(true)
        .map_err(|err| format!("设置小窗点击穿透失败: {err}"))?;
    Ok(true)
}

/// 把窗口从「显示在任务栏」族里摘干净（Alt-Tab / 任务栏悬停预览也不出现）。
///
/// tauri 的 skip_taskbar 走 ITaskbarList::DeleteTab——只摘任务栏按钮、不改 ex-style；
/// 而 tao 建的是无 owner 顶层窗（ON_TASKBAR → WS_EX_APPWINDOW）且每次显示/隐藏都会
/// **整段重写** ex-style（见 tao window_state::apply_diff），所以只能在定位线程里每拍
/// 兜底纠正：缺 WS_EX_TOOLWINDOW / 带 WS_EX_APPWINDOW 时就地改回来（2026-10-11 实测）。
/// 顺带覆盖 explorer 重启后 DeleteTab 失效、任务栏按钮复活的情况。
#[cfg(windows)]
fn mark_tool_window(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let raw = hwnd.0 as windows_sys::Win32::Foundation::HWND;
    unsafe {
        let ex = GetWindowLongPtrW(raw, GWL_EXSTYLE) as u32;
        let want = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
        if want != ex {
            SetWindowLongPtrW(raw, GWL_EXSTYLE, want as isize);
            // 帧刷新让 shell 重读样式（任务栏按钮与 Alt-Tab 归属随之更新）。
            SetWindowPos(
                raw,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
    }
}

// ── 每拍核对 ───────────────────────────────────────────────────────────

/// 本拍要施加到窗口上的动作（纯数据，不含任何窗口/事件调用）。
///
/// 先由 `plan_step` 在**持 `STATE.tick` 锁期间**算出，再由 `apply_step` 在**完全释放该锁之后**
/// 执行。这条分层是死锁修复的关键：窗口 API 与事件广播会同步去取别的锁（tao 的
/// `window_state`、tauri 的事件系统），而主线程另有路径（`taskbar_widget_ready` 的 IPC、
/// 窗口过程回调）会来取 `STATE.tick`——持锁调窗口 API 会与主线程的反向取锁构成 AB-BA 死锁
/// （2026-10-13 休眠唤醒后实测：主线程与定位线程互等，整应用 hung、托盘点不动）。
struct StepPlan {
    /// 要广播的任务栏明暗；None = 本拍不广播。
    theme: Option<&'static str>,
    size_px: Option<(u32, u32)>,
    pos: Option<(i32, i32)>,
    vertical: Option<bool>,
    /// Some(true)/Some(false) = 要求显示/隐藏；None = 维持现状（已显示时不重复 show）。
    place: Option<bool>,
    /// 是否重申置顶 + 纠正工具窗样式：条带在任务栏上有位置时每拍都要做（点击任务栏会
    /// 把 shell 提到置顶带最上层、tao 每次显隐又重写 ex-style），与是否需要 show 无关。
    /// 仅 Windows 有读者（`apply_step` 的纠正块）；非 Windows 无 z 序可纠正，字段不构建。
    #[cfg(windows)]
    fixups: bool,
}

impl StepPlan {
    /// 与本拍几何和上一拍记账比对，得出要施加的动作，并把记账推进到「已生效」。
    ///
    /// 记账在这里就推进（不等 `apply_step` 返回）：执行失败只丢一拍，下一拍仍会按新几何
    /// 纠正；反过来等执行成功再记账，则要在锁外再写一次 `STATE.tick`，多一次取锁。
    /// 纯逻辑（不碰窗口、不算几何），故可直接单测。
    fn decide(tick: &mut TickState, place: Option<Placement>, theme: Option<bool>) -> Self {
        let mut plan = match place {
            Some(p) => Self {
                theme: None,
                size_px: (tick.size_px != Some((p.w_px, p.h_px))).then_some((p.w_px, p.h_px)),
                pos: (tick.pos != Some((p.x, p.y))).then_some((p.x, p.y)),
                vertical: (tick.vertical != Some(p.vertical)).then_some(p.vertical),
                place: (!tick.shown).then_some(true),
                #[cfg(windows)]
                fixups: true,
            },
            // 任务栏不可用（自动隐藏 / 全屏 / explorer 重启间隙）：收起条带。
            None => Self {
                theme: None,
                size_px: None,
                pos: None,
                vertical: None,
                place: tick.shown.then_some(false),
                #[cfg(windows)]
                fixups: false,
            },
        };
        // 只有**读到**且翻转才广播：读不到（None）时不广播，由前端按系统 prefers-color-scheme
        // 兜底——不能拿「读不到」去推翻上一次结论，否则明暗会来回跳。
        plan.theme = match (tick.theme_light, theme) {
            (None, Some(true)) | (Some(false), Some(true)) => Some("light"),
            (None, Some(false)) | (Some(true), Some(false)) => Some("dark"),
            _ => None,
        };
        tick.theme_light = theme;
        if let Some(v) = plan.size_px {
            tick.size_px = Some(v);
        }
        if let Some(v) = plan.pos {
            tick.pos = Some(v);
        }
        if let Some(v) = plan.vertical {
            tick.vertical = Some(v);
        }
        if let Some(show) = plan.place {
            tick.shown = show;
        }
        plan
    }
}

/// 缓存小窗原生句柄（供定位线程只读 z 序检测用）：句柄在窗口生命周期内不变，只在
/// 未缓存时写一次。放在任何 `STATE` 锁之外调用——持锁写缓存会把锁序搞成嵌套。
#[cfg(windows)]
fn cache_hwnd(win: &tauri::WebviewWindow) {
    let mut cached = STATE.hwnd.lock().unwrap();
    if cached.is_none() {
        if let Ok(hwnd) = win.hwnd() {
            *cached = Some(hwnd.0 as isize);
        }
    }
}

/// 读任务栏几何与上一拍状态，算出本拍动作（持 `STATE.tick` 锁，不做任何窗口调用）。
fn plan_step(app: &AppHandle) -> Option<(tauri::WebviewWindow, StepPlan)> {
    let Some(win) = app.get_webview_window(WIDGET_LABEL) else {
        return None; // 已禁用（窗口被销毁）；定位线程将在一拍内自行退出
    };
    #[cfg(windows)]
    {
        cache_hwnd(&win);
    }
    let Some((lw, lh)) = *STATE.size.lock().unwrap() else {
        return None; // 前端还没上报尺寸：窗口保持隐藏
    };
    let place = placement(lw, lh, win.scale_factor().unwrap_or(1.0));

    let mut tick = STATE.tick.lock().unwrap();
    // 任务栏明暗（透明样式据此选文字色）：只在变化时广播；读不到不广播，由前端按
    // prefers-color-scheme 兜底。放在显隐分支之前——条带被全屏压住期间也保持同步。
    let theme = {
        let _t = crate::diag::cmd("widget_theme_read");
        taskbar_is_light()
    };
    Some((win, StepPlan::decide(&mut tick, place, theme)))
}

/// 施加本拍动作（**不持任何 STATE 锁**）。
fn apply_step(app: &AppHandle, win: &tauri::WebviewWindow, plan: StepPlan) {
    if let Some(payload) = plan.theme {
        let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://theme", payload);
    }
    if let Some((w, h)) = plan.size_px {
        let _w = crate::diag::cmd("widget_set_size");
        let _ = win.set_size(PhysicalSize::new(w, h));
    }
    if let Some((x, y)) = plan.pos {
        let _w = crate::diag::cmd("widget_set_position");
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    if let Some(vertical) = plan.vertical {
        let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://vertical", vertical);
    }
    match plan.place {
        Some(true) => {
            let _w = crate::diag::cmd("widget_show");
            let _ = win.show();
            let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://visible", true);
            STATE.hidden.store(false, Ordering::Relaxed);
        }
        Some(false) => {
            let _w = crate::diag::cmd("widget_hide");
            let _ = win.hide();
            let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://visible", false);
            STATE.hidden.store(true, Ordering::Relaxed);
        }
        None => {}
    }
    // show()/hide() 都经 tao 整段重写 ex-style，置顶与工具窗纠正必须放在其后
    // （刚显示完就把 APPWINDOW 摘掉，不给 Alt-Tab 留窗口期）。
    #[cfg(windows)]
    if plan.fixups {
        let _w = crate::diag::cmd("widget_topmost_toolwindow");
        reassert_topmost(win);
        mark_tool_window(win);
    }
}

/// 一拍核对。**只能在主线程上调用**（见 `spawn_supervisor`）；入口处挡掉重入。
fn step(app: &AppHandle) {
    let _g = crate::diag::cmd("widget_step");
    // 重入守卫：窗口操作会同步回调到本线程，可能再经 IPC 进到这里。挡掉即可——
    // 本拍的活由外层那次做完，被挡的这次下一拍自会补上。
    if STEPPING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _guard = StepGuard;

    let Some((win, plan)) = plan_step(app) else {
        return;
    };
    apply_step(app, &win, plan);
}

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

/// 竖任务栏（宽 ≤ 高）判定；横任务栏的条带横排，竖任务栏的条带由前端改为竖排。
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

struct Placement {
    x: i32,
    y: i32,
    w_px: u32,
    h_px: u32,
    vertical: bool,
}

/// 测试替身：非 Windows 上 `placement()` 恒为 None，单测要造一份「有位置」的几何。
#[cfg(test)]
impl Placement {
    fn at(x: i32, y: i32, w_px: u32, h_px: u32, vertical: bool) -> Self {
        Self {
            x,
            y,
            w_px,
            h_px,
            vertical,
        }
    }
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
fn placement(logical_w: f64, logical_h: f64, scale: f64) -> Option<Placement> {
    let geo = geometry()?;
    if geo.suppressed {
        return None;
    }
    let w_px = (logical_w * scale).round().max(1.0) as u32;
    let h_px = (logical_h * scale).round().max(1.0) as u32;
    let gap = (GAP_LOGICAL * scale).round() as i32;
    let (x, y) = compute_position(&geo.bar, geo.tray.as_ref(), w_px as i32, h_px as i32, gap);
    Some(Placement {
        x,
        y,
        w_px,
        h_px,
        vertical: geo.vertical,
    })
}

#[cfg(not(windows))]
fn placement(_logical_w: f64, _logical_h: f64, _scale: f64) -> Option<Placement> {
    None // 非 Windows 平台不启用（前端卡片据此也不渲染）
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
/// None = 读不到（键/值缺失或类型不对），由前端按 prefers-color-scheme 兜底。
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

#[cfg(not(windows))]
fn taskbar_is_light() -> Option<bool> {
    None // 小窗仅 Windows；兜底保持编译通过且不广播
}

/// 任务栏是否压在条带之上：从本窗口沿 z 序向上最多找 32 个窗口，命中任务栏即算
/// 「被压住」。托盘弹出面板（Wi-Fi/音量等）弹出时面板自身是直接上层、任务栏不在
/// 近处，故不命中、不抢层。
///
/// 「被压住」的唯一定义处：`reassert_topmost`（完整拍里重申置顶）与
/// `pressed_by_taskbar`（50ms 高频检测）共用同一判据，两处理解必须一致。
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

/// 50ms 高频检测用：任务栏此刻是否压在条带上（点击任务栏激活 shell 后的瞬时状态）。
/// **只读** z 序、只碰 `STATE.hwnd` 一把独立锁，不调任何 tao 窗口 API——跨线程取
/// 窗口锁会 AB-BA 死锁（见 `spawn_supervisor` 注释）。句柄未缓存（首拍未到）时跳过。
#[cfg(windows)]
fn pressed_by_taskbar() -> bool {
    let Some(hwnd) = *STATE.hwnd.lock().unwrap() else {
        return false;
    };
    taskbar_above(hwnd as windows_sys::Win32::Foundation::HWND)
}

/// 条带被任务栏压住时重申置顶（点击任务栏会把 shell 提到置顶带最上层）。
#[cfg(windows)]
fn reassert_topmost(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let our = hwnd.0 as HWND;
    unsafe {
        if taskbar_above(our) {
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

    /// 广播载荷的字段名是前端契约（TaskbarMetrics.tsx 按 items / style / layout / detailed 解析）。
    #[test]
    fn widget_settings_payload_shape() {
        let json = serde_json::to_value(WidgetSettings {
            items: vec!["cpu".into()],
            style: STYLE_TRANSPARENT.into(),
            layout: LAYOUT_DOUBLE.into(),
            detailed: true,
        })
        .unwrap();
        assert_eq!(json["items"], serde_json::json!(["cpu"]));
        assert_eq!(json["style"], STYLE_TRANSPARENT);
        assert_eq!(json["layout"], LAYOUT_DOUBLE);
        assert_eq!(json["detailed"], true);
    }

    /// 首拍（全新状态 + 任务栏有位置）：尺寸 / 位置 / 竖排 / 显示 / 置顶纠正全都要做。
    #[test]
    fn plan_first_tick_does_everything() {
        let mut tick = TickState::default();
        let plan = StepPlan::decide(&mut tick, Some(Placement::at(10, 20, 300, 40, false)), None);
        assert_eq!(plan.size_px, Some((300, 40)));
        assert_eq!(plan.pos, Some((10, 20)));
        assert_eq!(plan.vertical, Some(false));
        assert_eq!(plan.place, Some(true));
        #[cfg(windows)]
        assert!(plan.fixups, "有位置时每拍都要重申置顶/纠正样式");
    }

    /// 次拍（几何未变、已显示）：除置顶纠正外全部去重为空——不重复 set_size/set_position/show。
    #[test]
    fn plan_repeat_tick_is_all_noop_except_fixups() {
        let mut tick = TickState::default();
        let place = || Some(Placement::at(10, 20, 300, 40, false));
        let _ = StepPlan::decide(&mut tick, place(), None);
        let plan = StepPlan::decide(&mut tick, place(), None);
        assert_eq!(plan.size_px, None, "尺寸未变则不再 set_size");
        assert_eq!(plan.pos, None, "位置未变则不再 set_position");
        assert_eq!(plan.vertical, None);
        assert_eq!(plan.place, None, "已显示则不重复 show");
        #[cfg(windows)]
        assert!(plan.fixups, "置顶纠正每拍都做（防被 shell 压住）");
    }

    /// 任务栏不可用（自动隐藏 / 全屏 / explorer 重启间隙）：要求收起，且不做置顶纠正。
    /// 收起后再次不可用 → `place` 为 None（已隐藏，不重复 hide）。
    #[test]
    fn plan_without_placement_hides_once() {
        let mut tick = TickState::default();
        let _ = StepPlan::decide(&mut tick, Some(Placement::at(10, 20, 300, 40, false)), None);
        let hidden = StepPlan::decide(&mut tick, None, None);
        assert_eq!(hidden.place, Some(false));
        #[cfg(windows)]
        assert!(!hidden.fixups, "已收起时无需再动 z 序");
        assert_eq!(StepPlan::decide(&mut tick, None, None).place, None);
    }

    /// 任务栏明暗只在翻转时广播一次；读不到（None）不广播，由前端按系统配色兜底。
    #[test]
    fn plan_broadcasts_theme_only_on_flip() {
        let mut tick = TickState::default();
        assert_eq!(
            StepPlan::decide(&mut tick, None, Some(false)).theme,
            Some("dark"),
            "首次读到即广播一次"
        );
        assert_eq!(StepPlan::decide(&mut tick, None, Some(false)).theme, None);
        assert_eq!(
            StepPlan::decide(&mut tick, None, Some(true)).theme,
            Some("light"),
            "翻转才再广播"
        );
        // 读不到：不广播（保留上一次结论，不做无依据的翻转）。
        assert_eq!(StepPlan::decide(&mut tick, None, None).theme, None);
    }

    /// 记账在 `decide` 内即推进：几何再回到原值时仍能重新纠正（不因「已记账」而永远不发）。
    #[test]
    fn plan_accounting_advances_so_later_drift_is_corrected() {
        let mut tick = TickState::default();
        let _ = StepPlan::decide(&mut tick, Some(Placement::at(10, 20, 300, 40, false)), None);
        let moved = StepPlan::decide(&mut tick, Some(Placement::at(11, 20, 300, 40, false)), None);
        assert_eq!(moved.pos, Some((11, 20)), "位置漂了一像素也要纠正");
        let back = StepPlan::decide(&mut tick, Some(Placement::at(10, 20, 300, 40, false)), None);
        assert_eq!(back.pos, Some((10, 20)), "回来时同样纠正");
    }
}
