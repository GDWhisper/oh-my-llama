import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useI18n } from '../i18n';
import { LangSwitch } from './LangSwitch';
import { Button } from './Button';

interface Props {
  open: boolean;
  onClose: () => void;
  // 触发更新检查（由 App 的 useUpdater 提供）；checking 表示正在查询中。
  onCheckUpdate: () => void;
  checking: boolean;
}

const REPO_URL = 'https://github.com/GDWhisper/oh-my-llama';

// 设置浮窗：居中弹层，承载语言设置与关于（含手动「检查更新」）。
// 复用公共 modal 遮罩与样式。早期暂不提供「是否检查更新」开关（用户明确要求）。
export function SettingsDialog({ open, onClose, onCheckUpdate, checking }: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时取一次应用版本（来自 tauri.conf.json 的 version）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

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

          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">{t('about.title')}</span>
            </div>
            <div className="about-row">
              <span className="settings-hint">{t('about.version')}</span>
              <span className="about-value">{version}</span>
            </div>
            <div className="about-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => openUrl(REPO_URL).catch(() => {})}
              >
                {t('about.repo')}
              </Button>
              <Button type="button" onClick={onCheckUpdate} disabled={checking}>
                {checking ? t('update.checking') : t('update.check')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
