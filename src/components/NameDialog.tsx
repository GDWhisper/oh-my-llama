import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

type DialogMode = 'save-as-new' | 'create-empty' | 'rename';

interface Props {
  open: boolean;
  mode: DialogMode;
  // 重命名模式下预填的当前名称；其它模式忽略。
  defaultValue?: string;
  // 可回填的模型名称候选（已去目录与 .gguf 后缀）；为空时不显示「填入模型名称」按钮。
  modelSuggestion?: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

// 命名弹窗：用于「保存为新配置」「新建空配置」「重命名配置」。
// 不填写名称时，save-as-new / create-empty 会按日期时间自动生成；rename 模式不允许为空。
export function NameDialog({
  open,
  mode,
  defaultValue,
  modelSuggestion,
  onConfirm,
  onCancel,
}: Props) {
  const { t } = useI18n();
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
  const title = isRename
    ? t('name.renameTitle')
    : mode === 'save-as-new'
      ? t('name.saveAsNewTitle')
      : t('name.createTitle');
  const hint = isRename
    ? t('name.renameHint')
    : mode === 'save-as-new'
      ? t('name.saveAsNewHint')
      : t('name.createHint');

  // 仅把模型名回填进输入框，不代为确认：用户可继续编辑后再自行提交。
  const fillModelName = () => {
    if (modelSuggestion) {
      setValue(modelSuggestion);
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p className="modal-hint">{hint}</p>
        <input
          autoFocus
          className="name-input"
          placeholder={isRename ? t('name.renamePlaceholder') : t('name.autoPlaceholder')}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onConfirm(value);
            }
          }}
        />
        {modelSuggestion && (
          <div className="name-fill-row">
            <Button
              variant="secondary"
              type="button"
              // 不抢输入框焦点：回填后用户可直接继续编辑或回车确认（焦点若留在按钮上，
              // 回车会反复触发「填入」而非提交）。
              onMouseDown={(event) => event.preventDefault()}
              onClick={fillModelName}
            >
              {t('name.fillModelName')}
            </Button>
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => onConfirm(value)}>{t('common.ok')}</Button>
        </div>
      </div>
    </div>
  );
}
