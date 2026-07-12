import type { ServerConfig, ServerStatus } from '../types';
import { modelBasename } from '../lib/advanced';
import { Button } from './Button';

interface Props {
  status: ServerStatus | null;
  config: ServerConfig | null;
  modelMissing: boolean;
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

  return (
    <div className="header-controls">
      <div className="header-info">
        {modelHint && (
          <div
            className={`field-hint control-hint${modelHintTone === 'error' ? ' field-hint-error' : ''}`}
          >
            {modelHint}
          </div>
        )}
        <div className="preview-url">{previewUrl ? `预览地址：${previewUrl}` : '请先启动服务'}</div>
      </div>
      <div className="actions">
        <Button onClick={onStart} disabled={starting || status?.running}>
          {starting ? '正在启动...' : '启动'}
        </Button>
        <Button variant="secondary" onClick={onStop} disabled={stopping || !status?.running}>
          {stopping ? '正在停止...' : '停止'}
        </Button>
        <Button variant="secondary" onClick={onOpenPreview} disabled={!status?.running}>
          打开预览
        </Button>
      </div>
    </div>
  );
}
