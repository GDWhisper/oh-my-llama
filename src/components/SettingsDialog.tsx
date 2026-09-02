import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { REPO_URL } from '../lib/repo';
import { LangSwitch } from './LangSwitch';
import { Button } from './Button';
import type { AppSettings } from '../types';
import type { PendingUpdate } from '../hooks/useUpdater';

// 各分组标题前的装饰小图标：stroke 风格与弹窗关闭按钮一致，仅辅助扫读，不参与语义。
const sectionIcons = {
  language: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <ellipse cx="8" cy="8" rx="2.9" ry="6.2" />
      <path d="M2.4 5.6h11.2M2.4 10.4h11.2" />
    </svg>
  ),
  proxy: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33" />
      <path d="M14 2v3.33h-3.33" />
    </svg>
  ),
  windowClose: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" />
      <path d="M6.4 6.7l3.2 2.6M9.6 6.7l-3.2 2.6" />
    </svg>
  ),
  about: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.4M8 5.1h.01" />
    </svg>
  ),
} as const;

interface Props {
  open: boolean;
  onClose: () => void;
  // 触发更新检查（由 App 的 useUpdater 提供）；checking 表示正在查询中。
  onCheckUpdate: () => void;
  checking: boolean;
  // 已知有可用更新（驱动版本号旁的 NEW 徽标）；为 null 时不显示徽标。
  pendingUpdate: PendingUpdate | null;
  // 点击 NEW 徽标：关闭设置并打开交互式更新弹窗。
  onOpenUpdate: () => void;
}

// 设置浮窗：居中弹层，承载语言设置与关于（含手动「检查更新」+「自动检查」开关）。
// 复用公共 modal 遮罩与样式。
export function SettingsDialog({
  open,
  onClose,
  onCheckUpdate,
  checking,
  pendingUpdate,
  onOpenUpdate,
}: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState('');
  const [proxy, setProxy] = useState('');
  const [autoCheck, setAutoCheck] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyError, setProxyError] = useState('');
  // 窗口关闭行为三态：null = 每次询问（未选择过的默认），true = 最小化到托盘，false = 直接退出。
  const [closePref, setClosePref] = useState<boolean | null>(null);

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

  // 打开时读取「更新代理 + 自动检查」设置。
  useEffect(() => {
    if (!open) return;
    setProxySaved(false);
    setProxyError('');
    invoke<AppSettings>('read_settings')
      .then((s) => {
        setProxy(s.update_proxy ?? '');
        setAutoCheck(Boolean(s.auto_check_updates));
        setClosePref(s.minimize_to_tray ?? null);
      })
      .catch(() => {
        setProxy('');
        setAutoCheck(false);
        setClosePref(null);
      });
  }, [open]);

  // 切换「关闭窗口行为」并立即落盘：乐观回填，再以后端返回值校准。
  const saveClosePref = (pref: boolean | null) => {
    setClosePref(pref);
    invoke<AppSettings>('set_close_pref', { pref })
      .then((s) => setClosePref(s.minimize_to_tray ?? null))
      .catch(() => {});
  };

  // 保存「更新代理 + 自动检查」两项（settings.json），二者一并写入，互不覆盖。
  // 代理在「保存」按钮处落盘（见 onSaveProxy），自动检查开关则在勾选时即时落盘。
  const onSaveProxy = async () => {
    setProxySaved(false);
    setProxyError('');
    try {
      const s = await invoke<AppSettings>('save_settings', {
        updateProxy: proxy,
        autoCheckUpdates: autoCheck,
      });
      setProxy(s.update_proxy);
      setAutoCheck(Boolean(s.auto_check_updates));
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
              <span className="settings-label">
                {sectionIcons.language}
                {t('settings.language')}
              </span>
              <span className="settings-hint">{t('settings.languageHint')}</span>
            </div>
            <LangSwitch variant="list" />
          </div>

          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">
                {sectionIcons.proxy}
                {t('settings.updateProxy')}
              </span>
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
              <span className="settings-label">
                {sectionIcons.windowClose}
                {t('settings.windowClose')}
              </span>
              <span className="settings-hint">{t('settings.windowCloseHint')}</span>
            </div>
            <label className="settings-option-row">
              <input
                type="radio"
                name="close-pref"
                className="settings-checkbox"
                checked={closePref === null}
                onChange={() => saveClosePref(null)}
              />
              <span className="settings-check-label">{t('settings.windowCloseAsk')}</span>
            </label>
            <label className="settings-option-row">
              <input
                type="radio"
                name="close-pref"
                className="settings-checkbox"
                checked={closePref === true}
                onChange={() => saveClosePref(true)}
              />
              <span className="settings-check-label">{t('settings.windowCloseTray')}</span>
            </label>
            <label className="settings-option-row">
              <input
                type="radio"
                name="close-pref"
                className="settings-checkbox"
                checked={closePref === false}
                onChange={() => saveClosePref(false)}
              />
              <span className="settings-check-label">{t('settings.windowCloseQuit')}</span>
            </label>
          </div>

          <div className="settings-section">
            <div className="settings-section-head">
              <span className="settings-label">
                {sectionIcons.about}
                {t('about.title')}
              </span>
            </div>
            <div className="about-row">
              <span className="settings-hint">{t('about.version')}</span>
              <span className="about-meta">
                <span className="about-value">{version}</span>
                {pendingUpdate && (
                  <button
                    type="button"
                    className="update-badge"
                    title={t('update.badgeTitle')}
                    aria-label={t('update.badgeTitle')}
                    onClick={() => {
                      onClose();
                      onOpenUpdate();
                    }}
                  >
                    {t('update.badgeNew')}
                  </button>
                )}
              </span>
            </div>
            <label className="settings-option-row">
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={autoCheck}
                onChange={(event) => {
                  setAutoCheck(event.target.checked);
                  // 立即落盘（含当前代理值），无需点「保存」也能记住开关。
                  invoke<AppSettings>('save_settings', {
                    updateProxy: proxy,
                    autoCheckUpdates: event.target.checked,
                  })
                    .then((s) => {
                      setProxy(s.update_proxy);
                      setAutoCheck(Boolean(s.auto_check_updates));
                    })
                    .catch(() => {});
                }}
              />
              <span className="settings-check-label">{t('settings.autoCheck')}</span>
            </label>
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
