import type { UiTheme } from '../types';

/** 后端 ui_theme → 前端主题：null/未知值一律兜底羊皮纸（与旧 settings.json 兼容）。 */
export function normalizeUiTheme(raw: string | null | undefined): UiTheme {
  return raw === 'default' ? 'default' : 'parchment';
}

/** 立即写 html[data-theme]，CSS 变量整组切换。 */
export function applyUiTheme(theme: UiTheme) {
  document.documentElement.setAttribute('data-theme', theme);
}
