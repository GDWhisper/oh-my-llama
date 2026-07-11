import type { ServerConfig } from "../types";
import { modelBasename } from "../lib/advanced";

interface Props {
  config: ServerConfig;
  onChange: (config: ServerConfig) => void;
}

export function BasicParamsPanel({ config, onChange }: Props) {
  const modelLabel = modelBasename(config.model) || "模型文件";
  return (
    <div className="panel">
      <h2>必要参数</h2>
      <div className="fields">
        <div className="field">
          <label>llama-server 路径</label>
          <input
            value={config.llama_server_path}
            onChange={(event) => onChange({ ...config, llama_server_path: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label>模型路径</label>
          <input
            value={config.model}
            onChange={(event) => onChange({ ...config, model: event.currentTarget.value })}
          />
          {modelLabel !== config.model && <div className="field-hint">当前模型：{modelLabel}</div>}
        </div>
        <div className="field">
          <label>监听地址</label>
          <input
            value={config.host}
            onChange={(event) => onChange({ ...config, host: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label>监听端口</label>
          <input
            type="number"
            value={config.port}
            onChange={(event) => onChange({ ...config, port: Number(event.currentTarget.value || 0) })}
          />
        </div>
      </div>
    </div>
  );
}
