import { useEffect, useState } from 'react';
import { Button } from './Button';

type DialogMode = 'save-as-new' | 'create-empty' | 'rename';

interface Props {
  open: boolean;
  mode: DialogMode;
  // 重命名模式下预填的当前名称；其它模式忽略。
  defaultValue?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

// 命名弹窗：用于「保存为新配置」「新建空配置」「重命名配置」。
// 不填写名称时，save-as-new / create-empty 会按日期时间自动生成；rename 模式不允许为空。
export function NameDialog({ open, mode, defaultValue, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (open) {
      setValue(defaultValue ?? '');
    }
  }, [open, defaultValue]);

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

  const isRename = mode === 'rename';
  const title = isRename ? '重命名配置' : mode === 'save-as-new' ? '保存为新配置' : '新建配置';
  const hint = isRename
    ? '请输入新的配置名称。'
    : mode === 'save-as-new'
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
          placeholder={isRename ? '请输入新的配置名称' : '若不填写将按日期时间自动生成'}
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
