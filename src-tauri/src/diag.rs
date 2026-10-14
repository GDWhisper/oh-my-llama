//! 假死诊断探针（**默认关闭**；需显式设 `OML_DIAG=1` 才启用，debug/release 一致）。
//!
//! 背景：2026-10-12 多次抓到主线程卡在 futex 同步原语（`ZwWaitForAlertByThreadId`）、
//! 全窗口 hung 的现场，但无法符号化到具体函数（本机无 cdb，DIA/dbghelp 解析受限）。
//! 本模块用「低成本埋点 + 独立看门狗」替代调试器：探针记录各线程的**命令进出**与
//! **自定义标记**（进入临界区 / 调用 Win32 前），看门狗线程用 `SendMessageTimeout(WM_NULL)`
//! 探主窗口，连续超时即判定假死，把探针环形缓冲与进程线程快照写入
//! `%APPDATA%/OhMyLlama/diag-hang-<ts>.log`——事后看「最后一个进入未离开的标记」，即卡点。
//!
//! 设计约束：
//! - **结构性零增长**：缓冲是**定长环形数组**（无堆增长），标签全为 `&'static str`
//!   （热路径零字符串分配），dump 只取新 64 条——启用时内存上界也为常数（约 20KB）。
//!   禁用时（默认）每次调用只读一个环境变量缓存，零分配零锁。
//! - **绝不引入新锁嵌套**：探针缓冲是模块私有的一把 `Mutex`，只做原地写入；
//!   看门狗只在假死判定后取一次锁（若非死探针锁则拿到、是则如实记录——二者都是信息）。
//! - **零外部依赖**：复用已启用的 `windows-sys` 门面。
//! - **失败静默**：日志写不出去不 panic，不影响主流程。

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// 是否启用探针：默认关闭；`OML_DIAG=1`（或 `true`）显式开启。
/// 这是安全闸门：探针任何情况下都不参与业务逻辑，关着就是零开销。
pub fn enabled() -> bool {
    static ENABLED: LazyLock<bool> = LazyLock::new(|| match std::env::var("OML_DIAG") {
        Ok(v) => v == "1" || v.eq_ignore_ascii_case("true"),
        Err(_) => false,
    });
    *ENABLED
}

/// 单条探针记录：相对进程启动的毫秒 + 线程 id + 静态标签。
#[derive(Clone)]
struct Entry {
    at_ms: u64,
    thread: u32,
    kind: &'static str, // "cmd_enter" | "cmd_exit" | "mark"
    label: &'static str,
}

static START: LazyLock<Instant> = LazyLock::new(Instant::now);

const MAX_ENTRIES: usize = 256;

/// 定长环形缓冲：写满即覆盖最旧，内存自始至终为一个固定数组。
struct VisitLog {
    ring: [Option<Entry>; MAX_ENTRIES],
    pos: usize,
    count: usize,
}

impl VisitLog {
    const fn new() -> Self {
        Self {
            ring: [const { None }; MAX_ENTRIES],
            pos: 0,
            count: 0,
        }
    }

    fn push(&mut self, e: Entry) {
        self.ring[self.pos] = Some(e);
        self.pos = (self.pos + 1) % MAX_ENTRIES;
        if self.count < MAX_ENTRIES {
            self.count += 1;
        }
    }

    /// 新→旧遍历（dump 用）。
    fn iter_newest(&self) -> impl Iterator<Item = &Entry> {
        (0..self.count).filter_map(move |i| {
            let idx = (self.pos + MAX_ENTRIES - 1 - i) % MAX_ENTRIES;
            self.ring[idx].as_ref()
        })
    }

    /// 新→旧快照（写 dump 用，持锁期间完成拷贝，拷贝量以 MAX_ENTRIES 封顶）。
    fn snapshot_newest(&self) -> Vec<Entry> {
        self.iter_newest().cloned().collect()
    }
}

static LOG: LazyLock<Mutex<VisitLog>> = LazyLock::new(|| Mutex::new(VisitLog::new()));

fn now_ms() -> u64 {
    START.elapsed().as_millis() as u64
}

fn thread_id() -> u32 {
    // 低 32 位在诊断场景足够区分线程；跨平台失败回 0。
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Threading::GetCurrentThreadId()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn push(kind: &'static str, label: &'static str) {
    if !enabled() {
        return;
    }
    if let Ok(mut log) = LOG.lock() {
        log.push(Entry {
            at_ms: now_ms(),
            thread: thread_id(),
            kind,
            label,
        });
    }
}

/// 记录一个已完成的点事件（非守卫）。用于零星标记。
pub fn mark(label: &'static str) {
    push("mark", label);
}

/// RAII 守式标记：进入记 `cmd_enter`、离开记 `cmd_exit`（标签相同）。
/// 假死后看「有进无出」的最后一条即卡点；耗时由两条记录的时间差直接读出。
pub struct Guard {
    label: &'static str,
}

impl Guard {
    fn new(label: &'static str) -> Self {
        push("cmd_enter", label);
        Self { label }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        push("cmd_exit", self.label);
    }
}

/// 命令/函数级守卫。典型用法：`let _g = diag::cmd("get_status");`
/// 标签必须是静态字符串（零分配约束）。
pub fn cmd(label: &'static str) -> Guard {
    Guard::new(label)
}

/// 主窗口句柄（HWND as isize）：看门狗探测目标。由 setup 阶段注入。
static MAIN_HWND: AtomicU64 = AtomicU64::new(0);

/// 看门狗是否已启动（防重复启动）。
static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

pub fn register_main_window(hwnd_isize: isize) {
    if hwnd_isize != 0 {
        MAIN_HWND.store(hwnd_isize as u64, Ordering::Relaxed);
    }
}

/// 启动看门狗线程：每 2s 探一次主窗口；连续 2 次超时（≈4s 无响应）判定假死，
/// 把探针缓冲落盘。恢复响应后重置，下一轮假死再写一份（每次假死一份日志）。
/// 仅在 `OML_DIAG=1` 时启动；未启用时本函数直接返回，不创建任何线程。
pub fn spawn_watchdog(app_data: std::path::PathBuf) {
    if !enabled() || WATCHDOG_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("diag-watchdog".into())
        .spawn(move || watchdog_loop(app_data))
        .ok();
}

#[cfg(windows)]
fn probe_main_window(hwnd: isize, timeout_ms: u32) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG};
    let mut result: usize = 0;
    let ok = unsafe {
        SendMessageTimeoutW(
            hwnd as *mut core::ffi::c_void,
            0, // WM_NULL：不改变任何状态，只要求消息循环回话
            0,
            0,
            SMTO_ABORTIFHUNG,
            timeout_ms,
            &mut result,
        )
    };
    ok != 0
}

#[cfg(not(windows))]
fn probe_main_window(_hwnd: isize, _timeout_ms: u32) -> bool {
    true
}

fn watchdog_loop(app_data: std::path::PathBuf) {
    let mut consecutive_fail = 0u32;
    let mut dumped_for_this_hang = false;
    loop {
        std::thread::sleep(Duration::from_millis(2000));
        let hwnd = MAIN_HWND.load(Ordering::Relaxed) as isize;
        if hwnd == 0 {
            continue;
        }
        // 3s 超时：正常窗口毫秒级返回；繁忙也应在数百毫秒内回话。
        let responsive = probe_main_window(hwnd, 3000);
        if responsive {
            consecutive_fail = 0;
            dumped_for_this_hang = false;
            continue;
        }
        consecutive_fail += 1;
        mark("watchdog: WM_NULL timeout");
        if consecutive_fail >= 2 && !dumped_for_this_hang {
            dumped_for_this_hang = true;
            let path = write_dump(&app_data, consecutive_fail);
            if let Some(p) = path {
                eprintln!("[diag] 主窗口连续无响应，已写诊断日志: {}", p.display());
            }
        }
    }
}

/// 把探针缓冲与线程快照写入文件；返回写入路径。
fn write_dump(app_data: &std::path::Path, fail_count: u32) -> Option<std::path::PathBuf> {
    // 放运行数据根目录而非 logs/ 子目录：logs/ 由 prune_log_files 按数量滚动清理，可能被删。
    let _ = std::fs::create_dir_all(app_data);
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = app_data.join(format!("diag-hang_{stamp}.log"));
    let entries = LOG.lock().ok().map(|log| log.snapshot_newest());
    let out = render_dump(
        entries.as_deref(),
        fail_count,
        &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    );
    std::fs::write(&path, out).ok()?;
    Some(path)
}

/// 渲染诊断内容（纯函数，便于单测）；`entries = None` 表示探针缓冲锁未能取到。
/// `entries` 须按新→旧排列。
fn render_dump(entries: Option<&[Entry]>, fail_count: u32, at: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "=== Oh My Llama 假死诊断 dump ===\n时间: {at}\n主窗口连续无响应次数: {fail_count}\n探针启用: {}\n\n",
        enabled()
    ));
    out.push_str("--- 探针环形缓冲（新→旧，最多 64 条）---\n");
    match entries {
        Some(list) => {
            for e in list.iter().take(64) {
                out.push_str(&format!(
                    "  [{:>8}ms][tid {:>6}] {} {}\n",
                    e.at_ms, e.thread, e.kind, e.label
                ));
            }
        }
        None => out.push_str("  (探针缓冲锁被占用)\n"),
    }
    out.push_str("\n--- 进程内未结束的命令/标记（有 + 无 -）---\n");
    let pending = entries.map(pending_labels).unwrap_or_default();
    if pending.is_empty() {
        out.push_str("  (无未结束的 cmd；卡点可能不在探针覆盖范围内——见下一步排查建议)\n");
    } else {
        out.push_str(&pending.join("\n"));
        out.push('\n');
    }
    out.push_str("\n--- 采集说明 ---\n");
    out.push_str("探针覆盖：命令守卫（get_system_metrics / set_taskbar_metrics /\n");
    out.push_str(
        "taskbar_widget_ready / get_status / get_perf_stats / read_logs 等）、taskbar_widget 定位\n",
    );
    out.push_str(
        "线程每拍标记（widget_step / widget_theme_read / widget_set_size 等）、log 落盘。\n",
    );
    out.push_str("启用方式：环境变量 OML_DIAG=1 后重启应用；默认关闭。\n");
    out.push_str(
        "若卡点不在覆盖范围，可进一步用 F:\\llama_run\\_diag_dumps 下的脚本抓 minidump。\n",
    );
    out
}

/// 未配对（有进入无离开）的命令名，新的在前——假死卡点候选。
/// `entries` 须按新→旧排列：从最新往回扫，「已见离开」的标签视为结束。
fn pending_labels(entries: &[Entry]) -> Vec<String> {
    let mut ended: BTreeSet<&'static str> = BTreeSet::new();
    let mut pending: Vec<String> = Vec::new();
    for e in entries {
        match e.kind {
            "cmd_exit" => {
                ended.insert(e.label);
            }
            "cmd_enter" if !ended.contains(e.label) && pending.len() < 16 => {
                pending.push(format!(
                    "  [{:>8}ms][tid {:>6}] {} (未结束)",
                    e.at_ms, e.thread, e.label
                ));
            }
            _ => {}
        }
    }
    pending
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &'static str, label: &'static str) -> Entry {
        Entry {
            at_ms: 1,
            thread: 7,
            kind,
            label,
        }
    }

    /// 配对检测：已离开的守卫不算未结束；未离开的按时间倒序返回（新→旧输入）。
    #[test]
    fn pending_labels_pairs_enter_and_exit() {
        // 新→旧：cmd_c 进入, mark, cmd_b 进入, cmd_a 离开, cmd_a 进入
        let entries = vec![
            entry("cmd_enter", "cmd_c"),
            entry("mark", "watchdog: WM_NULL timeout"),
            entry("cmd_enter", "cmd_b"),
            entry("cmd_exit", "cmd_a"),
            entry("cmd_enter", "cmd_a"),
        ];
        let pending = pending_labels(&entries);
        assert_eq!(pending.len(), 2, "cmd_b / cmd_c 未结束: {pending:?}");
        assert!(pending[0].contains("cmd_c"), "新的在前: {pending:?}");
        assert!(pending[1].contains("cmd_b"), "{pending:?}");
    }

    /// 空缓冲与全配对时无候选。
    #[test]
    fn pending_labels_empty_when_all_closed() {
        assert!(pending_labels(&[]).is_empty());
        let closed = vec![entry("cmd_exit", "x"), entry("cmd_enter", "x")];
        assert!(pending_labels(&closed).is_empty());
    }

    /// 环形缓冲写满即覆盖最旧，容量恒定（结构性防内存增长）。
    #[test]
    fn ring_overwrites_oldest_and_stays_bounded() {
        let mut log = VisitLog::new();
        for i in 0..(MAX_ENTRIES + 44) {
            log.push(Entry {
                at_ms: i as u64,
                thread: 1,
                kind: "mark",
                label: "tick",
            });
        }
        assert_eq!(log.count, MAX_ENTRIES, "容量封顶");
        let newest = log.iter_newest().next().unwrap();
        assert_eq!(newest.at_ms, (MAX_ENTRIES + 43) as u64, "最新在首位");
        let oldest = log.iter_newest().last().unwrap();
        assert_eq!(oldest.at_ms, 44, "最旧的 0..44 已被覆盖");
    }

    /// dump 渲染：缓冲缺失（锁被占）时也要产出一份可读报告，不能 panic。
    #[test]
    fn render_dump_survives_missing_buffer() {
        let out = render_dump(None, 3, "2026-01-01 00:00:00");
        assert!(out.contains("探针缓冲锁被占用"), "{out}");
        assert!(out.contains("无未结束的 cmd"), "{out}");
    }
}
