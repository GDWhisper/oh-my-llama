// i18n 模块桶文件：仅 re-export 非组件（useI18n hook 与类型），不含任何组件定义，
// 以满足 react-refresh/only-export-components 约定（组件 I18nProvider 在 ./I18nProvider.tsx，
// 由 main.tsx 直接导入）。本文件不导出组件，故不会触发该规则。
export { useI18n } from './useI18n';
export type { Lang, MessageKey, Translator } from './messages';
