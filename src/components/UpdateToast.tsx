import { useI18n } from '../i18n';
import type { UpdateToast as UpdateToastData } from '../hooks/useUpdater';

interface Props {
  toast: UpdateToastData;
  onView: () => void;
  onDismiss: () => void;
}

// 右上角自动检查提示（方案 A 的「自动检查」分支）：
// 仅由「自动检查」（启动时 + 周期轮询）发现新版本时出现，不打扰主流程——用户可关闭提示继续用，
// 也可点「查看」进入交互式更新弹窗（徽标长期保留在设置→关于→版本旁）。
export function UpdateToast({ toast, onView, onDismiss }: Props) {
  const { t } = useI18n();

  return (
    <div className="update-toast" role="status" aria-live="polite">
      <button
        type="button"
        className="update-toast-close"
        aria-label={t('common.close')}
        onClick={onDismiss}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
      <div className="update-toast-title">{t('update.toastTitle')}</div>
      <div className="update-toast-desc">
        {t('update.toastDesc', { version: toast.version, current: toast.current })}
      </div>
      <div className="update-toast-actions">
        <button type="button" className="update-toast-view" onClick={onView}>
          {t('update.toastView')}
        </button>
        <button type="button" className="update-toast-later" onClick={onDismiss}>
          {t('update.later')}
        </button>
      </div>
    </div>
  );
}
