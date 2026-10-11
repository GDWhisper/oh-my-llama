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

/// 定位线程节拍（毫秒）：任务栏移动 / 自动隐藏 / 全屏切换都靠这一周期兜住。
#[cfg(windows)]
const TICK_MS: u64 = 1000;
/// 条带与托盘区之间的间隙（逻辑像素，按 DPI 换算为物理像素）。
#[cfg(windows)]
const GAP_LOGICAL: f64 = 6.0;
/// 任务栏与其所在显示器的可见交叠低于该值（物理像素）视为「已自动隐藏」。
#[cfg(any(windows, test))]
const VISIBLE_MIN_PX: i32 = 8;
/// 前端上报真实尺寸前的窗口粗尺寸（逻辑像素）。
const INITIAL_LOGICAL: (f64, f64) = (240.0, 32.0);

struct Shared {
    /// 定位线程停止旗标；None = 线程未运行。取走并置位即要求线程在一拍内退出。
    stop: Mutex<Option<Arc<AtomicBool>>>,
    /// 前端量出的条带逻辑尺寸（CSS px）；None = 尚未上报（窗口保持隐藏）。
    size: Mutex<Option<(f64, f64)>>,
    /// 上一拍已生效的窗口状态（去重用，避免重复落位 / 重复发事件）。
    tick: Mutex<TickState>,
}

#[derive(Default)]
struct TickState {
    pos: Option<(i32, i32)>,
    size_px: Option<(u32, u32)>,
    vertical: Option<bool>,
    shown: bool,
}

static STATE: LazyLock<Shared> = LazyLock::new(|| Shared {
    stop: Mutex::new(None),
    size: Mutex::new(None),
    tick: Mutex::new(TickState::default()),
});

// ── IPC 命令 ───────────────────────────────────────────────────────────

/// 开关与勾选项落盘并立即生效：开启时确保小窗存在并启动定位线程，关闭时销毁小窗。
/// 返回落盘后的全量设置（前端以后端返回值校准，与其它设置命令一致）。
#[tauri::command]
pub async fn set_taskbar_metrics(
    app: AppHandle,
    enabled: bool,
    items: Vec<String>,
) -> Result<AppSettings, String> {
    let items = normalize_items(&items)?;
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
    // 读-改-写：只动本命令负责的两个字段（见 lib.rs 的 AppSettings 注释）。
    let mut settings = load_settings(&app_data);
    settings.taskbar_metrics_enabled = enabled;
    settings.taskbar_metrics_items = items;
    save_settings_json(&app_data, &settings)?;
    // 让已打开的小窗立刻按新勾选项重绘；小窗刚被销毁时该事件无人接收，属预期。
    let _ = app.emit_to(
        WIDGET_LABEL,
        "taskbar-widget://settings",
        &settings.taskbar_metrics_items,
    );
    Ok(settings)
}

/// 前端量出的条带逻辑尺寸（CSS px）：窗口尺寸与位置到此才校准并首次显示。
#[tauri::command]
pub fn taskbar_widget_ready(app: AppHandle, width: f64, height: f64) {
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return;
    }
    *STATE.size.lock().unwrap() = Some((width, height));
    // 不等下一拍：立即定位 + 显示，避免开启后约 1 秒空窗。
    step(&app);
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
}

fn stop_thread() {
    if let Some(stop) = STATE.stop.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}

/// 定位线程：每秒核对任务栏几何，按需挪位 / 显示 / 收起；disabled 后一拍内退出。
/// 可见性只由任务栏几何与前台全屏驱动——**与主窗口是否隐藏到托盘无关**：主窗口托盘
/// 常驻时主面板停表（省 CPU 的既有优化），而本小窗是常驻监控，继续显示与刷新。
#[cfg(windows)]
fn spawn_supervisor(app: AppHandle, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            step(&app);
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
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

fn step(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WIDGET_LABEL) else {
        return; // 已禁用（窗口被销毁）；定位线程将在一拍内自行退出
    };
    let Some((lw, lh)) = *STATE.size.lock().unwrap() else {
        return; // 前端还没上报尺寸：窗口保持隐藏
    };
    let place = placement(lw, lh, win.scale_factor().unwrap_or(1.0));

    let mut tick = STATE.tick.lock().unwrap();
    match place {
        Some(p) => {
            if tick.size_px != Some((p.w_px, p.h_px)) {
                let _ = win.set_size(PhysicalSize::new(p.w_px, p.h_px));
                tick.size_px = Some((p.w_px, p.h_px));
            }
            if tick.pos != Some((p.x, p.y)) {
                let _ = win.set_position(PhysicalPosition::new(p.x, p.y));
                tick.pos = Some((p.x, p.y));
            }
            if tick.vertical != Some(p.vertical) {
                let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://vertical", p.vertical);
                tick.vertical = Some(p.vertical);
            }
            if !tick.shown {
                let _ = win.show();
                let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://visible", true);
                tick.shown = true;
            }
            // show()/hide() 都经 tao 整段重写 ex-style，置顶与工具窗纠正必须放在其后
            // （刚显示完就把 APPWINDOW 摘掉，不给 Alt-Tab 留窗口期）。
            #[cfg(windows)]
            {
                reassert_topmost(&win);
                mark_tool_window(&win);
            }
        }
        None => {
            if tick.shown {
                let _ = win.hide();
                let _ = app.emit_to(WIDGET_LABEL, "taskbar-widget://visible", false);
                tick.shown = false;
            }
        }
    }
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

/// 任务栏是否压在条带上方：点击任务栏会把 shell（含托盘弹出面板）提到置顶带最上层。
/// 从本窗口沿 z 序向上最多找 32 个窗口，命中任务栏才重申置顶——面板弹出时不与之抢层。
#[cfg(windows)]
fn reassert_topmost(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetWindow, SetWindowPos, GW_HWNDPREV, HWND_TOPMOST, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let our = hwnd.0 as HWND;
    unsafe {
        let bar = FindWindowW(windows_sys::w!("Shell_TrayWnd"), std::ptr::null());
        if bar.is_null() || bar == our {
            return;
        }
        let mut cur = our;
        for _ in 0..32 {
            let prev = GetWindow(cur, GW_HWNDPREV);
            if prev.is_null() {
                return; // 已到顶：无需处理
            }
            if prev == bar {
                SetWindowPos(
                    our,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
                return;
            }
            cur = prev;
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
}
