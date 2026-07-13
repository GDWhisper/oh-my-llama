import { useEffect, useState } from 'react';
import { Button } from './Button';

type DialogMode = 'save-as-new' | 'create-empty';

interface Props {
  open: boolean;
  mode: DialogMode;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

// 命名弹窗：用于「保存为新配置」与「新建空配置」。
// 不填写名称时，调用方会按日期时间自动生成。
export function NameDialog({ open, mode, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) {
      setValue('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) {
    return null;
  }

  const title = mode === 'save-as-new' ? '保存为新配置' : '新建配置';
  const hint =
    mode === 'save-as-new'
      ? '当前是默认配置，将生成一个新的配置。'
      : '将创建一个空白（默认参数）的新配置。';

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="modal-hint">{hint}</p>
        <input
          autoFocus
          className="name-input"
          placeholder="若不填写将按日期时间自动生成"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onConfirm(value);
            }
          }}
        />
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(value)}>确定</Button>
        </div>
      </div>
    </div>
  );
}
