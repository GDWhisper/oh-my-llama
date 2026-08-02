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

// 应用级设置（与服务器启动配置 ServerConfig 解耦）。
// update_proxy 留空 = 更新直连；填写 = 仅走该代理地址。
export interface AppSettings {
  update_proxy: string;
}
