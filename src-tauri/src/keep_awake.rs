//! 「阻止系统休眠」后端：三平台统一经 keepawake crate 调用系统原生电源管理 API。
//!
//! keepawake 0.6.1 的 Windows 实现在**调用线程**上直接执行
//! `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ...)`，并在 `Drop`
//! 时于**同一线程**复位此前状态。因此 guard 的创建与销毁必须落在同一个专用常驻
//! OS 线程上：本模块用一条懒启动的常驻线程独占 guard，外部只经 channel 下发
//! 「目标 (hold, display)」，绝不把 guard 交给静态 Mutex 让任意线程 Drop。
//!
//! Linux 的 `display = true` 会走 `ScreenSaver.Inhibit`，其 `Drop` 内有
//! `un_inhibit(cookie).unwrap()`，D-Bus 断开会在 Drop 内 panic；故销毁 guard 一律
//! 用 `catch_unwind` 包住，panic 只记日志、不掀翻常驻线程。
//!
//! Windows 会在**用户主动休眠**（开始菜单睡眠 / 合盖 / 电源键）时终止
//! `SetThreadExecutionState` 注册的电源请求（PowerSetRequest 文档明示）；恢复后进程
//! 原样唤醒、不走 `init_on_startup`，请求不会自动回来，而常驻线程的 `last` 幂等缓存
//! 仍记着「已持有」，任何后续下发都被短路。故 Windows 上常驻线程额外注册
//! `PowerRegisterSuspendResumeNotification`，收到恢复回调就绕过幂等、重建仍应持有的
//! guard（见 `win_resume` 与 `Cmd::Reassert`）。
//!
//! 定时时长只约束「手动开关」：「跟随服务」由服务启停决定，不受倒计时影响。计时放在
//! 独立的一次性线程里，不放在持有 guard 的常驻线程内——到期处理需要走 configure
//! （它会持 STATE 锁等 ack），若由常驻线程自己做会与调用方互等形成死锁。
//!
//! 生效是「先改运行时、再布计时、最后落盘」三段式：任一段失败都要把 guard 和计时
//! 回滚到操作前的真源，否则会出现「界面显示关闭、系统实际仍不休眠」的假状态。
//! 三段式与定时到期由 MANUAL_MUTEX 串行，避免已作废的旧计时线程用旧快照覆盖用户
//! 刚选的新设置。锁序固定为 MANUAL_MUTEX → STATE，configure 只拿 STATE，不成环。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::Duration;

/// 自定义时长的合法上限（分钟）：24 小时。0 是「永久」的哨兵值，不在输入范围内。
pub(crate) const MAX_MINUTES: i64 = 24 * 60;

/// 是否需要持有阻止休眠的 guard：手动开关优先，或「跟随服务」且（受管）服务正在运行。
pub(crate) fn should_hold(manual: bool, with_server: bool, server_running: bool) -> bool {
    manual || (with_server && server_running)
}

/// 校验自定义分钟数：0 保留给「永久」，负值保留给「关闭且沿用现值」，都不作输入。
pub(crate) fn valid_custom_minutes(minutes: i64) -> bool {
    (1..=MAX_MINUTES).contains(&minutes)
}

/// 已生效的用户偏好。configure 成功后写入，供 set_server_running 重算 hold。
#[derive(Clone, Copy)]
struct Prefs {
    manual: bool,
    with_server: bool,
    display: bool,
}

/// 偏好与服务运行态合用一把锁：两者都要据此重算 hold 并下发。若拆成两个独立状态，
/// 用户改开关与服务状态翻转并发时，后发的命令会用旧偏好算出过时的 hold 覆盖前者，
/// 使 guard 与落盘设置不符。所有状态变更与下发都在这把锁内串行完成。
struct State {
    prefs: Prefs,
    server_running: bool,
}

static STATE: Mutex<State> = Mutex::new(State {
    prefs: Prefs {
        manual: false,
        with_server: false,
        display: false,
    },
    server_running: false,
});

/// 串行化「手动开关三段式生效」与「定时到期」：两者都要读盘 → 改运行时 → 布计时 →
/// 落盘，交错会让旧快照覆盖新设置，或让已作废的到期处理把刚开启的 guard 关掉。
static MANUAL_MUTEX: Mutex<()> = Mutex::new(());

/// 常驻线程唯一入口，懒启动。Sender 放在 Mutex 里只为「首次启动」做一次性初始化。
static WORKER: LazyLock<Mutex<Option<Sender<Cmd>>>> = LazyLock::new(|| Mutex::new(None));

/// 每次重设时长都递增，让上一支计时线程醒来后自行作废，避免旧倒计时误关新设置。
static EXPIRY_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 下发给常驻线程的命令。ack 是一次性 channel（oneshot）：线程处理完回传结果。
enum Cmd {
    Configure {
        hold: bool,
        display: bool,
        ack: Sender<Result<(), String>>,
    },
    /// 系统睡眠/休眠恢复后，重建仍应持有的 guard（Windows 专用，见 `win_resume`）。
    /// 与 Configure 不同：不看目标是否变化，只要 `last` 记着持有就强制重建。
    #[cfg(windows)]
    Reassert { ack: Sender<Result<(), String>> },
}

/// 操作前的落盘真源快照：三段式生效任一步失败都据此回滚 guard 与计时线程。
#[derive(Clone, Copy)]
struct Snapshot {
    manual: bool,
    with_server: bool,
    display: bool,
    until: Option<i64>,
}

/// 锁被污染时取回内层值继续服务：一个 panic 不该让阻止休眠功能永久失效。
fn lock_state() -> MutexGuard<'static, State> {
    STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_manual() -> MutexGuard<'static, ()> {
    MANUAL_MUTEX
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 托盘子菜单的勾选真源：读 settings.json 的手动开关与上次时长。
pub(crate) fn manual_selection() -> (bool, i64) {
    crate::resolve_app_data()
        .map(|dir| {
            let s = crate::load_settings(&dir);
            (s.keep_awake_manual, s.keep_awake_duration_minutes)
        })
        .unwrap_or((false, 0))
}

/// 设置手动开关与时长（托盘时长项 / 自定义输入共用）。
/// `minutes < 0` = 沿用落盘里的上次时长（关闭与否由 enabled 决定，托盘「关闭」项
/// 即 `enabled=false, minutes=-1`）；0 = 永久；正数 = 定时分钟数。
/// 先让运行时生效、再布计时、最后整体读-改-写落盘，任一环节失败都整体回滚。
pub(crate) fn set_manual(enabled: bool, minutes: i64) -> Result<crate::AppSettings, String> {
    if enabled && minutes < 0 {
        return Err("开启时必须指定时长（0 表示永久，正数表示分钟数）。".to_string());
    }
    let _manual_guard = lock_manual();
    let app_data = crate::resolve_app_data()?;
    let mut settings = crate::load_settings(&app_data);
    let duration = if minutes >= 0 {
        minutes
    } else {
        settings.keep_awake_duration_minutes
    };
    // 0 是永久；正数必须是 1..=MAX_MINUTES；负数只可能来自被手改的 settings.json。
    if enabled && (duration < 0 || (duration > 0 && !valid_custom_minutes(duration))) {
        return Err(format!(
            "自定义时长必须在 1–{MAX_MINUTES} 分钟之间（0 表示永久）。"
        ));
    }
    let until = if enabled && duration > 0 {
        Some(chrono::Utc::now().timestamp() + duration * 60)
    } else {
        None
    };

    let snapshot = Snapshot {
        manual: settings.keep_awake_manual,
        with_server: settings.keep_awake_with_server,
        display: settings.keep_awake_display,
        until: settings.keep_awake_until,
    };

    configure(enabled, snapshot.with_server, snapshot.display)?;
    if let Err(err) = arm_expiry(until) {
        rollback_manual(snapshot);
        return Err(err);
    }

    settings.keep_awake_manual = enabled;
    settings.keep_awake_duration_minutes = duration;
    settings.keep_awake_until = until;
    if let Err(err) = crate::save_settings_json(&app_data, &settings) {
        rollback_manual(snapshot);
        return Err(err);
    }
    crate::sync_tray_keep_awake_check();
    Ok(settings)
}

/// 设置面板「跟随服务 / 保持屏幕常亮」两项偏好：与 set_manual 同为「先生效、
/// 再落盘」，任一步失败都整体回滚运行时。收口到本模块是为了让两个入口的失败
/// 语义一致——命令层只做转发，不各自实现半套回滚。持 MANUAL_MUTEX 保证不与
/// 定时到期处理交错改盘。
pub(crate) fn set_prefs(with_server: bool, display: bool) -> Result<crate::AppSettings, String> {
    let _manual_guard = lock_manual();
    let app_data = crate::resolve_app_data()?;
    let mut settings = crate::load_settings(&app_data);
    let snapshot = Snapshot {
        manual: settings.keep_awake_manual,
        with_server: settings.keep_awake_with_server,
        display: settings.keep_awake_display,
        until: settings.keep_awake_until,
    };
    if let Err(err) = configure(snapshot.manual, with_server, display) {
        restore_state(snapshot);
        return Err(err);
    }
    settings.keep_awake_with_server = with_server;
    settings.keep_awake_display = display;
    if let Err(err) = crate::save_settings_json(&app_data, &settings) {
        // 运行时已生效但没落盘：复位 guard / prefs，否则界面回滚后系统仍按新偏好
        // 持有 guard，且 set_server_running 状态未变时不重发，漂移不会自行收敛。
        restore_state(snapshot);
        return Err(err);
    }
    Ok(settings)
}

/// 硬复位运行时到操作前快照：与 configure 不同，这里无条件把 STATE.prefs 写回
/// snapshot 并直接 dispatch 复位 guard，不依赖「调用前 prefs」推导回滚目标。
/// 回滚发生在第一次 configure 已成功之后，那时 prefs 已是新值，若走 configure
/// 的 previous_hold 推导会把 guard 拉回「开启后」而非「操作前」。
fn restore_state(snapshot: Snapshot) {
    let result = {
        let mut state = lock_state();
        let hold = should_hold(snapshot.manual, snapshot.with_server, state.server_running);
        state.prefs = Prefs {
            manual: snapshot.manual,
            with_server: snapshot.with_server,
            display: snapshot.display,
        };
        dispatch(hold, snapshot.display)
    };
    if let Err(err) = result {
        eprintln!("[keep-awake] 复位运行时状态失败: {err}");
    }
}

/// 三段式生效的后半段失败：先把 guard 与 prefs 拉回操作前，再作废刚布下的计时、
/// 恢复操作前那支，最后让托盘勾选态回读落盘。全程不写盘——落盘失败时盘上本就是
/// 操作前的值。顺序不可颠倒：MANUAL_MUTEX 由 set_manual 持有，新计时线程要等本次
/// 操作结束才进 expire_manual，先回滚 guard 就不会与到期解除交错。
fn rollback_manual(snapshot: Snapshot) {
    restore_state(snapshot);
    if let Err(err) = arm_expiry(snapshot.until) {
        eprintln!("[keep-awake] 回滚计时线程失败: {err}");
    }
    crate::sync_tray_keep_awake_check();
}

/// 布一支一次性计时线程。用墙上时钟（Unix 秒）循环校正剩余时间：系统休眠/时间被
/// 调整后醒来，不会按「睡了多久」误判，而是重新按真实到期时间结算。
/// 每次调用都先递增 generation：即使本支线程创建失败，旧计时线程也已作废。
fn arm_expiry(until: Option<i64>) -> Result<(), String> {
    let generation = EXPIRY_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let Some(until) = until else {
        return Ok(());
    };
    std::thread::Builder::new()
        .name("keep-awake-expiry".to_string())
        .spawn(move || {
            loop {
                if EXPIRY_GENERATION.load(Ordering::SeqCst) != generation {
                    return;
                }
                // saturating_sub：settings.json 被手改成极端值时也不在减法上溢出。
                let remaining = until.saturating_sub(chrono::Utc::now().timestamp());
                if remaining <= 0 {
                    break;
                }
                // 分片 sleep：被新设置作废后最多 60 秒就能退出，不留下长期空转线程；
                // 每片重新按墙上时钟算剩余，系统休眠 / 时间调整后也不会误判。
                std::thread::sleep(Duration::from_secs(remaining.min(60) as u64));
            }
            if EXPIRY_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            expire_manual(generation, until);
        })
        .map_err(|err| format!("启动阻止休眠计时线程失败: {err}"))?;
    Ok(())
}

/// 定时到期：只把手动开关关掉，跟随服务仍按服务状态照常生效。
/// 与 set_manual 共用 MANUAL_MUTEX：拿到锁后再复查 generation 与落盘的 until，
/// 期间用户若改过设置，这支线程就已作废，直接退出，由那次操作自己收敛。
fn expire_manual(generation: u64, expected_until: i64) {
    let _manual_guard = lock_manual();
    if EXPIRY_GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    let Ok(app_data) = crate::resolve_app_data() else {
        return;
    };
    let mut settings = crate::load_settings(&app_data);
    if !settings.keep_awake_manual || settings.keep_awake_until != Some(expected_until) {
        return;
    }
    if chrono::Utc::now().timestamp() < expected_until {
        // 墙上时钟被往回调：重新布一次计时，否则这次「提前醒来」会把计时线程弄丢。
        if let Err(err) = arm_expiry(Some(expected_until)) {
            eprintln!("[keep-awake] 重新布置计时线程失败: {err}");
        }
        return;
    }
    if let Err(err) = configure(
        false,
        settings.keep_awake_with_server,
        settings.keep_awake_display,
    ) {
        eprintln!("[keep-awake] 定时到期解除失败: {err}");
        return;
    }
    // 重新读盘再落盘：设置面板可能在此期间改过 with_server / display，别用旧快照
    // 抹掉那两个字段（AppSettings 是整体读-改-写）。
    settings = crate::load_settings(&app_data);
    settings.keep_awake_manual = false;
    settings.keep_awake_until = None;
    if let Err(err) = crate::save_settings_json(&app_data, &settings) {
        eprintln!("[keep-awake] 定时到期落盘失败: {err}");
    }
    crate::sync_tray_keep_awake_check();
}

/// 用户操作入口：算目标 hold、下发配置，并同步等常驻线程回传结果。
/// 只有运行时确实生效成功才返回 Ok（调用方据此落盘；失败则回滚、不落盘）。
pub(crate) fn configure(manual: bool, with_server: bool, display: bool) -> Result<(), String> {
    let mut state = lock_state();
    let hold = should_hold(manual, with_server, state.server_running);
    let previous_hold = should_hold(
        state.prefs.manual,
        state.prefs.with_server,
        state.server_running,
    );
    let previous_display = state.prefs.display;
    if let Err(err) = dispatch(hold, display) {
        // 常驻线程可能已经复位旧 guard 却没建成新的：尽力把 guard 拉回操作前状态，
        // 不让一次创建失败在「界面已回滚」的情况下留下无保护或多余保护。
        if let Err(restore) = dispatch(previous_hold, previous_display) {
            eprintln!("[keep-awake] 回滚 guard 失败: {restore}");
        }
        return Err(err);
    }
    // 生效失败时不更新缓存：调用方同样不落盘，二者保持一致。
    state.prefs = Prefs {
        manual,
        with_server,
        display,
    };
    Ok(())
}

/// 服务运行状态同步：状态未变时立即返回，不发 channel、不等 ack（get_status
/// 每 1.5s 调用一次，避免无谓阻塞）。失败只记日志，不向轮询调用方传播。
pub(crate) fn set_server_running(running: bool) {
    let mut state = lock_state();
    if state.server_running == running {
        return;
    }
    let previous = state.server_running;
    state.server_running = running;
    let prefs = state.prefs;
    let hold = should_hold(prefs.manual, prefs.with_server, running);
    if let Err(err) = dispatch(hold, prefs.display) {
        // 回退内部标记：下一轮 1.5s 轮询会重新下发，避免一次失败让状态永久漂移。
        state.server_running = previous;
        eprintln!("[keep-awake] 同步服务运行状态失败: {err}");
    }
}

/// setup 阶段调用：先按落盘的到期时间判是否已过期（过期就修正落盘、不恢复），
/// 再灌入偏好缓存、恢复 guard，最后按剩余时间重布计时线程。
pub(crate) fn init_on_startup() {
    let Ok(app_data) = crate::resolve_app_data() else {
        return;
    };
    let mut settings = crate::load_settings(&app_data);
    if settings.keep_awake_manual {
        if let Some(until) = settings.keep_awake_until {
            if chrono::Utc::now().timestamp() >= until {
                settings.keep_awake_manual = false;
                settings.keep_awake_until = None;
                if let Err(err) = crate::save_settings_json(&app_data, &settings) {
                    eprintln!("[keep-awake] 清理已过期的定时设置失败: {err}");
                }
                // 托盘菜单在 setup 里先于本函数按旧落盘值建好，修正后必须把勾选态
                // 一起拉回真源，否则会残留「已开启」的勾。
                crate::sync_tray_keep_awake_check();
            }
        }
    }

    {
        let mut state = lock_state();
        state.prefs = Prefs {
            manual: settings.keep_awake_manual,
            with_server: settings.keep_awake_with_server,
            display: settings.keep_awake_display,
        };
        if state.prefs.manual {
            let hold = should_hold(state.prefs.manual, state.prefs.with_server, false);
            if let Err(err) = dispatch(hold, state.prefs.display) {
                eprintln!("[keep-awake] 启动时恢复阻止休眠失败: {err}");
            }
        }
    }
    // 计时线程的到期处理会走 configure（拿 STATE 锁），故必须在释放 STATE 锁之后再布；
    // 也只在手动开关确实开着时才需要计时。
    if settings.keep_awake_manual {
        if let Err(err) = arm_expiry(settings.keep_awake_until) {
            eprintln!("[keep-awake] 启动时恢复定时失败: {err}");
        }
    }
}

/// 下发 Configure 并同步等常驻线程回传结果。
fn dispatch(hold: bool, display: bool) -> Result<(), String> {
    dispatch_cmd(|ack| Cmd::Configure { hold, display, ack })
}

/// 系统恢复后让常驻线程重建仍应持有的 guard（Windows 专用）。
#[cfg(windows)]
fn dispatch_reassert() -> Result<(), String> {
    dispatch_cmd(|ack| Cmd::Reassert { ack })
}

/// 系统从睡眠/休眠恢复后调用（Windows 专用）：用户主动休眠会终止电源请求，恢复后
/// 进程原样唤醒、不走 init_on_startup，须让常驻线程把仍应持有的 guard 重建一次。
/// 回调运行在线程池线程，只负责下发命令；guard 的创建/销毁仍由常驻线程独占。
#[cfg(windows)]
fn reassert_on_resume() {
    if let Err(err) = dispatch_reassert() {
        eprintln!("[keep-awake] 系统恢复后重建阻止休眠失败: {err}");
    }
}

/// 懒启动常驻线程，下发 make_cmd 构造的命令并同步等 ack。channel 断开一律视为失败；
/// 常驻线程意外退出时清掉死 Sender 并重新拉起一条，避免一次意外让功能永久失效。
fn dispatch_cmd(make_cmd: impl Fn(Sender<Result<(), String>>) -> Cmd) -> Result<(), String> {
    for attempt in 0..2 {
        let sender = ensure_worker()?;
        let (ack_tx, ack_rx) = mpsc::channel();
        match sender.send(make_cmd(ack_tx)) {
            Ok(()) => {
                return ack_rx
                    .recv()
                    .unwrap_or_else(|_| Err("阻止休眠常驻线程未回传确认".to_string()));
            }
            Err(_) if attempt == 0 => {
                *WORKER
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
            }
            Err(_) => return Err("阻止休眠常驻线程已退出，无法下发配置".to_string()),
        }
    }
    Err("阻止休眠常驻线程无法恢复".to_string())
}

fn ensure_worker() -> Result<Sender<Cmd>, String> {
    let mut slot = WORKER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_none() {
        let (tx, rx) = mpsc::channel::<Cmd>();
        std::thread::Builder::new()
            .name("keep-awake".to_string())
            .spawn(move || run_worker(rx))
            .map_err(|err| format!("启动阻止休眠常驻线程失败: {err}"))?;
        *slot = Some(tx);
    }
    match slot.as_ref() {
        Some(tx) => Ok(tx.clone()),
        None => Err("阻止休眠常驻线程未就绪".to_string()),
    }
}

/// 常驻线程主体：独占 guard，按「目标 (hold, display)」幂等地创建/销毁。
/// Windows 上额外注册系统恢复通知，收到恢复回调时经 `Cmd::Reassert` 强制重建。
fn run_worker(rx: mpsc::Receiver<Cmd>) {
    let mut guard: Option<keepawake::KeepAwake> = None;
    // 上次成功下发的目标；初始 (false, false) 对应「无 guard」。
    let mut last: (bool, bool) = (false, false);
    #[cfg(windows)]
    let resume_notify = win_resume::register();
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Configure { hold, display, ack } => {
                let target = (hold, display);
                let result = if target == last {
                    Ok(())
                } else {
                    // 必须先销毁旧 guard 再建新的：Windows 的 ES_CONTINUOUS 是「设置」
                    // 语义，先建后销毁会把新设置复位掉；也绝不能同时持有两把 guard。
                    drop_guard(&mut guard);
                    if hold {
                        match create_guard(display) {
                            Ok(g) => {
                                guard = Some(g);
                                last = target;
                                Ok(())
                            }
                            Err(err) => {
                                // 旧 guard 已复位、新 guard 未建成：当前实际无保护，
                                // 靠下一次状态翻转或用户再次操作收敛。
                                last = (false, false);
                                Err(err)
                            }
                        }
                    } else {
                        last = target;
                        Ok(())
                    }
                };
                let _ = ack.send(result);
            }
            #[cfg(windows)]
            Cmd::Reassert { ack } => {
                // 系统已在主动休眠时清掉电源请求，但 last 仍记着「持有」：绕过幂等
                // 直接重建。last 未持有则无可重建，直接成功返回。
                let result = if last.0 {
                    drop_guard(&mut guard);
                    match create_guard(last.1) {
                        Ok(g) => {
                            guard = Some(g);
                            Ok(())
                        }
                        Err(err) => {
                            last = (false, false);
                            Err(err)
                        }
                    }
                } else {
                    Ok(())
                };
                let _ = ack.send(result);
            }
        }
    }
    // 线程随进程退出；系统侧会自动释放各平台电源断言，此处仅兜底走一次安全 Drop。
    drop_guard(&mut guard);
    #[cfg(windows)]
    if let Some(handle) = resume_notify {
        win_resume::unregister(handle);
    }
}

/// 只用 idle（阻止系统空闲休眠）+ 可选 display（保持屏幕常亮），绝不用 sleep。
fn create_guard(display: bool) -> Result<keepawake::KeepAwake, String> {
    keepawake::Builder::default()
        .idle(true)
        .display(display)
        .reason("Oh My Llama")
        .app_name("Oh My Llama")
        .app_reverse_domain("app.ohmyllama")
        .create()
        .map_err(|err| format!("创建阻止休眠 guard 失败: {err}"))
}

/// 销毁 guard：Linux display=true 时 KeepAwake::drop 内 un_inhibit().unwrap() 会在
/// D-Bus 断开时 panic，必须用 catch_unwind 包住，避免掀翻常驻线程。
fn drop_guard(guard: &mut Option<keepawake::KeepAwake>) {
    if let Some(g) = guard.take() {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(g))).is_err() {
            eprintln!("[keep-awake] 释放阻止休眠 guard 时发生 panic（已忽略）");
        }
    }
}

/// Windows 电源通知：用户主动休眠（开始菜单睡眠 / 合盖 / 电源键）会终止
/// `SetThreadExecutionState` 注册的电源请求（PowerSetRequest 文档明示），恢复后不会
/// 自动重建。这里注册恢复回调，唤醒时让常驻线程重新断言。回调运行在线程池线程，只
/// 负责下发命令；guard 仍由常驻线程独占（`SetThreadExecutionState` 线程绑定）。
#[cfg(windows)]
mod win_resume {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    };

    unsafe extern "system" fn on_resume(
        _context: *const c_void,
        kind: u32,
        _setting: *const c_void,
    ) -> u32 {
        if kind == PBT_APMRESUMEAUTOMATIC || kind == PBT_APMRESUMESUSPEND {
            super::reassert_on_resume();
        }
        0
    }

    /// 注册恢复通知；失败只记日志（阻止休眠仍按原逻辑工作，只是失去恢复自愈）。
    pub(super) fn register() -> Option<HANDLE> {
        let mut handle: *mut c_void = std::ptr::null_mut();
        let recipient = on_resume as *const c_void as HANDLE;
        let err = unsafe {
            PowerRegisterSuspendResumeNotification(DEVICE_NOTIFY_CALLBACK, recipient, &mut handle)
        };
        if err == ERROR_SUCCESS {
            Some(handle)
        } else {
            eprintln!("[keep-awake] 注册系统恢复通知失败（错误码 {err}），休眠恢复后不会自动重建");
            None
        }
    }

    pub(super) fn unregister(handle: HANDLE) {
        unsafe {
            PowerUnregisterSuspendResumeNotification(handle as isize);
        }
    }
}
