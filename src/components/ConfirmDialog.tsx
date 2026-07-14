import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  // 确认按钮是否为危险操作（红色实心），用于「清空/删除」等不可逆动作。
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 通用二次确认弹窗：遮罩居中、点击遮罩或按 Esc 关闭、确认/取消按钮走公共 Button。
 * 复用场景：清空参数、删除等需要用户显式确认的操作。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText,
  cancelText,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">{title}</div>
        <div className="modal-body">{message}</div>
        <div className="modal-actions">
          <Button variant="secondary" type="button" onClick={onCancel}>
            {cancelText ?? t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} type="button" onClick={onConfirm}>
            {confirmText ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
