import { useI18n } from '../i18n';

interface Props {
  message: string;
  onDismiss: () => void;
}

// 底部轻量提示：进度条动画走完即自动消失，悬停暂停动画（见 App.css 的 animation-play-state），
// 也可点 × 立即关闭。消失时机直接由该动画的结束事件驱动，故暂停与倒计时不会失步。
// 时长只在 App.css 的 .toast-progress 里定义一处。
export function Toast({ message, onDismiss }: Props) {
  const { t } = useI18n();

  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-text">{message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label={t('common.close')}
        onClick={onDismiss}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
      <span
        className="toast-progress"
        aria-hidden="true"
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) onDismiss();
        }}
      />
    </div>
  );
}
