import type { ServerStatus } from '../types';

interface Props {
  status: ServerStatus | null;
  previewUrl: string;
  onOpenPreview: () => void;
}

export function PreviewBar({ status, previewUrl, onOpenPreview }: Props) {
  return (
    <div className="panel preview-bar">
      <div>
        <div className="preview-title">预览</div>
        <div className="preview-url">{previewUrl ? `预览地址：${previewUrl}` : '请先启动服务'}</div>
      </div>
      <div className="actions">
        <button className="secondary" onClick={onOpenPreview} disabled={!status?.running}>
          打开预览
        </button>
      </div>
    </div>
  );
}
