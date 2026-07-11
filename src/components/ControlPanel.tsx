import type { ServerStatus } from '../types';

interface Props {
  status: ServerStatus | null;
  starting: boolean;
  stopping: boolean;
  onStart: () => void;
  onStop: () => void;
  onOpenPreview: () => void;
}

export function ControlPanel({
  status,
  starting,
  stopping,
  onStart,
  onStop,
  onOpenPreview,
}: Props) {
  return (
    <div className="panel">
      <h2>服务控制</h2>
      <div className="actions">
        <button onClick={onStart} disabled={starting || status?.running}>
          {starting ? '正在启动...' : '启动'}
        </button>
        <button className="secondary" onClick={onStop} disabled={stopping || !status?.running}>
          {stopping ? '正在停止...' : '停止'}
        </button>
        <button className="secondary" onClick={onOpenPreview} disabled={!status?.running}>
          打开预览
        </button>
      </div>
    </div>
  );
}
