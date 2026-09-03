import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { en, zh, type Lang, type MessageKey, type Translator } from './messages';
import { I18nContext } from './useI18n';

// 轻量自研 i18n（无外部依赖）：Context + useI18n hook。
// 语言持久化到 localStorage（应用级、跨配置生效）；首次启动（无保存偏好）跟随系统语言，zh 系 → 中文，其余 → English。

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en };
const STORAGE_KEY = 'oh-my-llama:lang';

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      return saved;
    }
  } catch {
    // localStorage 不可用时退回系统语言检测
  }
  // 无保存偏好（首次启动）：跟随系统语言；navigator 不可用时兜底中文。
  try {
    return (navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 忽略持久化失败，仅内存生效
    }
  }, []);

  const t = useCallback<Translator>(
    (key, vars) => {
      // 缺 key 时回退到 zh，再回退到 key 本身，保证永不显示 undefined。
      let message: string = DICTS[lang][key] ?? zh[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          message = message.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value));
        }
      }
      return message;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
