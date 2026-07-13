import type { ServerConfig } from '../types';
import { modelBasename } from '../lib/advanced';
import { PathField } from './PathField';
import { Button } from './Button';

interface Props {
  config: ServerConfig;
  // 检测到的 .gguf 模型文件名列表（不含绝对路径，仅用于下拉框展示）
  models: string[];
  saving: boolean;
  onSave: () => void;
  onChange: (config: ServerConfig) => void;
}

const SERVER_FILTERS = [
  { name: '可执行文件', extensions: ['exe'] },
  { name: '所有文件', extensions: ['*'] },
];

// 目录路径与模型名拼接为完整模型文件路径（llama-server 需要的 --model 参数）。
// 用 / 作分隔符，Windows 与 llama.cpp 均接受。
const joinModelPath = (dir: string, name: string): string => `${dir.replace(/[\\/]$/, '')}/${name}`;

export function BasicParamsPanel({ config, models, saving, onSave, onChange }: Props) {
  const dirSet = !!config.model_dir.trim();
  const selectedBasename = config.model ? modelBasename(config.model) : '';

  // 选择模型目录：重置已选模型（旧路径在新目录下大概率失效）。
  const handleDirChange = (dir: string) => {
    onChange({ ...config, model_dir: dir, model: '' });
  };
  // 从下拉框选择模型：拼接目录 + 模型名，回填完整路径（仅展示模型名）。
  const handleModelSelect = (name: string) => {
    onChange({ ...config, model: name ? joinModelPath(config.model_dir, name) : '' });
  };

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
        <PathField label="模型目录" value={config.model_dir} directory onChange={handleDirChange} />
        <div className="field">
          <label>选择模型</label>
          <select
            className="model-select"
            value={selectedBasename}
            disabled={!dirSet}
            onChange={(event) => handleModelSelect(event.currentTarget.value)}
          >
            <option value="" disabled>
              {!dirSet
                ? '请先选择模型目录'
                : models.length > 0
                  ? '选择模型…'
                  : '该目录下无 .gguf 模型'}
            </option>
            {models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
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
            onChange={(event) =>
              onChange({ ...config, port: Number(event.currentTarget.value || 0) })
            }
          />
        </div>
      </div>
      <div className="panel-actions">
        <Button onClick={onSave} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>
    </div>
  );
}
