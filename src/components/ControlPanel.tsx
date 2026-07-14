import type { ServerConfig, ServerStatus } from '../types';
import { modelBasename } from '../lib/advanced';
import { Button } from './Button';

interface Props {
  status: ServerStatus | null;
  config: ServerConfig | null;
  modelMissing: boolean;
  modelSize: number | null;
  starting: boolean;
  stopping: boolean;
  previewUrl: string;
  onStart: () => void;
  onStop: () => void;
  onOpenPreview: () => void;
}

export function ControlPanel({
  status,
  config,
  modelMissing,
  modelSize,
  starting,
  stopping,
  previewUrl,
  onStart,
  onStop,
  onOpenPreview,
}: Props) {
  // 当前模型小字提示：空路径显示"未选择"，文件不存在红字告警，否则显示当前模型文件名。
  // 置于服务控制内、预览地址上方，启动前即可看到将要加载哪个模型。
  let modelHint: string | undefined;
  let modelHintTone: 'default' | 'error' = 'default';
  if (config) {
    const modelEmpty = !config.model.trim();
    const modelLabel = modelBasename(config.model) || '模型文件';
    if (modelEmpty) {
      modelHint = '当前模型：未选择';
    } else if (modelMissing) {
      modelHint = '模型文件不存在';
      modelHintTone = 'error';
    } else {
      modelHint = `当前模型：${modelLabel}`;
    }
  }

  // 是否禁用了 Web UI：自定义参数（extra_args 成对 [flag, value, ...]）中出现 --no-webui。
  const noWebui =
    !!config && config.extra_args.some((flag, i) => i % 2 === 0 && flag === '--no-webui');

  // 模型大小（字节 → GB），仅文件存在且已取到大小时展示。
  const modelSizeGb =
    modelSize != null && !modelMissing && config?.model.trim()
      ? (modelSize / 1024 / 1024 / 1024).toFixed(1)
      : null;

  return (
    <div className="header-controls">
      <div className="header-info">
        {modelHint && (
          <div
            className={`field-hint control-hint${modelHintTone === 'error' ? ' field-hint-error' : ''}`}
          >
            {modelHint}
            {modelSizeGb != null && <span className="model-size"> · {modelSizeGb} GB</span>}
          </div>
        )}
        <div className="preview-url">
          {previewUrl ? `服务地址：${previewUrl}` : '服务地址：服务未启动'}
        </div>
      </div>
      <div className="actions">
        <Button variant="secondary" onClick={onStart} disabled={starting || status?.running}>
          {starting ? '正在启动...' : '启动'}
        </Button>
        <Button
          variant={status?.running ? 'danger' : 'secondary'}
          onClick={onStop}
          disabled={stopping || !status?.running}
        >
          {stopping ? '正在停止...' : '停止'}
        </Button>
        <Button
          variant="secondary"
          onClick={onOpenPreview}
          disabled={!status?.running || noWebui}
          title={noWebui ? '预览因参数已禁用' : undefined}
        >
          打开预览
        </Button>
      </div>
    </div>
  );
}
