import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { LangSwitch } from './LangSwitch';
import { Button } from './Button';
import type { AppSettings } from '../types';

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
  const [proxy, setProxy] = useState('');
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyError, setProxyError] = useState('');

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

  // 打开时读取「更新代理」设置。
  useEffect(() => {
    if (!open) return;
    setProxySaved(false);
    setProxyError('');
    invoke<AppSettings>('read_settings')
      .then((s) => setProxy(s.update_proxy ?? ''))
      .catch(() => setProxy(''));
  }, [open]);

  const onSaveProxy = async () => {
    setProxySaved(false);
    setProxyError('');
    try {
      const s = await invoke<AppSettings>('save_settings', {
        update_proxy: proxy,
      });
      setProxy(s.update_proxy);
      setProxySaved(true);
    } catch (e) {
      setProxyError(String(e));
    }
  };

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
              <span className="settings-label">{t('settings.updateProxy')}</span>
              <span className="settings-hint">{t('settings.updateProxyHint')}</span>
            </div>
            <div className="settings-proxy-row">
              <input
                className="settings-proxy-input"
                type="text"
                placeholder="http://127.0.0.1:7897"
                value={proxy}
                onChange={(event) => {
                  setProxy(event.target.value);
                  setProxySaved(false);
                }}
              />
              <Button variant="secondary" type="button" onClick={onSaveProxy}>
                {t('common.save')}
              </Button>
            </div>
            {proxySaved && (
              <div className="settings-proxy-ok">{t('settings.updateProxySaved')}</div>
            )}
            {proxyError && <div className="settings-proxy-err">{proxyError}</div>}
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
