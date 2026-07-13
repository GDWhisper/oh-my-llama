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
  // 一键传参写入的自定义参数：原样追加到启动命令行末尾（含未知 flag）。
  extra_args: string[];
}

export interface ServerStatus {
  running: boolean;
  pid: number | null;
  port: number;
  host: string;
  url: string;
}

export interface ServerLogLine {
  ts: string;
  level: string;
  text: string;
}
