import type { MessageKey } from '../i18n/messages';

// 可选高级参数键集合。标签文案统一走 i18n（advanced.label.<key>），此处只保留键。
export const OPTIONAL_ADVANCED_OPTIONS = [
  { key: 'n_predict' },
  { key: 'n_gpu_layers' },
  { key: 'threads' },
  { key: 'batch_size' },
  { key: 'temp' },
  { key: 'flash_attn' },
  { key: 'mmap' },
  { key: 'mlock' },
] as const;

export type OptionalAdvancedKey = (typeof OPTIONAL_ADVANCED_OPTIONS)[number]['key'];

export type AdvancedKey = 'ctx_size' | OptionalAdvancedKey;

export type AdvancedOption = (typeof OPTIONAL_ADVANCED_OPTIONS)[number];

export const ADVANCED_ORDER: AdvancedKey[] = [
  'ctx_size',
  'n_predict',
  'n_gpu_layers',
  'threads',
  'batch_size',
  'temp',
  'flash_attn',
  'mmap',
  'mlock',
];

// 高级参数键 → i18n 文案键（advanced.label.<key>）。UI 用 t(ADVANCED_LABEL_KEYS[key]) 取译文。
export const ADVANCED_LABEL_KEYS: Record<AdvancedKey, MessageKey> = {
  ctx_size: 'advanced.label.ctx_size',
  n_predict: 'advanced.label.n_predict',
  n_gpu_layers: 'advanced.label.n_gpu_layers',
  threads: 'advanced.label.threads',
  batch_size: 'advanced.label.batch_size',
  temp: 'advanced.label.temp',
  flash_attn: 'advanced.label.flash_attn',
  mmap: 'advanced.label.mmap',
  mlock: 'advanced.label.mlock',
};

// 高级参数键 → llama.cpp 原始 flag。UI 用于展示「名称（原始参数）」对照，
// 让用户把应用内的中文名与真正写入命令行的 flag 对应起来。取规范长形式（--xxx）。
export const ADVANCED_FLAG: Record<AdvancedKey, string> = {
  ctx_size: '--ctx-size',
  n_predict: '--n-predict',
  n_gpu_layers: '--n-gpu-layers',
  threads: '--threads',
  batch_size: '--batch-size',
  temp: '--temp',
  flash_attn: '--flash-attn',
  mmap: '--mmap',
  mlock: '--mlock',
};

export function isUnlimitedPredict(value: number) {
  return value === -1;
}

export function modelBasename(path: string) {
  const cleaned = path.trim();
  if (!cleaned) return '';
  const normalized = cleaned.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : cleaned;
}
