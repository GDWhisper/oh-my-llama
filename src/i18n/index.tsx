import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, zh, type Lang, type MessageKey, type Translator } from './messages';

// 轻量自研 i18n（无外部依赖）：Context + useI18n hook。
// 语言持久化到 localStorage（应用级、跨配置生效），默认中文。

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en };
const STORAGE_KEY = 'oh-my-llama:lang';

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      return saved;
    }
  } catch {
    // localStorage 不可用时退回默认
  }
  return 'zh';
}

interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translator;
}

const I18nContext = createContext<I18nContextValue | null>(null);

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

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n 必须在 I18nProvider 内使用');
  }
  return ctx;
}

export type { Lang, MessageKey, Translator } from './messages';
