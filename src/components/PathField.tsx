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
  directory?: boolean;
  hint?: string;
  hintTone?: 'default' | 'error';
}

// 通过 Tauri 官方 dialog 插件打开系统原生对话框，回填真实绝对路径。
// directory=true 时打开目录选择（用于模型目录）；否则打开文件选择。
// 前端只负责触发原生能力并把结果交回上层，不在此实现任何文件读写逻辑（严守分层）。
export function PathField({ label, value, onChange, filters, directory, hint, hintTone }: Props) {
  const pick = async () => {
    const selected = directory
      ? await open({ directory: true })
      : await open({ multiple: false, filters });
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
      {hint && (
        <div className={`field-hint${hintTone === 'error' ? ' field-hint-error' : ''}`}>{hint}</div>
      )}
    </div>
  );
}
