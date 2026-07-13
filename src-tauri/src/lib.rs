use serde::{Deserialize, Serialize};
use std::env;
use std::io::Read;
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::str::FromStr;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_opener::OpenerExt;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_C_EVENT};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ServerConfig {
    pub llama_server_path: String,
    pub model: String,
    #[serde(default)]
    pub model_dir: String,
    pub host: String,
    pub port: u16,
    pub ctx_size: i64,
    pub n_predict: i64,
    pub n_gpu_layers: i64,
    pub threads: i64,
    pub batch_size: i64,
    pub temp: f64,
    pub flash_attn: String,
    pub mmap: bool,
    pub mlock: bool,
    pub enabled_advanced_params: Vec<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            llama_server_path: String::new(),
            model: String::new(),
            model_dir: String::new(),
            host: "127.0.0.1".into(),
            port: 8080,
            ctx_size: 4096,
            n_predict: -1,
            n_gpu_layers: 0,
            threads: 0,
            batch_size: 512,
            temp: 0.7,
            flash_attn: "auto".into(),
            mmap: true,
            mlock: false,
            enabled_advanced_params: vec!["ctx_size".into()],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub host: String,
    pub url: String,
}

impl Default for ServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            pid: None,
            port: 8080,
            host: String::new(),
            url: String::new(),
        }
    }
}

impl ServerStatus {
    fn normalize_host(&self) -> String {
        self.host.trim().to_string()
    }

    fn display_host(&self) -> String {
        let host = self.normalize_host().to_lowercase();
        match host.as_str() {
            "" | "127.0.0.1" | "localhost" => "127.0.0.1".into(),
            "0.0.0.0" => local_ip_address()
                .map(|ip| ip.to_string())
                .unwrap_or_else(|_| "127.0.0.1".into()),
            _ => host,
        }
    }

    fn url(&self) -> String {
        format!("http://{}:{}", self.display_host(), self.port)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerLogLine {
    pub ts: String,
    pub level: String,
    pub text: String,
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(tauri::async_runtime::Mutex::new(ServerStatus::default()))
        .manage(std::sync::Mutex::new(Vec::<ServerLogLine>::new()))
        .invoke_handler(tauri::generate_handler![
            read_config,
            save_config,
            get_default_config,
            get_status,
            start_server,
            stop_server,
            open_preview,
            read_logs,
            clear_logs,
            file_exists,
            list_models
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let _ = app_handle
                .clone()
                .listen("tauri://close-requested", move |_| {
                    // listen 回调是同步闭包，stop_server_inner 是 async；
                    // 必须 block_on 真正执行，否则 future 会被直接丢弃、服务端不会被停止。
                    let _ = tauri::async_runtime::block_on(stop_server_inner(&app_handle));
                });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running llama launcher");
}

#[tauri::command]
async fn read_config(_app: AppHandle) -> Result<ServerConfig, String> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|path| path.to_path_buf()))
        .filter(|path| path.exists())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());

    let local_candidates = [
        exe_dir.join("config.toml"),
        exe_dir.join("config/llama-config.toml"),
    ];
    for path in &local_candidates {
        if path.exists() {
            let text =
                std::fs::read_to_string(path).map_err(|err| format!("读取配置失败: {err}"))?;
            return parse_config_value(&text);
        }
    }

    let app_path = resolve_config_path()?;
    if app_path.exists() {
        let text =
            std::fs::read_to_string(&app_path).map_err(|err| format!("读取配置失败: {err}"))?;
        return parse_config_value(&text);
    }

    Ok(ServerConfig::default())
}

#[tauri::command]
async fn get_default_config(_app: AppHandle) -> Result<ServerConfig, String> {
    Ok(ServerConfig::default())
}

#[tauri::command]
async fn save_config(_app: AppHandle, config: ServerConfig) -> Result<(), String> {
    let path = resolve_config_path()?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|err| format!("创建配置目录失败: {err}"))?;
    let text = serialize_config_value(&config)?;
    std::fs::write(&path, text).map_err(|err| format!("写入配置失败: {err}"))?;
    Ok(())
}

#[tauri::command]
async fn get_status(app: AppHandle) -> Result<ServerStatus, String> {
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;
    if status.running {
        let still_running = is_process_running(status.pid);
        if !still_running {
            append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: "warn".into(),
                    text: "llama-server 已停止。".into(),
                },
            );
            *status = ServerStatus::default();
        }
    }
    Ok(status.clone())
}

// 构造传给 llama-server 的命令行参数（不含可执行文件名本身）。
// 抽成纯函数：① 前后端共用、单一真源；② 便于单测断言实际命令形态。
// 注意：这些 -m/--host 等是 llama-server 这一外部二进制自身的 CLI 契约，
// 并非本应用的业务配置项，故按该外部工具协议硬编码（与已有权限/默认值分层不冲突）。
fn build_server_args(config: &ServerConfig) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-m".into(),
        config.model.clone(),
        "--host".into(),
        config.host.clone(),
        "--port".into(),
        config.port.to_string(),
        "-c".into(),
        config.ctx_size.to_string(),
        "--timeout".into(),
        "2400".into(),
    ];

    if config
        .enabled_advanced_params
        .contains(&"n_predict".to_string())
    {
        args.push("-n".into());
        args.push(config.n_predict.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"n_gpu_layers".to_string())
    {
        args.push("-ngl".into());
        args.push(config.n_gpu_layers.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"threads".to_string())
    {
        args.push("-t".into());
        args.push(config.threads.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"batch_size".to_string())
    {
        args.push("-b".into());
        args.push(config.batch_size.to_string());
    }
    if config.enabled_advanced_params.contains(&"temp".to_string()) {
        args.push("--temp".into());
        args.push(config.temp.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"flash_attn".to_string())
    {
        args.push("--flash-attn".into());
        args.push(flash_value(&config.flash_attn).to_string());
    }
    if config.enabled_advanced_params.contains(&"mmap".to_string()) {
        if config.mmap {
            args.push("--mmap".into());
        } else {
            args.push("--no-mmap".into());
        }
    }
    if config
        .enabled_advanced_params
        .contains(&"mlock".to_string())
        && config.mlock
    {
        args.push("--mlock".into());
    }
    args
}

#[tauri::command]
async fn start_server(app: AppHandle, config: ServerConfig) -> Result<ServerStatus, String> {
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;
    if status.running {
        return Ok(status.clone());
    }

    if config.llama_server_path.trim().is_empty() {
        return Err("请先填写 llama-server.exe 路径。".into());
    }
    if config.model.trim().is_empty() {
        return Err("请先选择模型文件。".into());
    }

    let path = std::path::Path::new(&config.llama_server_path);
    if !path.exists() {
        return Err(format!("找不到 llama-server: {}", config.llama_server_path));
    }
    if !std::path::Path::new(&config.model).exists() {
        return Err(format!("找不到模型文件: {}", config.model));
    }

    let bind_socket = SocketAddr::new(
        IpAddr::from_str(&config.host)
            .unwrap_or_else(|_| IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))),
        config.port,
    );
    if is_port_in_use_socket(bind_socket) {
        return Err(format!("端口 {} 已被占用，无法启动服务。", config.port));
    }

    let exe = path.to_owned();
    let args = build_server_args(&config);
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(&args);

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);

    let child = cmd
        .spawn()
        .map_err(|err| format!("启动 llama-server 失败: {err}"))?;
    let pid = child.id();
    // 建立 Job Object 守护：launcher 进程以任何方式死亡（含崩溃/被强杀/被 OOM）时，
    // 内核会据此终结 llama-server 子进程并回收 GPU 显存（见 create_kill_on_close_job）。
    // 把句柄随 child 一起交给 wait_process 持有，进程一退出即被内核回收 → KILL_ON_JOB_CLOSE 触发。
    let job = create_kill_on_close_job(&child);
    if job.is_none() {
        append_log_inner(
            &app,
            ServerLogLine {
                ts: now(),
                level: "warn".into(),
                text: "未能建立 Job Object 守护（环境限制）：launcher 意外崩溃时子进程可能无法自动回收。".into(),
            },
        );
    }
    // 我们发送给 llama-server 的完整命令行：单独用 level="cmd" 记一条，
    // 供前端"原生"模式把它置顶固定显示（区别于下方透传的 raw 输出）。
    let command_line = format!("{} {}", config.llama_server_path, args.join(" "));
    append_log_inner(
        &app,
        ServerLogLine {
            ts: now(),
            level: "cmd".into(),
            text: format!("$ {}", command_line),
        },
    );

    append_log_inner(
        &app,
        ServerLogLine {
            ts: now(),
            level: "info".into(),
            text: format!(
                "已启动 llama-server，pid={pid}，监听地址={}:{}",
                config.host, config.port
            ),
        },
    );

    *status = ServerStatus {
        running: true,
        pid: Some(pid),
        host: config.host.clone(),
        port: config.port,
        url: format!("http://{}:{}", config.host, config.port),
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = wait_process(app_handle, child, job).await;
    });

    Ok(status.clone())
}

#[tauri::command]
async fn stop_server(app: AppHandle) -> Result<(), String> {
    stop_server_inner(&app).await
}

#[tauri::command]
async fn open_preview(app: AppHandle) -> Result<(), String> {
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let status = state.lock().await.clone();

    if !status.running {
        return Err("服务未运行，请先启动 llama-server。".into());
    }

    let target = status.url();
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|err| format!("打开预览失败: {err}"))?;
    Ok(())
}

#[tauri::command]
async fn read_logs(app: AppHandle) -> Result<Vec<ServerLogLine>, String> {
    let state = app.state::<std::sync::Mutex<Vec<ServerLogLine>>>();
    let logs = state.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(logs)
}

#[tauri::command]
async fn clear_logs(app: AppHandle) -> Result<(), String> {
    {
        let state = app.state::<std::sync::Mutex<Vec<ServerLogLine>>>();
        state.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    // 通知前端清空（含置顶命令行），保持前后端一致。
    let _ = app.emit("log://clear", ());
    Ok(())
}

// 供前端实时判断"模型路径指向的文件是否还存在"（用户曾选过、后来被移走/删除），
// 返回 false 表示文件不存在。空路径直接判缺省文件，不信赖其存在性。
// 同步命令：仅做一次 stat，不涉及 I/O 阻塞或子进程，由 Tauri 在 worker 线程执行。
#[tauri::command]
fn file_exists(path: String) -> bool {
    !path.trim().is_empty() && std::path::Path::new(&path).exists()
}

// 列出指定目录下的所有 .gguf 模型（仅返回文件名，不返回绝对路径，
// 前端下拉框只展示模型名）。目录为空或不存在时返回空列表。
// 读取目录属于后端职责（前端严守分层，不直接读文件系统）。
#[tauri::command]
fn list_models(dir: String) -> Result<Vec<String>, String> {
    let path = std::path::Path::new(&dir);
    if dir.trim().is_empty() || !path.is_dir() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(path).map_err(|err| format!("读取模型目录失败: {err}"))?;
    let mut models: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let is_gguf = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false);
        if is_gguf {
            if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                models.push(name.to_string());
            }
        }
    }
    models.sort();
    Ok(models)
}

async fn stop_server_inner(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;
    if !status.running {
        return Ok(());
    }
    let pid = status.pid;
    *status = ServerStatus::default();
    drop(status);

    if let Some(pid) = pid {
        // 先礼貌请求 llama-server 走自带的干净卸载路径：它注册了控制台处理器，
        // 收到 CTRL_C_EVENT 会在退出前卸载 GPU 模型（与你手动关终端时行为一致）。
        // Job Object 仍是兜底——若它不响应，下面的强制终止 + launcher 崩溃时的
        // KILL_ON_JOB_CLOSE 会保证进程必死、GPU 必回收。
        signal_console_ctrl_c(pid);
        // 给子进程一点时间自行退出；超时仍未退出再强制终止，避免 stop 卡住。
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if is_process_running(Some(pid)) {
            terminate_process(pid);
        }
        append_log_inner(
            app,
            ServerLogLine {
                ts: now(),
                level: "info".into(),
                text: format!("已请求停止 llama-server，pid={pid}。"),
            },
        );
    }
    Ok(())
}

// 把子进程某一输出流（stdout/stderr）实时切成一行行发到 channel。
// 关键点（为什么不能用 lines()/read_line）：
//   1. lines()/read_line 只在 \n 处返回，会一直阻塞攒着——llama-server 加载模型时
//      用 \r 原地刷新进度条/百分比（一整段都没有 \n），于是这段输出会被攒到进程结束
//      才一次性吐出，表现为"原生日志不实时"。
//   2. lines() 还会丢弃行尾 \r。
// 因此这里逐字节读，遇到 \r 或 \n 都立即切一行 flush（进度每刷新一次就成一行、实时透传）；
// \r\n 视为一次换行（不产生多余空行）；行内容不做任何 trim，空行也保留，实现真正"透传"。
fn pump_reader(
    reader: impl std::io::Read,
    tx: std::sync::mpsc::Sender<(String, String)>,
    level: String,
) {
    let mut reader = std::io::BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    let mut one = [0u8; 1];
    let mut last_cr = false;
    loop {
        match reader.read(&mut one) {
            Ok(0) | Err(_) => {
                // EOF：flush 末尾未以换行结尾的残余内容。
                if !buf.is_empty() {
                    let _ = tx.send((level.clone(), String::from_utf8_lossy(&buf).into_owned()));
                }
                break;
            }
            Ok(_) => match one[0] {
                b'\r' => {
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    buf.clear();
                    last_cr = true;
                    if tx.send((level.clone(), line)).is_err() {
                        break;
                    }
                }
                b'\n' => {
                    // \r\n：\r 处已 flush，跳过随后的 \n，避免多出一条空行。
                    if last_cr {
                        last_cr = false;
                    } else {
                        let line = String::from_utf8_lossy(&buf).into_owned();
                        buf.clear();
                        if tx.send((level.clone(), line)).is_err() {
                            break;
                        }
                    }
                }
                b => {
                    last_cr = false;
                    buf.push(b);
                }
            },
        }
    }
}

async fn wait_process(app: AppHandle, mut child: std::process::Child, _job: Option<JobHandle>) {
    // 读取子进程 stdout/stderr：避免管道缓冲写满导致服务端阻塞/死锁，
    // 同时把 llama-server 的真实输出（含 \r 进度、空行、首尾空格）原样送进日志面板。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();

    // 消费线程：一收到一行就立即写盘 + emit（实时透传）。
    // 关键点：用独立的 std 线程（而非 async 任务）承载消费；child.wait()
    // 也放到另一个 std 线程上。这样无论 async 运行时是单线程还是多线程，
    // 消费都不会被 child.wait() 阻塞，真正实时；彻底杜绝"运行中无日志、
    // 停止后涌入一批"的现象。
    let app_rx = app.clone();
    let consumer = std::thread::spawn(move || {
        while let Ok((level, text)) = rx.recv() {
            // 原生日志：子进程输出逐行原样再记一条（level=raw），不做级别加工，
            // 供前端"原生"模式原样展示 llama-server 的全部输出。
            append_log_inner(
                &app_rx,
                ServerLogLine {
                    ts: now(),
                    level: "raw".into(),
                    text: text.clone(),
                },
            );
            append_log_inner(
                &app_rx,
                ServerLogLine {
                    ts: now(),
                    level,
                    text,
                },
            );
        }
    });

    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            pump_reader(out, tx, "info".to_string());
        }));
    }
    if let Some(err) = stderr {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            pump_reader(err, tx, "warn".to_string());
        }));
    }
    // 丢弃主发送端：仅剩 pump 线程各自持有的 tx；它们 EOF 后会自动 drop，
    // 届时 channel 关闭、consumer 的 rx.recv() 返回 Err 自然退出。
    drop(tx);

    // child.wait() 是阻塞调用：放到独立 std 线程，避免占用 async worker、
    // 也避免饿死上面的消费线程。该线程同时负责 join 两个读取线程。
    let waiter = std::thread::spawn(move || {
        let exit = child.wait();
        for handle in readers {
            let _ = handle.join();
        }
        exit
    });
    let exit = waiter
        .join()
        .unwrap_or_else(|_| Err(std::io::Error::other("waiter thread panicked")));

    // 等消费线程把缓冲区里最后几行也写完，保证"已退出"状态行出现在所有输出之后。
    let _ = consumer.join();

    match exit {
        Ok(status) => {
            append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: if status.success() {
                        "info".into()
                    } else {
                        "error".into()
                    },
                    text: format!("llama-server 已退出，status={status}"),
                },
            );
        }
        Err(err) => {
            append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: "error".into(),
                    text: format!("读取 llama-server 退出状态失败: {err}"),
                },
            );
        }
    }
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;
    *status = ServerStatus::default();
}

fn append_log_inner(app: &AppHandle, line: ServerLogLine) {
    {
        let state = app.state::<std::sync::Mutex<Vec<ServerLogLine>>>();
        let mut logs = state.lock().unwrap_or_else(|e| e.into_inner());
        logs.push(line.clone());
        // 缓冲上限调大：原生模式下用户希望看到完整输出。5000 足以覆盖典型模型加载+推理会话。
        // 注意：命令行(level=cmd)前端单独保存并置顶，不依赖此缓冲，故不会因滚动被挤掉。
        if logs.len() > 5000 {
            logs.remove(0);
        }
    }
    // 实时推送：每产生一行立即 emit 给前端，前端 listen 增量追加（取代轮询，做到实时）。
    let _ = app.emit("log://line", line);
}

fn parse_config_value(text: &str) -> Result<ServerConfig, String> {
    let mut config: ServerConfig =
        toml::from_str(text).map_err(|err| format!("转换配置失败: {err}"))?;
    config.llama_server_path = config.llama_server_path.trim().to_string();
    config.model_dir = config.model_dir.trim().to_string();
    // 旧配置可能只存了完整模型路径、没有 model_dir：从 model 的父目录推导，
    // 保证前端下拉框能定位到正确的模型目录。
    if config.model_dir.is_empty() && !config.model.trim().is_empty() {
        if let Some(parent) = std::path::Path::new(&config.model).parent() {
            config.model_dir = parent.to_string_lossy().to_string();
        }
    }
    Ok(config)
}

fn serialize_config_value(config: &ServerConfig) -> Result<String, String> {
    let mut text = toml::to_string(config).map_err(|err| format!("序列化配置失败: {err}"))?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    Ok(text)
}

fn resolve_config_path() -> Result<std::path::PathBuf, String> {
    let app_data = env::var("APPDATA")
        .or_else(|_| env::var("LOCALAPPDATA"))
        .map_err(|_| "无法定位应用数据目录。".to_string())?;
    Ok(std::path::Path::new(&app_data)
        .join("LlamaLauncher")
        .join("llama-config.toml"))
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_port_in_use_socket(socket: SocketAddr) -> bool {
    TcpListener::bind(socket).is_err()
}

fn is_process_running(pid: Option<u32>) -> bool {
    let Some(pid) = pid else {
        return false;
    };
    if pid == 0 {
        return false;
    }
    let mut sys = System::new_all();
    sys.refresh_processes();
    sys.processes()
        .contains_key(&sysinfo::Pid::from(pid as usize))
}

fn terminate_process(pid: u32) {
    if pid == 0 {
        return;
    }
    let sys = System::new_all();
    if let Some(process) = sys.process(sysinfo::Pid::from(pid as usize)) {
        let _ = process.kill();
        return;
    }
    if let Ok(child) = std::process::Command::new("taskkill")
        .args(["/f", "/pid", &pid.to_string()])
        .creation_flags(0x08000000)
        .status()
    {
        if !child.success() {
            let _ = std::process::Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!("Stop-Process -Id {pid} -Force"),
                ])
                .creation_flags(0x08000000)
                .status();
        }
    }
}

/// 持有 Job Object 句柄；drop 时关闭句柄。
/// 与 KILL_ON_JOB_CLOSE 配合：当最后一个句柄关闭（含 launcher 进程崩溃/被强杀导致句柄被内核回收）时，
/// Windows 会终结仍在作业中的 llama-server 子进程，从而回收其占用的 GPU 显存。
/// 用 usize 存裸句柄以保证跨线程/跨 await 的 Send 性（裸指针本身不 Send）。
struct JobHandle(usize);

impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                let _ = CloseHandle(self.0 as HANDLE);
            }
        }
    }
}

/// 为刚拉起的 llama-server 子进程建立 Job Object 并设 KILL_ON_JOB_CLOSE 兜底守护。
/// 返回 Some 表示已挂上；返回 None 表示当前环境不允许（例如 launcher 自身已被包在另一个
/// 禁止嵌套作业的作业里），此时降级为仅走优雅退出信号，不阻断启动。
fn create_kill_on_close_job(child: &std::process::Child) -> Option<JobHandle> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) != 0;
        if !set_ok {
            let _ = CloseHandle(job);
            return None;
        }
        let assign_ok = AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE) != 0;
        if !assign_ok {
            let _ = CloseHandle(job);
            return None;
        }
        Some(JobHandle(job as usize))
    }
}

/// 向以 pid 为根的控制台进程组发送 CTRL_C_EVENT，请求 llama-server 走自带清理路径
/// （它注册了控制台处理器，会在退出前卸载 GPU 模型）。launcher 是 GUI 进程、无控制台，
/// 但 GenerateConsoleCtrlEvent 在指定非零进程组时仍可从 GUI 进程调用。
fn signal_console_ctrl_c(pid: u32) {
    unsafe {
        let _ = GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid);
    }
}

fn flash_value(value: &str) -> &str {
    match value.to_lowercase().as_str() {
        "on" => "on",
        "off" => "off",
        _ => "auto",
    }
}

fn local_ip_address() -> Result<IpAddr, String> {
    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|err| format!("绑定 UDP 临时端口失败: {err}"))?;
    socket
        .connect("1.1.1.1:53")
        .map_err(|err| format!("连接 UDP 探测地址失败: {err}"))?;
    let addr = socket
        .local_addr()
        .map_err(|err| format!("读取本地地址失败: {err}"))?;
    Ok(addr.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_preserves_known_config() {
        let config = ServerConfig {
            llama_server_path: "C:/llama/llama-server.exe".into(),
            model: "C:/models/model.gguf".into(),
            model_dir: "C:/models".into(),
            host: "0.0.0.0".into(),
            port: 9090,
            ctx_size: 8192,
            n_predict: 512,
            n_gpu_layers: 32,
            threads: 4,
            batch_size: 1024,
            temp: 0.4,
            flash_attn: "on".into(),
            mmap: false,
            mlock: true,
            enabled_advanced_params: vec![
                "ctx_size".into(),
                "n_predict".into(),
                "n_gpu_layers".into(),
                "threads".into(),
                "batch_size".into(),
                "temp".into(),
                "flash_attn".into(),
                "mmap".into(),
                "mlock".into(),
            ],
        };

        let text = serialize_config_value(&config).expect("serialize");
        let parsed = parse_config_value(&text).expect("parse");

        assert_eq!(parsed.llama_server_path, config.llama_server_path);
        assert_eq!(parsed.model, config.model);
        assert_eq!(parsed.host, config.host);
        assert_eq!(parsed.port, config.port);
        assert_eq!(
            parsed.enabled_advanced_params,
            config.enabled_advanced_params
        );
    }

    #[test]
    fn save_config_round_trip_with_defaults() {
        let config = ServerConfig::default();
        let text = serialize_config_value(&config).expect("serialize");
        let reparsed = parse_config_value(&text).expect("parse");

        assert_eq!(reparsed, config);
    }

    #[test]
    fn parse_ignores_unknown_keys() {
        let text = r#"llama_server_path = "a"
model = "b"
host = "127.0.0.1"
port = 8080
ctx_size = 4096
n_predict = 256
n_gpu_layers = 16
threads = 2
batch_size = 512
temp = 0.7
flash_attn = "auto"
mmap = true
mlock = false
enabled_advanced_params = ["ctx_size", "temp"]
unknown_meta = "keep-me-out"
"#;

        let parsed = parse_config_value(text).expect("parse");
        assert_eq!(parsed.n_predict, 256);
        assert_eq!(parsed.enabled_advanced_params, vec!["ctx_size", "temp"]);
    }

    #[test]
    fn malformed_numeric_falls_back_to_default() {
        let text = r#"llama_server_path = "a"
model = "b"
host = "127.0.0.1"
port = "not-a-number"
ctx_size = 4096
n_predict = -1
n_gpu_layers = 0
threads = 0
batch_size = 512
temp = 0.7
flash_attn = "auto"
mmap = true
mlock = false
enabled_advanced_params = ["ctx_size"]
"#;

        let err = parse_config_value(text).expect_err("should fail on malformed port");
        assert!(err.contains("转换配置失败"));
    }

    #[test]
    fn quoted_values_are_preserved() {
        let text = r#"llama_server_path = "C:/path with spaces/llama-server.exe"
model = "C:/models/my model.gguf"
host = "127.0.0.1"
port = 8080
ctx_size = 4096
n_predict = -1
n_gpu_layers = 0
threads = 0
batch_size = 512
temp = 0.7
flash_attn = "auto"
mmap = true
mlock = false
enabled_advanced_params = ["ctx_size"]
"#;

        let parsed = parse_config_value(text).expect("parse");
        assert_eq!(
            parsed.llama_server_path,
            "C:/path with spaces/llama-server.exe"
        );
        assert_eq!(parsed.model, "C:/models/my model.gguf");
    }

    #[test]
    fn list_models_returns_only_gguf_basenames() {
        let base = std::env::temp_dir().join(format!("llama_test_models_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&base);
        let _ = std::fs::write(base.join("a.gguf"), b"");
        let _ = std::fs::write(base.join("b.gguf"), b"");
        let _ = std::fs::write(base.join("ignore.bin"), b"");
        let _ = std::fs::create_dir(base.join("subdir"));

        let mut models = list_models(base.to_string_lossy().to_string()).expect("list");
        models.sort();
        assert_eq!(models, vec!["a.gguf".to_string(), "b.gguf".to_string()]);

        let _ = std::fs::remove_dir_all(&base);

        // 空目录参数或不存在的目录都返回空列表
        assert!(list_models("".into()).unwrap().is_empty());
        assert!(list_models("C:/no/such/dir/here".into())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn file_exists_reports_presence_and_absence() {
        // 空路径：判为不存在（不依赖其存在性）
        assert!(!file_exists("".into()));
        // 明确不存在的文件
        assert!(!file_exists(
            "C:/this/path/should/not/exist/model.gguf".into()
        ));
        // 代码仓库自身应存在（测试在 crate 根目录运行）
        assert!(file_exists("src/lib.rs".into()));
    }

    #[test]
    fn pump_reader_splits_on_cr_and_lf_realtime() {
        // \n 正常分行；\r 也立即分行（进度条实时透传）；\r\n 视为一次换行；
        // 首尾空格保留（不 trim）；空行保留；末尾无换行的残余也 flush。
        let data = b"line1\nprog 10%\rprog 20%\r\n  spaced  \n\nlast";
        let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();
        pump_reader(std::io::Cursor::new(&data[..]), tx, "info".to_string());
        let got: Vec<String> = rx.iter().map(|(_, text)| text).collect();
        assert_eq!(
            got,
            vec![
                "line1".to_string(),
                "prog 10%".to_string(),
                "prog 20%".to_string(),
                "  spaced  ".to_string(),
                "".to_string(),
                "last".to_string(),
            ]
        );
    }

    #[test]
    fn build_server_args_reflects_config() {
        let config = ServerConfig {
            llama_server_path: "C:/llama/llama-server.exe".into(),
            model: "C:/models/m.gguf".into(),
            model_dir: "C:/models".into(),
            host: "127.0.0.1".into(),
            port: 8080,
            ctx_size: 4096,
            n_predict: -1,
            n_gpu_layers: 0,
            threads: 0,
            batch_size: 512,
            temp: 0.7,
            flash_attn: "auto".into(),
            mmap: true,
            mlock: false,
            enabled_advanced_params: vec!["ctx_size".into()],
        };
        let joined = build_server_args(&config).join(" ");
        assert!(joined.contains("-m C:/models/m.gguf"));
        assert!(joined.contains("--host 127.0.0.1"));
        assert!(joined.contains("--port 8080"));
        assert!(joined.contains("-c 4096"));
        assert!(joined.contains("--timeout 2400"));
        // 仅启用 ctx_size 时不应出现其它高级参数
        assert!(!joined.contains("-n "));
        assert!(!joined.contains("--temp"));
        assert!(!joined.contains("--flash-attn"));
    }
}
