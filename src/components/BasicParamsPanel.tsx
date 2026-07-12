import type { ServerConfig } from '../types';
import { modelBasename } from '../lib/advanced';
import { PathField } from './PathField';

interface Props {
  config: ServerConfig;
  onChange: (config: ServerConfig) => void;
}

const SERVER_FILTERS = [
  { name: '可执行文件', extensions: ['exe'] },
  { name: '所有文件', extensions: ['*'] },
];

const MODEL_FILTERS = [
  { name: '模型文件', extensions: ['gguf', 'bin', 'ggml', 'safetensors'] },
  { name: '所有文件', extensions: ['*'] },
];

export function BasicParamsPanel({ config, onChange }: Props) {
  const modelLabel = modelBasename(config.model) || '模型文件';
  return (
    <div className="panel">
      <h2>必要参数</h2>
      <div className="fields">
        <PathField
          label="llama-server 路径"
          value={config.llama_server_path}
          filters={SERVER_FILTERS}
          onChange={(value) => onChange({ ...config, llama_server_path: value })}
        />
        <PathField
          label="模型路径"
          value={config.model}
          filters={MODEL_FILTERS}
          hint={modelLabel !== config.model ? `当前模型：${modelLabel}` : undefined}
          onChange={(value) => onChange({ ...config, model: value })}
        />
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
            onChange={(event) =>
              onChange({ ...config, port: Number(event.currentTarget.value || 0) })
            }
          />
        </div>
      </div>
    </div>
  );
}
