interface Props {
  saving: boolean;
  onSave: () => void;
}

export function ConfigPanel({ saving, onSave }: Props) {
  return (
    <div className="panel">
      <div className="section-header">
        <h2>配置</h2>
        <div className="actions">
          <button onClick={onSave} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </div>
      <div className="empty">
        高级参数按需添加；未加入的参数不会写入配置，启动时由 llama-server 自动决定。
      </div>
    </div>
  );
}
