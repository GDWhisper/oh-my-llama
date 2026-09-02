import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';

interface CloseBehaviorDialogProps {
  open: boolean;
  // 用户的决策：minimize=true 最小化到托盘，false 直接退出；remember = 勾选了「记住选择」。
  onDecide: (minimize: boolean, remember: boolean) => void;
  // 仅关掉询问（Esc / 点击遮罩）：窗口保持打开，不落任何偏好。
  onCancel: () => void;
}

/**
 * 关闭行为询问弹窗：用户从未选择过「关闭窗口的行为」时，点击窗口 X 由后端触发。
 * 勾选「记住选择」后本次决策固化为偏好，此后不再询问（可在设置里更改）。
 * Esc / 点击遮罩 = 取消，窗口保持打开。
 */
export function CloseBehaviorDialog({ open, onDecide, onCancel }: CloseBehaviorDialogProps) {
  const { t } = useI18n();
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRemember(false);
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
        aria-label={t('tray.promptTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">{t('tray.promptTitle')}</div>
        <div className="modal-body">{t('tray.promptBody')}</div>
        <label className="settings-check-row">
          <input
            type="checkbox"
            className="settings-checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span className="settings-check-label">{t('tray.promptRemember')}</span>
        </label>
        <div className="modal-actions">
          <Button variant="secondary" type="button" onClick={() => onDecide(false, remember)}>
            {t('tray.promptQuit')}
          </Button>
          <Button variant="primary" type="button" onClick={() => onDecide(true, remember)}>
            {t('tray.promptMinimize')}
          </Button>
        </div>
      </div>
    </div>
  );
}
