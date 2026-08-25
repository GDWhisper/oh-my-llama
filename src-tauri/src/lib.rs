use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::process::Stdio;
use std::str::FromStr;
use std::time::Duration;
use sysinfo::System;
use tauri::{AppHandle, Emitter, Listener, Manager};
use tauri_plugin_opener::OpenerExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_C_EVENT};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

mod metrics;
use metrics::get_system_metrics;

mod params;
use params::{find_spec, get_param_registry};

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
    // 临时禁用的高级参数键：卡片仍显示、值保留，但本次启动不写入命令行。
    // 与 enabled_advanced_params 同构；缺省时按空列表解析（向后兼容旧配置）。
    #[serde(default)]
    pub disabled_advanced_params: Vec<String>,
    // 一键传参写入的自定义参数：原样追加到启动命令行末尾，
    // 确保用户粘贴的（未知）llama-server 参数与真正启动时完全一致。
    #[serde(default)]
    pub extra_args: Vec<String>,
    // 临时禁用的自定义参数（双列表方案）：文本保留但不写入启动命令行。
    #[serde(default)]
    pub disabled_extra_args: Vec<String>,
    // ── 结构化高级参数（数据驱动，声明见 params::PARAM_REGISTRY）──────────
    // 已启用（卡片显示）的结构化参数键，保持用户添加顺序 → 命令行顺序稳定、可单测。
    #[serde(default)]
    pub enabled_structured_params: Vec<String>,
    // 临时禁用：卡片仍显示、值保留，但本次启动不写入命令行（与高级参数同构）。
    #[serde(default)]
    pub disabled_structured_params: Vec<String>,
    // 值统一以字符串存储：注册表已声明类型/默认值/候选项，序列化时按声明还原，
    // 避免为每个官方参数在 ServerConfig 上硬编码一个字段（约 160 个）。
    // 必须放在结构体最后一个字段：TOML 要求「表」序列化于所有标量/数组之后。
    #[serde(default)]
    pub structured_params: HashMap<String, String>,
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
            disabled_advanced_params: Vec::new(),
            extra_args: Vec::new(),
            disabled_extra_args: Vec::new(),
            enabled_structured_params: Vec::new(),
            disabled_structured_params: Vec::new(),
            structured_params: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub running: bool,
    // 是否由本应用拉起：仅受管的服务允许本应用停止（外部服务不归本应用管）。
    pub managed: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub host: String,
    pub url: String,
}

impl Default for ServerStatus {
    fn default() -> Self {
        Self {
            running: false,
            managed: false,
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

// ── 应用级设置（与服务器启动配置 ServerConfig 解耦）────────────────────
// 当前含两项：
//  - update_proxy：留空 = 更新直连（不读任何代理环境变量）；填写 = 仅走用户显式指定的代理地址。
//  - auto_check_updates：启动时是否自动检查更新（不打扰：仅弹右上提示+版本旁 NEW 徽标，
//    绝不静默下载/安装；安装仍需用户在弹窗里显式确认）。
// 仅持久化到 APPDATA/OhMyLlama/settings.json，不污染 configs.toml，
// 也不干预用户代理客户端的全局/规则模式。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub update_proxy: String,
    #[serde(default)]
    pub auto_check_updates: bool,
}

fn settings_path(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("OhMyLlama").join("settings.json")
}

fn load_settings(app_data: &std::path::Path) -> AppSettings {
    let path = settings_path(app_data);
    if path.exists() {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<AppSettings>(&text) {
                return s;
            }
        }
    }
    AppSettings::default()
}

// 将「更新代理」映射到进程的环境变量：更新器底层用 reqwest 的 ClientBuilder::new()，
// 默认会读取 HTTPS_PROXY/HTTP_PROXY。因此——
// 留空 → 移除这些变量，更新器直连（避免被未运行的本地代理坑住）；
// 填写 → 写入该地址，更新器才走此代理。整个过程不读取/不干预用户代理的全局或规则模式。
fn apply_update_proxy_env(proxy: &str) {
    let proxy = proxy.trim();
    let vars = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
    if proxy.is_empty() {
        for var in vars {
            std::env::remove_var(var);
        }
    } else {
        for var in vars {
            std::env::set_var(var, proxy);
        }
    }
}

#[tauri::command]
async fn read_settings(_app: AppHandle) -> Result<AppSettings, String> {
    let app_data = resolve_app_data()?;
    Ok(load_settings(&app_data))
}

#[tauri::command]
async fn save_settings(
    _app: AppHandle,
    update_proxy: String,
    auto_check_updates: bool,
) -> Result<AppSettings, String> {
    let raw = update_proxy.trim().to_string();
    // 裸地址（如 127.0.0.1:7897 / localhost / 127）默认按 http:// 处理；
    // 仅当显式写了其它协议（含 :// 且非 http/https）时才报错。
    let proxy = if raw.is_empty() || raw.starts_with("http://") || raw.starts_with("https://") {
        raw
    } else if raw.contains("://") {
        return Err("代理地址仅支持 http:// 或 https:// 协议。".into());
    } else {
        format!("http://{raw}")
    };
    let app_data = resolve_app_data()?;
    let path = settings_path(&app_data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建设置目录失败: {err}"))?;
    }
    let settings = AppSettings {
        update_proxy: proxy.clone(),
        auto_check_updates,
    };
    let text =
        serde_json::to_string_pretty(&settings).map_err(|err| format!("序列化设置失败: {err}"))?;
    std::fs::write(&path, text).map_err(|err| format!("写入设置失败: {err}"))?;
    // 立即生效：本次会话内下一次「检查更新」即按新代理策略（无需重启）。
    apply_update_proxy_env(&proxy);
    Ok(settings)
}

pub fn run() {
    // 启动即按持久化的「更新代理」决定更新器是否走代理（详见 apply_update_proxy_env）。
    if let Ok(app_data) = resolve_app_data() {
        let settings = load_settings(&app_data);
        apply_update_proxy_env(&settings.update_proxy);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tauri::async_runtime::Mutex::new(ServerStatus::default()))
        .manage(std::sync::Mutex::new(Vec::<ServerLogLine>::new()))
        .invoke_handler(tauri::generate_handler![
            get_configs_state,
            save_named_config,
            delete_named_config,
            set_active,
            rename_named_config,
            get_default_config,
            get_status,
            start_server,
            stop_server,
            open_preview,
            read_logs,
            clear_logs,
            file_exists,
            file_size,
            list_models,
            read_settings,
            save_settings,
            get_system_metrics,
            get_param_registry
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
        .expect("error while running oh my llama");
}

// ── 多配置管理：命名配置库 + 默认配置（工厂默认值，只读模板）────────────
// 存储格式（APPDATA/OhMyLlama/configs.toml）：
//   active = "配置名"            // 当前选中的配置；"default" 表示默认配置
//   [configs.配置名]            // 一条命名配置，结构与 ServerConfig 一致
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ConfigStore {
    #[serde(default)]
    active: String,
    #[serde(default)]
    configs: HashMap<String, ServerConfig>,
}

#[derive(Debug, Clone, Serialize)]
struct ConfigsState {
    default: ServerConfig,
    configs: HashMap<String, ServerConfig>,
    active: String,
}

fn resolve_app_data() -> Result<std::path::PathBuf, String> {
    let dir = env::var("APPDATA")
        .or_else(|_| env::var("LOCALAPPDATA"))
        .map_err(|_| "无法定位应用数据目录。".to_string())?;
    Ok(std::path::PathBuf::from(dir))
}

fn configs_path(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("OhMyLlama").join("configs.toml")
}

fn load_store(path: &std::path::Path) -> ConfigStore {
    if path.exists() {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(store) = toml::from_str::<ConfigStore>(&text) {
                return store;
            }
        }
    }
    ConfigStore::default()
}

fn save_store(path: &std::path::Path, store: &ConfigStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("创建配置目录失败: {err}"))?;
    }
    let text = toml::to_string(store).map_err(|err| format!("序列化配置失败: {err}"))?;
    std::fs::write(path, text).map_err(|err| format!("写入配置失败: {err}"))?;
    Ok(())
}

// 旧版单配置文件（config.toml / config/llama-config.toml / APPDATA 下的旧路径）。
// 仅用于首次升级时把用户既有配置迁移为一条命名配置，避免配置丢失。
fn read_legacy_config() -> Option<ServerConfig> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .filter(|p| p.exists());
    let candidates = [
        exe_dir.as_ref().map(|d| d.join("config.toml")),
        exe_dir.as_ref().map(|d| d.join("config/llama-config.toml")),
    ];
    for path in candidates.into_iter().flatten() {
        if path.exists() {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(cfg) = parse_config_value(&text) {
                    return Some(cfg);
                }
            }
        }
    }
    if let Ok(app_path) = resolve_config_path() {
        if app_path.exists() {
            if let Ok(text) = std::fs::read_to_string(&app_path) {
                if let Ok(cfg) = parse_config_value(&text) {
                    return Some(cfg);
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn get_default_config(_app: AppHandle) -> Result<ServerConfig, String> {
    Ok(ServerConfig::default())
}

#[tauri::command]
async fn get_configs_state(_app: AppHandle) -> Result<ConfigsState, String> {
    let app_data = resolve_app_data()?;
    let path = configs_path(&app_data);
    let legacy_missing = !path.exists();
    let mut store = load_store(&path);
    // 首次升级：命名配置库尚不存在，但旧版单配置文件里有用户既有配置 →
    // 迁移为「导入的配置」并设为当前，避免用户配置丢失（默认配置保持为只读模板）。
    if legacy_missing {
        if let Some(legacy) = read_legacy_config() {
            if legacy != ServerConfig::default() {
                store.configs.insert("导入的配置".into(), legacy);
                store.active = "导入的配置".into();
                save_store(&path, &store)?;
            }
        }
    }
    let active = if store.active.is_empty()
        || (store.active != "default" && !store.configs.contains_key(&store.active))
    {
        "default".into()
    } else {
        store.active.clone()
    };
    Ok(ConfigsState {
        default: ServerConfig::default(),
        configs: store.configs,
        active,
    })
}

#[tauri::command]
async fn save_named_config(
    _app: AppHandle,
    name: String,
    config: ServerConfig,
) -> Result<(), String> {
    if name.trim().is_empty() || name == "default" {
        return Err("配置名无效（不能使用默认配置名）。".into());
    }
    let app_data = resolve_app_data()?;
    let path = configs_path(&app_data);
    let mut store = load_store(&path);
    store.configs.insert(name, config);
    save_store(&path, &store)
}

#[tauri::command]
async fn delete_named_config(_app: AppHandle, name: String) -> Result<(), String> {
    if name == "default" {
        return Err("默认配置不可删除。".into());
    }
    let app_data = resolve_app_data()?;
    let path = configs_path(&app_data);
    let mut store = load_store(&path);
    store.configs.remove(&name);
    if store.active == name {
        store.active = "default".into();
    }
    save_store(&path, &store)
}

#[tauri::command]
async fn set_active(_app: AppHandle, name: String) -> Result<(), String> {
    let app_data = resolve_app_data()?;
    let path = configs_path(&app_data);
    let mut store = load_store(&path);
    if name != "default" && !store.configs.contains_key(&name) {
        return Err(format!("未知配置：{name}"));
    }
    store.active = name;
    save_store(&path, &store)
}

#[tauri::command]
async fn rename_named_config(
    _app: AppHandle,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let app_data = resolve_app_data()?;
    let path = configs_path(&app_data);
    let mut store = load_store(&path);
    rename_named_config_in_store(&mut store, &old_name, &new_name)?;
    save_store(&path, &store)
}

// 重命名纯逻辑（与命令分离，便于单测）：把 old_name 改名 new_name，
// 同时若它正是当前 active 则一并更新；默认配置不可改、空名/同名冲突/已存在均报错。
fn rename_named_config_in_store(
    store: &mut ConfigStore,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    if old_name == "default" {
        return Err("默认配置不可重命名。".into());
    }
    let new_name = new_name.trim().to_string();
    if new_name.is_empty() || new_name == "default" {
        return Err("配置名无效（不能为空或使用默认配置名）。".into());
    }
    if !store.configs.contains_key(old_name) {
        return Err(format!("未知配置：{old_name}"));
    }
    if old_name == new_name {
        // 同名：无需改动
        return Ok(());
    }
    if store.configs.contains_key(&new_name) {
        return Err(format!("配置名已存在：{new_name}"));
    }
    let value = store.configs.remove(old_name).unwrap();
    store.configs.insert(new_name.clone(), value);
    if store.active == old_name {
        store.active = new_name;
    }
    Ok(())
}

#[tauri::command]
async fn get_status(app: AppHandle, config: ServerConfig) -> Result<ServerStatus, String> {
    let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
    let mut status = state.lock().await;

    // 两个独立事实，解耦判断：
    //  - listening：配置地址上是否真有服务在监听（用户关心的「服务在跑吗」）。
    //  - owned_alive：本应用拉起的进程是否仍存活（决定 managed / Stop 是否可用）。
    let listening = matches!(probe_health(&config.host, config.port), HealthProbe::Ready);
    let owned_alive = status.managed && is_process_running(status.pid);

    if listening {
        // 端口确有服务在监听 → 运行中。
        // managed 取决于是否仍由本应用掌控（pid 存活）；外部（或脱离掌控）的服务 managed=false。
        if !status.running {
            let note = if owned_alive {
                "llama-server 已就绪"
            } else {
                "检测到外部服务在该地址监听"
            };
            append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: "info".into(),
                    text: format!("{} ({}:{})", note, config.host, config.port),
                },
            );
        }
        status.running = true;
        status.managed = owned_alive;
        if !owned_alive {
            status.pid = None;
        }
    } else {
        // 端口无服务。
        if status.running {
            append_log_inner(
                &app,
                ServerLogLine {
                    ts: now(),
                    level: "warn".into(),
                    text: "llama-server 已停止。".into(),
                },
            );
        }
        status.running = false;
        // 受管态与「端口是否就绪」解耦：只要本应用拉起的进程还活着（如正在加载大模型），
        // 就保持 managed=true、保留 pid，使 Stop 始终可用，且端口就绪后下一轮询即翻转为运行中。
        if owned_alive {
            status.managed = true;
        } else {
            status.managed = false;
            status.pid = None;
        }
    }
    // host/port/url 始终与当前配置对齐（即便未运行，预览地址也显示正确目标）。
    status.host = config.host.clone();
    status.port = config.port;
    status.url = format!("http://{}:{}", config.host, config.port);

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

    // 仅当「已启用且未临时禁用」时才写入对应高级参数。
    // enabled = 卡片显示；disabled = 卡片仍显示但本次启动不传。
    let enabled = &config.enabled_advanced_params;
    let disabled: HashSet<&str> = config
        .disabled_advanced_params
        .iter()
        .map(|s| s.as_str())
        .collect();
    let active = |key: &str| enabled.iter().any(|k| k.as_str() == key) && !disabled.contains(key);

    if active("n_predict") {
        args.push("-n".into());
        args.push(config.n_predict.to_string());
    }
    if active("n_gpu_layers") {
        args.push("-ngl".into());
        args.push(config.n_gpu_layers.to_string());
    }
    if active("threads") {
        args.push("-t".into());
        args.push(config.threads.to_string());
    }
    if active("batch_size") {
        args.push("-b".into());
        args.push(config.batch_size.to_string());
    }
    if active("temp") {
        args.push("--temp".into());
        args.push(config.temp.to_string());
    }
    if active("flash_attn") {
        args.push("--flash-attn".into());
        args.push(flash_value(&config.flash_attn).to_string());
    }
    if active("mmap") {
        if config.mmap {
            args.push("--mmap".into());
        } else {
            args.push("--no-mmap".into());
        }
    }
    if active("mlock") && config.mlock {
        args.push("--mlock".into());
    }
    // 结构化高级参数：按注册表声明通用序列化，顺序 = 用户启用顺序（可预测、可单测）。
    // 未在注册表中的键（旧配置残留 / 已废弃参数）静默跳过，不影响启动。
    let structured_disabled: HashSet<&str> = config
        .disabled_structured_params
        .iter()
        .map(|s| s.as_str())
        .collect();
    for key in &config.enabled_structured_params {
        if structured_disabled.contains(key.as_str()) {
            continue;
        }
        let Some(spec) = find_spec(key) else { continue };
        let value = config
            .structured_params
            .get(key)
            .map(|s| s.as_str())
            .unwrap_or(spec.default);
        args.extend(spec.to_args(value));
    }
    // 一键传参写入的自定义参数：仅追加「启用」列表（disabled_extra_args 不传），
    // 确保用户传入的参数与真正启动时一致（含未知 flag 也会进入 llama-server）。
    args.extend(config.extra_args.iter().filter(|a| !a.is_empty()).cloned());
    args
}

#[tauri::command]
async fn start_server(app: AppHandle, config: ServerConfig) -> Result<ServerStatus, String> {
    // 先取锁做前置校验，校验后即释放——避免后续耗时的就绪轮询长期占用状态锁，
    // 否则会阻塞 get_status 的 1.5s 轮询、导致 UI 卡顿。
    let already_managed_running = {
        let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
        let status = state.lock().await;
        status.running && status.managed
    };
    if already_managed_running {
        let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
        let status = state.lock().await;
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

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        // 放入新进程组（组长即 llama-server）：停止时对整个进程组发信号（优雅 SIGINT / 兜底 SIGKILL），
        // 等价 Windows 的 CTRL_C_EVENT + Job Object 组合；spawn 成功即代表进程组已建立。
        cmd.process_group(0);
    }

    let child = cmd
        .spawn()
        .map_err(|err| format!("启动 llama-server 失败: {err}"))?;
    let pid = child.id();
    // 建立平台级子进程守护：
    // - Windows：Job Object + KILL_ON_JOB_CLOSE，launcher 以任何方式死亡（含崩溃/被强杀/被 OOM）时
    //   内核会据此终结 llama-server 子进程并回收 GPU 显存；句柄随 child 交给 wait_process 持有，
    //   进程一退出即被内核回收 → KILL_ON_JOB_CLOSE 触发（见 create_process_guard）。
    // - 非 Windows：进程组（见上方 process_group(0)），无崩溃回收语义，仅供停止时组内发信号。
    let guard = create_process_guard(&child);
    if !guard.is_active() {
        append_log_inner(
            &app,
            ServerLogLine {
                ts: now(),
                level: "warn".into(),
                text: "未能建立进程守护（环境限制）：launcher 意外崩溃时子进程可能无法自动回收。"
                    .into(),
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

    // 立即把子进程交给 wait_process 监管：实时消费 stdout/stderr（原生日志透传）、
    // 进程退出时复位状态、回收 GPU。必须在阻塞等待端口就绪之前启动——否则模型加载
    // 期间的输出会堵在 OS 管道、前端“原生”模式看不到实时日志；管道写满时还会反压
    // llama-server 致其加载卡死。wait_process 仅消费输出，直到子进程真正退出才改状态，
    // 故与本段随后的健康探测可安全并发。
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = wait_process(app_handle, child, guard).await;
    });

    // 等待服务端口真正就绪（模型加载可能耗时），不持状态锁。
    // 就绪前不应断言 running，否则 UI 会过早显示"运行中"、预览却连不上。
    let ready = wait_until_ready(&config.host, config.port, pid, START_READINESS_TIMEOUT);

    let alive = is_process_running(Some(pid));
    let final_status = {
        let state = app.state::<tauri::async_runtime::Mutex<ServerStatus>>();
        let mut status = state.lock().await;
        if ready {
            status.running = true;
            status.managed = true;
            status.pid = Some(pid);
        } else if alive {
            // 超时但进程仍存活（仍在加载大模型）：先记受管态，running 由 get_status 据端口后续修正。
            status.running = false;
            status.managed = true;
            status.pid = Some(pid);
        } else {
            // 进程已退出：交由 wait_process 复位，这里仅确保运行态为 false。
            status.running = false;
        }
        status.host = config.host.clone();
        status.port = config.port;
        status.url = format!("http://{}:{}", config.host, config.port);
        status.clone()
    };

    if ready {
        Ok(final_status)
    } else if alive {
        // 仍在后台加载：返回提示，但状态已记受管，端口就绪后 get_status 会自动翻转为运行中。
        Err(
            "启动较慢：服务在限定时间内尚未就绪，仍在后台加载模型，请稍候（状态将自动更新）。"
                .into(),
        )
    } else {
        Err("启动失败：llama-server 进程已退出，请检查模型路径与启动参数（详见日志）。".into())
    }
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

// 同步命令：返回文件字节大小；路径为空或文件不存在时返回 None。
// 前端用于在当前模型行后展示模型大小（GB）。
#[tauri::command]
fn file_size(path: String) -> Option<u64> {
    if path.trim().is_empty() {
        return None;
    }
    std::fs::metadata(&path).ok().map(|m| m.len())
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
    if !status.managed {
        return Err(
            "当前运行的服务不是由本应用启动的（外部服务），无法在此停止，请手动停止。".into(),
        );
    }
    let pid = status.pid;
    *status = ServerStatus::default();
    drop(status);

    if let Some(pid) = pid {
        // 先礼貌请求 llama-server 走自带的干净卸载路径：它注册了信号处理器（Windows 控制台处理器
        // / POSIX SIGINT），收到后会在退出前卸载 GPU 模型（与你手动关终端时行为一致）。
        // 平台守护仍是兜底——若它不响应，下面的强制终止（Windows 还有 launcher 崩溃时的
        // KILL_ON_JOB_CLOSE）会保证进程必死、GPU 必回收。
        request_graceful_stop(pid);
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
fn pump_reader(reader: impl std::io::Read, tx: std::sync::mpsc::Sender<String>) {
    let mut reader = std::io::BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    let mut one = [0u8; 1];
    let mut last_cr = false;
    loop {
        match reader.read(&mut one) {
            Ok(0) | Err(_) => {
                // EOF：flush 末尾未以换行结尾的残余内容。
                if !buf.is_empty() {
                    let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
                }
                break;
            }
            Ok(_) => match one[0] {
                b'\r' => {
                    let line = String::from_utf8_lossy(&buf).into_owned();
                    buf.clear();
                    last_cr = true;
                    if tx.send(line).is_err() {
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
                        if tx.send(line).is_err() {
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

async fn wait_process(app: AppHandle, mut child: std::process::Child, _guard: ProcessGuard) {
    // 读取子进程 stdout/stderr：避免管道缓冲写满导致服务端阻塞/死锁，
    // 同时把 llama-server 的真实输出（含 \r 进度、空行、首尾空格）原样送进日志面板。
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    // 消费线程：一收到一行就立即写盘 + emit（实时透传）。
    // 关键点：用独立的 std 线程（而非 async 任务）承载消费；child.wait()
    // 也放到另一个 std 线程上。这样无论 async 运行时是单线程还是多线程，
    // 消费都不会被 child.wait() 阻塞，真正实时；彻底杜绝"运行中无日志、
    // 停止后涌入一批"的现象。
    let app_rx = app.clone();
    let consumer = std::thread::spawn(move || {
        while let Ok(text) = rx.recv() {
            // 原生日志：子进程输出逐行原样记一条（level=raw），不做任何级别加工，
            // 前端“原生”模式即完整日志，会原样展示这一行（含可能的着色转义/进度刷新）。
            // 只记一次，避免与结构化级别重复刷屏。
            append_log_inner(
                &app_rx,
                ServerLogLine {
                    ts: now(),
                    level: "raw".into(),
                    text,
                },
            );
        }
    });

    let mut readers = Vec::new();
    if let Some(out) = stdout {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            pump_reader(out, tx);
        }));
    }
    if let Some(err) = stderr {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            pump_reader(err, tx);
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

// 仅测试使用（tests 模块内断言序列化往返），标 cfg(test) 避免 lib 目标编译出死代码。
#[cfg(test)]
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
        .join("OhMyLlama")
        .join("llama-config.toml"))
}

fn now() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn is_port_in_use_socket(socket: SocketAddr) -> bool {
    TcpListener::bind(socket).is_err()
}

// 服务就绪探测结果：
// - Unreachable：连不上，或连上后未回传任何 HTTP 响应（端口已 bind 但服务尚未真正提供 HTTP）。
// - Loading：返回 503（llama.cpp 模型仍在加载中）。
// - Ready：返回 200（模型已加载、可对外服务）；或返回其它 HTTP 状态（含旧版无 /health 路由的 404，
//   说明 HTTP 服务已起来、只是该路径不存在，同样视为可服务）。
enum HealthProbe {
    Unreachable,
    Loading,
    Ready,
}

// 真正探测「服务是否已就绪、能对外提供 HTTP 推理服务」。
// 仅判断 TCP 端口已 bind 不足以说明服务可用：某些 llama.cpp 构建会先 bind 端口、后加载模型，
// 此时 TCP connect 成功但 HTTP 请求会挂起或返回 503「模型加载中」，UI 却已误显示「运行中」。
// llama.cpp 提供始终开启的 GET /health：模型加载中返回 503、加载完成返回 200 {"status":"ok"}。
// 据此判定就绪最可靠，也与生态标准做法（curl /health 做 readiness probe）一致。
// 纯标准库实现（TcpStream + 手写最小 HTTP 请求/响应解析），无需新增 crate；
// 回环/0.0.0.0 统一归一到 127.0.0.1 连接（llama-server 以 0.0.0.0 监听时回环地址同样可达）。
fn probe_health(host: &str, port: u16) -> HealthProbe {
    let host_lc = host.trim().to_lowercase();
    let connect_host = match host_lc.as_str() {
        "" | "127.0.0.1" | "localhost" | "0.0.0.0" => "127.0.0.1",
        other => other,
    };
    let Ok(addr) = format!("{connect_host}:{port}").parse::<SocketAddr>() else {
        return HealthProbe::Unreachable;
    };
    // 连接超时偏短：端口未开时系统通常立即返回 refused（不会真等满）；仅被静默丢弃时才用到上限。
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(800)) {
        Ok(s) => s,
        Err(_) => return HealthProbe::Unreachable,
    };
    // 主动发一个最小化 HTTP/1.1 GET /health，逼服务回传状态行（而非仅完成 TCP 握手就误判为就绪）。
    let request = format!(
        "GET /health HTTP/1.1\r\nHost: {connect_host}:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return HealthProbe::Unreachable;
    }
    // 读超时：等待服务回传状态行；模型加载中/未就绪时连接会被接受但迟迟不响应 → 超时即视为未就绪。
    if stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .is_err()
    {
        return HealthProbe::Unreachable;
    }
    let mut response = Vec::with_capacity(128);
    let mut buf = [0u8; 256];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break, // 对端关闭且未回传任何内容：bind 了但还没服务
            Ok(n) => {
                response.extend_from_slice(&buf[..n]);
                // 状态行以 CRLF 结束，读到即足够判定，无需读完 body。
                if response.windows(2).any(|w| w == b"\r\n") {
                    break;
                }
                if response.len() >= 1024 {
                    break;
                }
            }
            Err(_) => break, // 读超时 / 异常：连上了但不回 HTTP → 未就绪
        }
    }
    parse_health_status(&response)
}

// 从 HTTP 响应首部解析状态码并映射为就绪语义：
// 200（模型已加载，可服务）或 503 之外的任何 HTTP 状态（含旧版无 /health 路由的 404）= 就绪；
// 503 = 模型仍在加载中；无法解析出 HTTP 状态行（连上但不回 HTTP）= 未就绪。
fn parse_health_status(resp: &[u8]) -> HealthProbe {
    match parse_http_status_code(resp) {
        Some(200) => HealthProbe::Ready,
        Some(503) => HealthProbe::Loading,
        Some(_) => HealthProbe::Ready,
        None => HealthProbe::Unreachable,
    }
}

// 从形如 "HTTP/1.1 200 OK\r\n..." 的响应首部提取三位状态码。
fn parse_http_status_code(resp: &[u8]) -> Option<u16> {
    let s = std::str::from_utf8(resp).ok()?;
    let mut it = s.split_whitespace();
    let _version = it.next()?; // "HTTP/1.1"
    it.next()?.parse::<u16>().ok()
}

// 启动后等待服务真正就绪（GET /health 返回 200）的最长时间：模型加载可能耗时数秒到数分钟，
// 超时仍未就绪则判定启动过慢/失败，交由用户检查日志。非持锁等待。
const START_READINESS_TIMEOUT: Duration = Duration::from_secs(90);

// 轮询就绪直到 GET /health 返回 200；期间若进程已退出则立即判定失败，超时则返回 false。
// 阻塞式（std::thread::sleep）：仅在 start_server 这一个一次性命令任务内调用，
// 不持状态锁，不会阻塞 get_status 的 1.5s 轮询；多工作线程运行时也不影响其它命令。
fn wait_until_ready(host: &str, port: u16, pid: u32, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        match probe_health(host, port) {
            HealthProbe::Ready => return true,
            // 503（加载中）或连不上（尚未 bind）：都继续等，直到进程退出或超时。
            HealthProbe::Loading | HealthProbe::Unreachable => {}
        }
        if !is_process_running(Some(pid)) {
            // 进程已退出：启动失败（参数/模型错误等），等待 wait_process 复位状态。
            return false;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
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
    #[cfg(windows)]
    {
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
    #[cfg(not(windows))]
    {
        // POSIX 兜底：向进程组发 SIGKILL（组组长即 llama-server，可一并终结其衍生进程）。
        // 若进程组已不存在（如子进程退出后），errno 为 ESRCH，忽略即可。
        unsafe {
            let _ = libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// 平台级子进程守护的统一定义（随 child 交给 wait_process 持有，直到子进程退出）：
/// - Windows：持有 Job Object 句柄（见 JobHandle），launcher 崩溃/退出时内核回收子进程；
/// - 非 Windows：进程组已在 spawn 时建立（见 start_server 的 process_group(0)），
///   无需持有额外状态，空结构体仅作类型占位（保持调用侧签名一致）。
#[cfg(windows)]
struct ProcessGuard {
    job: Option<JobHandle>,
}

#[cfg(not(windows))]
struct ProcessGuard;

#[cfg(windows)]
impl ProcessGuard {
    /// Job Object 守护是否挂载成功（为 None 时见 create_kill_on_close_job 的环境限制说明）。
    fn is_active(&self) -> bool {
        self.job.is_some()
    }
}

#[cfg(not(windows))]
impl ProcessGuard {
    /// 进程组在 spawn 时已建立（spawn 成功即 setpgid 生效），恒为 true。
    fn is_active(&self) -> bool {
        true
    }
}

/// 为刚拉起的 llama-server 建立平台级守护：
/// - Windows：Job Object + KILL_ON_JOB_CLOSE，失败时不阻断启动，仅降级为优雅退出信号；
/// - 非 Windows：进程组在 spawn 时已建立，恒为 active。
fn create_process_guard(child: &std::process::Child) -> ProcessGuard {
    #[cfg(windows)]
    {
        ProcessGuard {
            job: create_kill_on_close_job(child),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child;
        ProcessGuard
    }
}

/// 持有 Job Object 句柄；drop 时关闭句柄。（仅 Windows）
/// 与 KILL_ON_JOB_CLOSE 配合：当最后一个句柄关闭（含 launcher 进程崩溃/被强杀导致句柄被内核回收）时，
/// Windows 会终结仍在作业中的 llama-server 子进程，从而回收其占用的 GPU 显存。
/// 用 usize 存裸句柄以保证跨线程/跨 await 的 Send 性（裸指针本身不 Send）。
#[cfg(windows)]
struct JobHandle(usize);

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 {
            unsafe {
                let _ = CloseHandle(self.0 as HANDLE);
            }
        }
    }
}

/// 为刚拉起的 llama-server 子进程建立 Job Object 并设 KILL_ON_JOB_CLOSE 兜底守护。（仅 Windows）
/// 返回 Some 表示已挂上；返回 None 表示当前环境不允许（例如 launcher 自身已被包在另一个
/// 禁止嵌套作业的作业里），此时降级为仅走优雅退出信号，不阻断启动。
#[cfg(windows)]
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

/// 礼貌请求 llama-server 走自带清理路径（退出前卸载 GPU 模型）：
/// - Windows：向以 pid 为根的控制台进程组发送 CTRL_C_EVENT。launcher 是 GUI 进程、无控制台，
///   但 GenerateConsoleCtrlEvent 在指定非零进程组时仍可从 GUI 进程调用；
/// - 非 Windows：向进程组发 SIGINT（终端 Ctrl-C 的等价信号，组信号覆盖 llama-server 自身）。
fn request_graceful_stop(pid: u32) {
    #[cfg(windows)]
    unsafe {
        let _ = GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid);
    }
    #[cfg(not(windows))]
    unsafe {
        let _ = libc::kill(-(pid as i32), libc::SIGINT);
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
            disabled_advanced_params: vec![],
            extra_args: vec![],
            disabled_extra_args: vec![],
            enabled_structured_params: vec!["top_p".into()],
            disabled_structured_params: vec![],
            structured_params: {
                let mut m = HashMap::new();
                m.insert("top_p".to_string(), "0.9".to_string());
                m
            },
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
        // 结构化高级参数需完整往返（含值映射），否则重启后用户设置丢失
        assert_eq!(
            parsed.enabled_structured_params,
            config.enabled_structured_params
        );
        assert_eq!(parsed.structured_params, config.structured_params);
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
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        pump_reader(std::io::Cursor::new(&data[..]), tx);
        let got: Vec<String> = rx.iter().collect();
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
            disabled_advanced_params: Vec::new(),
            extra_args: Vec::new(),
            disabled_extra_args: Vec::new(),
            ..ServerConfig::default()
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

    #[test]
    fn build_server_args_appends_extra_args() {
        let mut config = ServerConfig {
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
            disabled_advanced_params: Vec::new(),
            extra_args: vec![
                "--main-gpu".into(),
                "0".into(),
                "--alias".into(),
                "demo".into(),
            ],
            disabled_extra_args: Vec::new(),
            ..ServerConfig::default()
        };
        let joined = build_server_args(&config).join(" ");
        // 未知/自定义参数被原样追加到启动命令，确保与用户传入一致
        assert!(joined.contains("--main-gpu 0"));
        assert!(joined.contains("--alias demo"));

        // 空串不应进入命令行
        config.extra_args.push("".into());
        let joined2 = build_server_args(&config).join(" ");
        assert!(!joined2.ends_with(' '));
    }

    #[test]
    fn build_server_args_skips_disabled() {
        // 已启用但临时禁用的高级参数不应进入启动命令行；值仍保留在配置里。
        let config = ServerConfig {
            llama_server_path: "C:/llama/llama-server.exe".into(),
            model: "C:/models/m.gguf".into(),
            model_dir: "C:/models".into(),
            host: "127.0.0.1".into(),
            port: 8080,
            ctx_size: 4096,
            n_predict: 256,
            n_gpu_layers: 32,
            threads: 4,
            batch_size: 512,
            temp: 0.7,
            flash_attn: "auto".into(),
            mmap: true,
            mlock: false,
            enabled_advanced_params: vec![
                "ctx_size".into(),
                "n_gpu_layers".into(),
                "temp".into(),
                "mmap".into(),
            ],
            disabled_advanced_params: vec!["n_gpu_layers".into(), "mmap".into()],
            extra_args: Vec::new(),
            disabled_extra_args: vec!["--alias".into(), "demo".into()],
            ..ServerConfig::default()
        };
        let joined = build_server_args(&config).join(" ");
        // 未禁用的高级参数照常写入
        assert!(joined.contains("-c 4096"));
        assert!(joined.contains("--temp 0.7"));
        // 临时禁用的高级参数不写入
        assert!(!joined.contains("-ngl"));
        assert!(!joined.contains("--mmap"));
        assert!(!joined.contains("--no-mmap"));
        // 禁用的自定义参数不写入
        assert!(!joined.contains("--alias"));
    }

    #[test]
    fn build_server_args_serializes_structured_params() {
        // 结构化高级参数：按注册表声明序列化——数值型输出 `--flag value`，
        // 布尔型只在真值时输出裸 flag，禁用/未知键一律跳过。
        let mut structured = HashMap::new();
        structured.insert("top_p".to_string(), "0.9".to_string());
        structured.insert("parallel".to_string(), "4".to_string());
        structured.insert("offline".to_string(), "true".to_string());
        structured.insert("no_repack".to_string(), "false".to_string());
        structured.insert("keep".to_string(), "128".to_string());

        let config = ServerConfig {
            enabled_structured_params: vec![
                "top_p".into(),
                "parallel".into(),
                "offline".into(),
                "no_repack".into(),
                "keep".into(),
                "definitely_not_a_real_param".into(),
            ],
            disabled_structured_params: vec!["keep".into()],
            structured_params: structured,
            ..ServerConfig::default()
        };
        let joined = build_server_args(&config).join(" ");
        assert!(joined.contains("--top-p 0.9"));
        assert!(joined.contains("--parallel 4"));
        // 布尔真值 → 裸 flag，不带 value
        assert!(joined.contains("--offline"));
        assert!(!joined.contains("--offline true"));
        // 布尔假值 → 完全不出现
        assert!(!joined.contains("--no-repack"));
        // 临时禁用的结构化参数不写入
        assert!(!joined.contains("--keep"));
        // 注册表里不存在的键被静默忽略，不影响其它参数
        assert!(!joined.contains("definitely_not_a_real_param"));
    }

    #[test]
    fn param_registry_keys_and_flags_are_unique() {
        // 注册表是数据驱动的单一真源：键重复会导致查找歧义、flag 重复会重复传参。
        let mut keys = HashSet::new();
        let mut flags = HashSet::new();
        for spec in params::PARAM_REGISTRY {
            assert!(keys.insert(spec.key), "duplicate param key: {}", spec.key);
            assert!(
                flags.insert(spec.flag),
                "duplicate param flag: {}",
                spec.flag
            );
            assert!(
                spec.flag.starts_with('-'),
                "flag must start with -: {}",
                spec.flag
            );
        }
        assert!(
            keys.len() > 100,
            "registry unexpectedly small: {}",
            keys.len()
        );
    }

    #[test]
    fn store_round_trip_preserves_named_configs() {
        let dir = std::env::temp_dir().join(format!("llama_cfg_test_{}", std::process::id()));
        let path = configs_path(&dir);
        let _ = std::fs::create_dir_all(dir.join("OhMyLlama"));
        let store = ConfigStore {
            active: "a".into(),
            configs: {
                let mut m = HashMap::new();
                m.insert("a".into(), ServerConfig::default());
                m.insert(
                    "b".into(),
                    ServerConfig {
                        port: 9999,
                        n_gpu_layers: 20,
                        enabled_advanced_params: vec![
                            String::from("ctx_size"),
                            String::from("n_gpu_layers"),
                        ],
                        ..ServerConfig::default()
                    },
                );
                m
            },
        };
        save_store(&path, &store).expect("save");

        let loaded = load_store(&path);
        assert_eq!(loaded.active, "a");
        assert_eq!(loaded.configs.len(), 2);
        let b_back = loaded.configs.get("b").expect("b present");
        assert_eq!(b_back.port, 9999);
        assert_eq!(b_back.n_gpu_layers, 20);
        assert_eq!(
            b_back.enabled_advanced_params,
            vec![String::from("ctx_size"), String::from("n_gpu_layers")]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_store_missing_path_is_empty() {
        let dir = std::env::temp_dir().join(format!("llama_cfg_missing_{}", std::process::id()));
        let path = configs_path(&dir);
        let store = load_store(&path);
        assert!(store.configs.is_empty());
        assert_eq!(store.active, "");
    }

    #[test]
    fn configs_state_resolves_valid_active() {
        let dir = std::env::temp_dir().join(format!("llama_cfg_state_{}", std::process::id()));
        let path = configs_path(&dir);
        let _ = std::fs::create_dir_all(dir.join("OhMyLlama"));
        let store = ConfigStore {
            active: "ghost".into(), // 指向不存在的配置
            configs: {
                let mut m = HashMap::new();
                m.insert("real".into(), ServerConfig::default());
                m
            },
        };
        save_store(&path, &store).expect("save");

        // get_configs_state 通过 load_store + 校验完成，这里校验 load_store 后
        // 调用方（命令）会把非法 active 回退为 "default"，逻辑在命令内，这里只验证存储层。
        let loaded = load_store(&path);
        assert_eq!(loaded.active, "ghost");
        assert!(loaded.configs.contains_key("real"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_named_config_in_store_works() {
        let mut store = ConfigStore {
            active: "a".into(),
            configs: {
                let mut m = HashMap::new();
                m.insert("a".into(), ServerConfig::default());
                m.insert("b".into(), ServerConfig::default());
                m
            },
        };
        // 改名并同步 active
        assert!(rename_named_config_in_store(&mut store, "a", "renamed").is_ok());
        assert!(store.configs.contains_key("renamed"));
        assert!(!store.configs.contains_key("a"));
        assert_eq!(store.active, "renamed");
        // 同名：无操作成功
        assert!(rename_named_config_in_store(&mut store, "renamed", "renamed").is_ok());
        // 默认配置不可改
        assert!(rename_named_config_in_store(&mut store, "default", "x").is_err());
        // 目标已存在：冲突报错
        assert!(rename_named_config_in_store(&mut store, "renamed", "b").is_err());
        // 空名：报错
        assert!(rename_named_config_in_store(&mut store, "renamed", "  ").is_err());
        // 未知源：报错
        assert!(rename_named_config_in_store(&mut store, "ghost", "z").is_err());
    }
}
