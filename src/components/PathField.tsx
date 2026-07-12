import { open } from '@tauri-apps/plugin-dialog';

interface DialogFilter {
  name: string;
  extensions: string[];
}

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  filters?: DialogFilter[];
  hint?: string;
}

// 通过 Tauri 官方 dialog 插件打开系统原生文件对话框，回填真实绝对路径。
// 前端只负责触发原生能力并把结果交回上层，不在此实现任何文件读写逻辑（严守分层）。
export function PathField({ label, value, onChange, filters, hint }: Props) {
  const pick = async () => {
    const selected = await open({ multiple: false, filters });
    if (typeof selected === 'string') {
      onChange(selected);
    }
  };

  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-path">
        <input value={value} onChange={(event) => onChange(event.currentTarget.value)} />
        <button type="button" className="browse-btn" onClick={pick}>
          浏览…
        </button>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
