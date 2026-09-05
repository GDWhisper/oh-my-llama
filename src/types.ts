export interface ServerConfig {
  llama_server_path: string;
  model: string;
  model_dir: string;
  host: string;
  port: number;
  ctx_size: number;
  n_predict: number;
  n_gpu_layers: number;
  threads: number;
  batch_size: number;
  temp: number;
  flash_attn: string;
  mmap: boolean;
  mlock: boolean;
  enabled_advanced_params: string[];
  // 临时禁用的高级参数键：卡片仍显示、值保留，但本次启动不写入命令行。
  disabled_advanced_params: string[];
  // 一键传参写入的自定义参数：原样追加到启动命令行末尾（含未知 flag）。
  extra_args: string[];
  // 临时禁用的自定义参数（双列表方案）：文本保留但不写入启动命令行。
  disabled_extra_args: string[];
  // ── 结构化高级参数（数据驱动，声明真源见 src-tauri/src/params.rs）──────
  // 已启用（卡片显示）的参数键，顺序 = 用户添加顺序 = 命令行顺序。
  enabled_structured_params: string[];
  // 临时禁用：卡片仍显示、值保留，但本次启动不写入命令行。
  disabled_structured_params: string[];
  // 值统一以字符串存储，类型/默认值/候选项由注册表声明，渲染与序列化时按声明还原。
  structured_params: Record<string, string>;
}

// 结构化高级参数的类型标签，与 Rust params::ParamType 一一对应。
export type ParamType = 'int' | 'float' | 'bool' | 'str' | 'enum';

// 单个官方参数的声明。后端 get_param_registry 返回该数组，前端据此通用渲染控件，
// 避免为每个参数硬编码一段 UI（约 160 个参数）。
export interface ParamSpec {
  key: string;
  flag: string;
  type: ParamType;
  default: string;
  min?: number;
  max?: number;
  choices?: string[];
  enabled_by_default: boolean;
}

export interface ServerStatus {
  running: boolean;
  // 是否由本应用拉起：仅受管的服务允许本应用停止（外部服务不归本应用管）。
  managed: boolean;
  pid: number | null;
  port: number;
  host: string;
  url: string;
}

// 多配置管理：默认配置（只读模板）+ 命名配置库 + 当前选中名。
// active 为 "default" 时表示处于默认配置。
export interface ConfigsState {
  default: ServerConfig;
  configs: Record<string, ServerConfig>;
  active: string;
}

export interface ServerLogLine {
  ts: string;
  level: string;
  text: string;
}

// llama-server 推理性能快照（perf://update 载荷 / get_perf_stats 返回值）。
// 由后端解析 llama-server 日志中的 timings 行而来，无需 --metrics 等额外参数：
// last_* = 最近一次请求；*_total = 当前服务进程生命周期内的累计（平均 = Σtokens / Σ时间，前端派生）。
// 服务进程启动/退出时后端清零并推送空快照，前端将无数据快照归一为 null 以隐藏区块。
export interface PerfSnapshot {
  last_prompt_tokens: number | null;
  last_prompt_ms: number | null;
  last_prompt_tps: number | null;
  last_gen_tokens: number | null;
  last_gen_ms: number | null;
  last_gen_tps: number | null;
  prompt_tokens_total: number;
  prompt_ms_total: number;
  gen_tokens_total: number;
  gen_ms_total: number;
  requests: number;
}

// 应用级设置（与服务器启动配置 ServerConfig 解耦）。
// update_proxy 留空 = 更新直连；填写 = 仅走该代理地址。
// auto_check_updates = 启动时是否自动检查更新（不打扰：仅提示+徽标，绝不静默安装）。
// recent_servers = 本机用过的 llama-server 可执行文件路径（索引 0 最近用过），供路径输入框给候选。
// recent_model_dirs = 本机用过的模型目录（与 recent_servers 同款 MRU 机制），供模型目录输入框给候选。
// minimize_to_tray = 窗口关闭行为：null = 未选择过（关闭时弹窗询问）；
// true = 最小化到系统托盘；false = 直接退出。
// show_log_times = 日志是否显示时间戳：null = 未设置（默认显示，兼容旧 settings.json）；
// true = 显示，false = 隐藏（隐藏时时间列宽度让给日志正文）。
export interface AppSettings {
  update_proxy: string;
  auto_check_updates: boolean;
  recent_servers: string[];
  recent_model_dirs: string[];
  minimize_to_tray: boolean | null;
  show_log_times: boolean | null;
}

// 路径输入框的候选项，llama-server 路径与模型目录共用
// （list_recent_servers / remove_recent_server / list_recent_model_dirs / remove_recent_model_dir 的载荷）。
// 后端把「最近用过」和「各命名配置里用过的路径」合并成一份候选；
// used_by_config = 该路径仍被某条命名配置引用 —— 从历史里忘掉它不会有可见效果，故不给 ×。
export interface PathCandidate {
  path: string;
  used_by_config: boolean;
}
