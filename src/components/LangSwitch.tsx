import { useI18n } from '../i18n';

interface Props {
  // 'segment'：标题栏右侧分段按钮；'list'：设置浮窗内的列表式单选。
  variant?: 'segment' | 'list';
}

// 语言切换控件：中 / EN。切换即时生效并持久化。
export function LangSwitch({ variant = 'segment' }: Props) {
  const { lang, setLang } = useI18n();

  if (variant === 'list') {
    const items: { code: 'zh' | 'en'; label: string }[] = [
      { code: 'zh', label: '中文' },
      { code: 'en', label: 'English' },
    ];
    return (
      <div className="lang-list" role="radiogroup" aria-label="Language">
        {items.map((item) => (
          <button
            key={item.code}
            type="button"
            role="radio"
            aria-checked={lang === item.code}
            className={lang === item.code ? 'lang-list-item active' : 'lang-list-item'}
            onClick={() => setLang(item.code)}
          >
            <span>{item.label}</span>
            {lang === item.code && (
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6.5 11.2 3.3 8l1.1-1.1 2.1 2.1 5-5L12.6 5z" fill="currentColor" />
              </svg>
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="seg lang-switch" role="tablist" aria-label="Language">
      <button
        type="button"
        className={lang === 'zh' ? 'seg-btn active' : 'seg-btn'}
        onClick={() => setLang('zh')}
      >
        中
      </button>
      <button
        type="button"
        className={lang === 'en' ? 'seg-btn active' : 'seg-btn'}
        onClick={() => setLang('en')}
      >
        EN
      </button>
    </div>
  );
}
