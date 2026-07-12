use serde::{Deserialize, Serialize};
use std::env;
use std::io::BufRead;
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::str::FromStr;
use sysinfo::System;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ServerConfig {
    pub llama_server_path: String,
    pub model: String,
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
        .manage(tauri::async_runtime::Mutex::new(ServerStatus::default()))
        .manage(tauri::async_runtime::Mutex::new(Vec::<ServerLogLine>::new()))
        .invoke_handler(tauri::generate_handler![
            read_config,
            save_config,
            get_default_config,
            get_status,
            start_server,
            stop_server,
            open_preview,
            read_logs,
            clear_logs
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
            )
            .await;
            *status = ServerStatus::default();
        }
    }
    Ok(status.clone())
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
        return Err("请先填写模型路径。".into());
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
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("-m")
        .arg(&config.model)
        .arg("--host")
        .arg(&config.host)
        .arg("--port")
        .arg(config.port.to_string())
        .arg("-c")
        .arg(config.ctx_size.to_string())
        .arg("--timeout")
        .arg("2400");

    if config
        .enabled_advanced_params
        .contains(&"n_predict".to_string())
    {
        cmd.arg("-n").arg(config.n_predict.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"n_gpu_layers".to_string())
    {
        cmd.arg("-ngl").arg(config.n_gpu_layers.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"threads".to_string())
    {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"batch_size".to_string())
    {
        cmd.arg("-b").arg(config.batch_size.to_string());
    }
    if config.enabled_advanced_params.contains(&"temp".to_string()) {
        cmd.arg("--temp").arg(config.temp.to_string());
    }
    if config
        .enabled_advanced_params
        .contains(&"flash_attn".to_string())
    {
        cmd.arg("--flash-attn").arg(flash_value(&config.flash_attn));
    }
    if config.enabled_advanced_params.contains(&"mmap".to_string()) {
        if config.mmap {
            cmd.arg("--mmap");
        } else {
            cmd.arg("--no-mmap");
        }
    }
    if config
        .enabled_advanced_params
        .contains(&"mlock".to_string())
        && config.mlock
    {
        cmd.arg("--mlock");
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);

    let child = cmd
        .spawn()
        .map_err(|err| format!("启动 llama-server 失败: {err}"))?;
    let pid = child.id();
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
    )
    .await;

    *status = ServerStatus {
        running: true,
        pid: Some(pid),
        host: config.host.clone(),
        port: config.port,
        url: format!("http://{}:{}", config.host, config.port),
    };

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = wait_process(app_handle, child).await;
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
    let state = app.state::<tauri::async_runtime::Mutex<Vec<ServerLogLine>>>();
    let logs = state.lock().await.clone();
    Ok(logs)
}

#[tauri::command]
async fn clear_logs(app: AppHandle) -> Result<(), String> {
    let state = app.state::<tauri::async_runtime::Mutex<Vec<ServerLogLine>>>();
    state.lock().await.clear();
    Ok(())
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
        terminate_process(pid);
        append_log_inner(
            app,
            ServerLogLine {
                ts: now(),
                level: "info".into(),
                text: format!("已请求停止 llama-server，pid={pid}。"),
            },
        )
        .await;
    }
    Ok(())
}

async fn wait_process(app: AppHandle, mut child: std::process::Child) {
    // 读取子进程 stdout/stderr：避免管道缓冲写满导致服务端阻塞/死锁，
    // 同时把 llama-server 的真实输出送进日志面板。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<(String, String)>();

    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let reader = std::io::BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                if tx.send(("info".to_string(), line)).is_err() {
                    break;
                }
            }
        }));
    }
    if let Some(err) = stderr {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let reader = std::io::BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                let line = line.trim_end().to_string();
                if line.is_empty() {
                    continue;
                }
                if tx.send(("warn".to_string(), line)).is_err() {
                    break;
                }
            }
        }));
    }
    drop(tx);

    let exit = child.wait();

    // 进程已退出，等读取线程把剩余输出写完后再排空 channel。
    for handle in readers {
        let _ = handle.join();
    }

    while let Ok((level, text)) = rx.recv() {
        append_log_inner(
            &app,
            ServerLogLine {
                ts: now(),
                level,
                text,
            },
        )
        .await;
    }

    match exit {
        Ok(status) => {
            let _ = append_log_inner(
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
            )
            .await;
        }
        Err(err) => {
            let _ = append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: "error".into(),
                    text: format!("读取 llama-server 退出状态失败: {err}"),
                },
            )
            .await;
        }
    }
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;
    *status = ServerStatus::default();
}

async fn append_log_inner(app: &AppHandle, line: ServerLogLine) {
    let state = app.state::<tauri::async_runtime::Mutex<Vec<ServerLogLine>>>();
    let mut logs = state.lock().await;
    logs.push(line);
    if logs.len() > 1000 {
        logs.remove(0);
    }
}

fn parse_config_value(text: &str) -> Result<ServerConfig, String> {
    let mut config: ServerConfig =
        toml::from_str(text).map_err(|err| format!("转换配置失败: {err}"))?;
    config.llama_server_path = config.llama_server_path.trim().to_string();
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
}
