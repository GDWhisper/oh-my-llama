import type { ServerConfig } from '../types';
import { modelBasename } from '../lib/advanced';
import { useI18n } from '../i18n';
import { PathField } from './PathField';
import { ModelSelect } from './ModelSelect';

interface Props {
  config: ServerConfig;
  // 检测到的 .gguf 模型文件名列表（不含绝对路径，仅用于下拉框展示）
  models: string[];
  onChange: (config: ServerConfig) => void;
}

// 目录路径与模型名拼接为完整模型文件路径（llama-server 需要的 --model 参数）。
// 用 / 作分隔符，Windows 与 llama.cpp 均接受。
const joinModelPath = (dir: string, name: string): string => `${dir.replace(/[\\/]$/, '')}/${name}`;

export function BasicParamsPanel({ config, models, onChange }: Props) {
  const { t } = useI18n();
  const serverFilters = [
    { name: t('basic.filterExe'), extensions: ['exe'] },
    { name: t('basic.filterAll'), extensions: ['*'] },
  ];
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
      <h2>{t('basic.title')}</h2>
      <div className="fields">
        <PathField
          label={t('basic.serverPath')}
          value={config.llama_server_path}
          filters={serverFilters}
          onChange={(value) => onChange({ ...config, llama_server_path: value })}
        />
        <PathField
          label={t('basic.modelDir')}
          value={config.model_dir}
          directory
          onChange={handleDirChange}
        />
        <div className="field">
          <label>{t('basic.selectModel')}</label>
          <ModelSelect
            models={models}
            value={selectedBasename}
            disabled={!dirSet}
            onSelect={handleModelSelect}
          />
        </div>
        <div className="field">
          <label>{t('basic.host')}</label>
          <input
            value={config.host}
            onChange={(event) => onChange({ ...config, host: event.currentTarget.value })}
          />
        </div>
        <div className="field">
          <label>{t('basic.port')}</label>
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
