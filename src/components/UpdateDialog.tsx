import { useEffect } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';
import type { UpdaterStatus } from '../hooks/useUpdater';

interface Props {
  status: UpdaterStatus;
  onDownload: () => void;
  onCancel: () => void;
  onInstall: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

// 更新浮窗（方案 A）：仅在有结果时渲染（available / downloading / ready / no-update / error）。
// idle / checking 为瞬态，由设置里的「检查更新」按钮承担。
export function UpdateDialog({
  status,
  onDownload,
  onCancel,
  onInstall,
  onDismiss,
  onRetry,
}: Props) {
  const { t } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (status.kind === 'downloading') onCancel();
        else onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status.kind, onCancel, onDismiss]);

  if (status.kind === 'idle' || status.kind === 'checking') return null;

  const close = status.kind === 'downloading' ? onCancel : onDismiss;

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal update-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('update.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="modal-close"
          aria-label={t('common.close')}
          onClick={close}
        >
          ×
        </button>

        {status.kind === 'available' && (
          <div className="modal-body">
            <div className="modal-title">{t('update.title')}</div>
            <div className="update-versions">
              <span className="update-ver old">{status.current}</span>
              <span className="update-arrow">→</span>
              <span className="update-ver new">{status.version}</span>
            </div>
            {status.body ? <pre className="update-notes">{status.body.trim()}</pre> : null}
            <div className="modal-actions">
              <Button variant="secondary" type="button" onClick={onDismiss}>
                {t('update.later')}
              </Button>
              <Button type="button" onClick={onDownload}>
                {t('update.download')}
              </Button>
            </div>
          </div>
        )}

        {status.kind === 'downloading' && (
          <div className="modal-body">
            <div className="modal-title">{t('update.downloading')}</div>
            <div className="progress">
              <div
                className="progress-bar"
                style={{
                  width:
                    status.total && status.total > 0
                      ? `${Math.min(100, (status.received / status.total) * 100).toFixed(1)}%`
                      : '40%',
                }}
              />
            </div>
            <div className="progress-label">
              {status.total && status.total > 0
                ? `${fmtBytes(status.received)} / ${fmtBytes(status.total)}`
                : fmtBytes(status.received)}
            </div>
            <div className="modal-actions">
              <Button variant="secondary" type="button" onClick={onCancel}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        )}

        {status.kind === 'ready' && (
          <div className="modal-body">
            <div className="modal-title">{t('update.title')}</div>
            <p className="update-ready-text">{t('update.ready')}</p>
            <div className="modal-actions">
              <Button variant="secondary" type="button" onClick={onDismiss}>
                {t('update.later')}
              </Button>
              <Button type="button" onClick={onInstall}>
                {t('update.installNow')}
              </Button>
            </div>
          </div>
        )}

        {status.kind === 'no-update' && (
          <div className="modal-body">
            <div className="modal-title">{t('update.title')}</div>
            <p className="update-ready-text">{t('update.noUpdate')}</p>
            <div className="modal-actions">
              <Button type="button" onClick={onDismiss}>
                {t('common.ok')}
              </Button>
            </div>
          </div>
        )}

        {status.kind === 'error' && (
          <div className="modal-body">
            <div className="modal-title">{t('update.error')}</div>
            <p className="update-ready-text">{t('update.errorBody')}</p>
            <div className="modal-actions">
              <Button variant="secondary" type="button" onClick={onDismiss}>
                {t('common.close')}
              </Button>
              <Button type="button" onClick={onRetry}>
                {t('update.retry')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
