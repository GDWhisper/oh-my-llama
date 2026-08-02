import { createContext, useContext } from 'react';
import type { Lang, Translator } from './messages';

// 上下文与 hook 单独成文件（非组件文件），避免与 I18nProvider 组件共处同一文件
// 触发 react-refresh/only-export-components 告警。index.tsx 仅做 re-export 桶，保持 import 路径兼容。

export interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translator;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error('useI18n 必须在 I18nProvider 内使用');
  }
  return ctx;
}

export type { Lang, MessageKey, Translator } from './messages';
