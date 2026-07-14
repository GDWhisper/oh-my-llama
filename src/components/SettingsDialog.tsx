import { useEffect } from 'react';
import { useI18n } from '../i18n';
import { LangSwitch } from './LangSwitch';

interface Props {
  open: boolean;
  onClose: () => void;
}

// 设置浮窗：居中弹层，当前承载语言设置。复用公共 modal 遮罩与样式。
export function SettingsDialog({ open, onClose }: Props) {
  const { t } = useI18n();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          {t('settings.title')}
          <button
            type="button"
            className="modal-close"
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">{t('settings.language')}</span>
              <span className="settings-hint">{t('settings.languageHint')}</span>
            </div>
            <LangSwitch variant="list" />
          </div>
        </div>
      </div>
    </div>
  );
}
