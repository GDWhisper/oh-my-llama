use std::env;
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::str::FromStr;
use serde::{Deserialize, Serialize};
use sysinfo::System;
use tauri::{AppHandle, Listener, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Deserialize, Serialize)]
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
            get_status,
            start_server,
            stop_server,
            open_preview,
            read_logs,
            clear_logs
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let _ = app_handle.clone().listen("tauri://close-requested", move |_| {
                let _ = stop_server_inner(&app_handle);
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

    let local_candidates = [exe_dir.join("config.toml"), exe_dir.join("config/llama-config.toml")];
    for path in &local_candidates {
        if path.exists() {
            let text = std::fs::read_to_string(path)
                .map_err(|err| format!("读取配置失败: {err}"))?;
            return Ok(parse_config(&text)?);
        }
    }

    let app_path = resolve_config_path()?;
    if app_path.exists() {
        let text = std::fs::read_to_string(&app_path)
            .map_err(|err| format!("读取配置失败: {err}"))?;
        return Ok(parse_config(&text)?);
    }

    Ok(ServerConfig::default())
}

#[tauri::command]
async fn save_config(_app: AppHandle, config: ServerConfig) -> Result<(), String> {
    let path = resolve_config_path()?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|err| format!("创建配置目录失败: {err}"))?;
    let text = build_config_text(&config);
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
    cmd.arg("-m").arg(&config.model)
        .arg("--host").arg(&config.host)
        .arg("--port").arg(config.port.to_string())
        .arg("-c").arg(config.ctx_size.to_string())
        .arg("--timeout").arg("2400");

    if config.enabled_advanced_params.contains(&"n_predict".to_string()) {
        cmd.arg("-n").arg(config.n_predict.to_string());
    }
    if config.enabled_advanced_params.contains(&"n_gpu_layers".to_string()) {
        cmd.arg("-ngl").arg(config.n_gpu_layers.to_string());
    }
    if config.enabled_advanced_params.contains(&"threads".to_string()) {
        cmd.arg("-t").arg(config.threads.to_string());
    }
    if config.enabled_advanced_params.contains(&"batch_size".to_string()) {
        cmd.arg("-b").arg(config.batch_size.to_string());
    }
    if config.enabled_advanced_params.contains(&"temp".to_string()) {
        cmd.arg("--temp").arg(config.temp.to_string());
    }
    if config.enabled_advanced_params.contains(&"flash_attn".to_string()) {
        cmd.arg("--flash-attn").arg(flash_value(&config.flash_attn));
    }
    if config.enabled_advanced_params.contains(&"mmap".to_string()) {
        if config.mmap { cmd.arg("--mmap"); } else { cmd.arg("--no-mmap"); }
    }
    if config.enabled_advanced_params.contains(&"mlock".to_string()) {
        if config.mlock { cmd.arg("--mlock"); }
    }

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(0x08000000);

    let child = cmd.spawn().map_err(|err| format!("启动 llama-server 失败: {err}"))?;
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
        let _ = terminate_process(pid);
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
    match child.wait() {
        Ok(status) => {
            let _ = append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: if status.success() { "info".into() } else { "error".into() },
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

fn parse_config(text: &str) -> Result<ServerConfig, String> {
    let mut map = std::collections::HashMap::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim().to_string();
            let value = value.trim().trim_matches('"').to_string();
            map.insert(key, value);
        }
    }

    let mut enabled_advanced_params = get_str(&map, "enabled_advanced_params")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();

    if enabled_advanced_params.is_empty() {
        let optional_keys = vec![
            "n_predict", "n_gpu_layers", "threads", "batch_size", "temp", "flash_attn", "mmap", "mlock"
        ];
        for key in optional_keys {
            if map.contains_key(key) {
                enabled_advanced_params.push(key.to_string());
            }
        }
        if !enabled_advanced_params.contains(&"ctx_size".to_string()) {
            enabled_advanced_params.insert(0, "ctx_size".to_string());
        }
    } else if !enabled_advanced_params.contains(&"ctx_size".to_string()) {
        enabled_advanced_params.insert(0, "ctx_size".to_string());
    }

    Ok(ServerConfig {
        llama_server_path: get_str(&map, "llama_server_path").unwrap_or_default(),
        model: get_str(&map, "model").unwrap_or_default(),
        host: get_str(&map, "host").unwrap_or_else(|| "127.0.0.1".into()),
        port: get_u16(&map, "port").unwrap_or(8080),
        ctx_size: get_i64(&map, "ctx_size").unwrap_or(4096),
        n_predict: get_i64(&map, "n_predict").unwrap_or(-1),
        n_gpu_layers: get_i64(&map, "n_gpu_layers").unwrap_or(0),
        threads: get_i64(&map, "threads").unwrap_or(0),
        batch_size: get_i64(&map, "batch_size").unwrap_or(512),
        temp: get_f64(&map, "temp").unwrap_or(0.7),
        flash_attn: get_str(&map, "flash_attn").unwrap_or_else(|| "auto".into()),
        mmap: get_bool(&map, "mmap").unwrap_or(true),
        mlock: get_bool(&map, "mlock").unwrap_or(false),
        enabled_advanced_params,
    })
}

fn build_config_text(config: &ServerConfig) -> String {
    let mut lines = Vec::new();
    lines.push(format!(r#"llama_server_path = "{}""#, escape(&config.llama_server_path)));
    lines.push(format!(r#"model = "{}""#, escape(&config.model)));
    lines.push(format!(r#"host = "{}""#, escape(&config.host)));
    lines.push(format!("port = {}", config.port));
    lines.push(format!("ctx_size = {}", config.ctx_size));
    lines.push(format!("n_predict = {}", config.n_predict));
    lines.push(format!("n_gpu_layers = {}", config.n_gpu_layers));
    lines.push(format!("threads = {}", config.threads));
    lines.push(format!("batch_size = {}", config.batch_size));
    lines.push(format!("temp = {}", config.temp));
    lines.push(format!(r#"flash_attn = "{}""#, escape(&config.flash_attn)));
    lines.push(format!("mmap = {}", config.mmap));
    lines.push(format!("mlock = {}", config.mlock));
    lines.push(format!(
        r#"enabled_advanced_params = "{}""#,
        escape(&config.enabled_advanced_params.join(","))
    ));
    lines.push(String::new());
    lines.join("\n")
}

fn resolve_config_path() -> Result<std::path::PathBuf, String> {
    let app_data = env::var("APPDATA")
        .or_else(|_| env::var("LOCALAPPDATA"))
        .map_err(|_| "无法定位应用数据目录。".to_string())?;
    Ok(std::path::Path::new(&app_data)
        .join("LlamaLauncher")
        .join("llama-config.toml"))
}

fn get_str(map: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {
    map.get(key).cloned()
}

fn get_i64(map: &std::collections::HashMap<String, String>, key: &str) -> Option<i64> {
    map.get(key).and_then(|value| value.parse().ok())
}

fn get_u16(map: &std::collections::HashMap<String, String>, key: &str) -> Option<u16> {
    map.get(key).and_then(|value| value.parse().ok())
}

fn get_f64(map: &std::collections::HashMap<String, String>, key: &str) -> Option<f64> {
    map.get(key).and_then(|value| value.parse().ok())
}

fn get_bool(map: &std::collections::HashMap<String, String>, key: &str) -> Option<bool> {
    map.get(key).and_then(|value| match value.to_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    })
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_port_in_use(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_err()
}

fn is_port_in_use_socket(socket: SocketAddr) -> bool {
    TcpListener::bind(socket).is_err()
}

fn is_process_running(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false; };
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
    let mut sys = System::new_all();
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
                .args(["-NoProfile", "-Command", &format!("Stop-Process -Id {pid} -Force")])
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
    let socket = UdpSocket::bind("0.0.0.0:0")
        .map_err(|err| format!("绑定 UDP 临时端口失败: {err}"))?;
    socket
        .connect("1.1.1.1:53")
        .map_err(|err| format!("连接 UDP 探测地址失败: {err}"))?;
    let addr = socket
        .local_addr()
        .map_err(|err| format!("读取本地地址失败: {err}"))?;
    Ok(addr.ip())
}

fn resolve_config_dir() -> Result<std::path::PathBuf, String> {
    let app_data = env::var("APPDATA")
        .or_else(|_| env::var("LOCALAPPDATA"))
        .map_err(|_| "无法定位应用数据目录。".to_string())?;
    Ok(std::path::Path::new(&app_data).join("LlamaLauncher"))
}
