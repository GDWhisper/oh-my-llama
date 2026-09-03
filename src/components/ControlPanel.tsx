import type { ServerConfig, ServerStatus } from '../types';
import { modelBasename } from '../lib/advanced';
import { serverStatusState } from '../lib/statusState';
import { useI18n } from '../i18n';
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
  const { t } = useI18n();
  // 当前模型小字提示：空路径显示"未选择"，文件不存在红字告警，否则显示当前模型文件名。
  // 置于服务控制内、预览地址上方，启动前即可看到将要加载哪个模型。
  let modelHint: string | undefined;
  let modelHintTone: 'default' | 'error' = 'default';
  if (config) {
    const modelEmpty = !config.model.trim();
    const modelLabel = modelBasename(config.model) || t('control.modelFileFallback');
    if (modelEmpty) {
      modelHint = t('control.modelNone');
    } else if (modelMissing) {
      modelHint = t('control.modelMissing');
      modelHintTone = 'error';
    } else {
      modelHint = t('control.currentModel', { name: modelLabel });
    }
  }

  // 是否禁用了 Web UI：自定义参数（extra_args 成对 [flag, value, ...]）中出现 --no-webui。
  const noWebui =
    !!config && config.extra_args.some((flag, i) => i % 2 === 0 && flag === '--no-webui');

  // 与头部徽章同一套五态判定：external（端口被外部服务占用）时不应把外部地址当自己的
  // 服务地址展示、也不提供"打开预览"/"停止"——归属与操作语义保持一致。
  // 此处不感知 unresponsive（无响应态只影响徽章文案，不影响本区操作可用性）。
  const statusState = serverStatusState(status, false);

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
          {statusState === 'running'
            ? t('control.serverAddr', { url: previewUrl })
            : statusState === 'external'
              ? t('control.externalAddr', { url: status?.url ?? '' })
              : statusState === 'loading'
                ? t('control.loading')
                : t('control.serverAddrStopped')}
        </div>
      </div>
      <div className="actions">
        <Button variant="secondary" onClick={onStart} disabled={starting || status?.managed}>
          {starting || (status?.managed && !status?.running)
            ? t('control.starting')
            : t('control.start')}
        </Button>
        <Button
          variant={status?.managed ? 'danger' : 'secondary'}
          onClick={onStop}
          disabled={stopping || !status?.managed}
        >
          {stopping ? t('control.stopping') : t('control.stop')}
        </Button>
        <Button
          variant="secondary"
          onClick={onOpenPreview}
          disabled={statusState !== 'running' || noWebui}
          title={noWebui ? t('control.previewDisabled') : undefined}
        >
          {t('control.openPreview')}
        </Button>
      </div>
    </div>
  );
}
