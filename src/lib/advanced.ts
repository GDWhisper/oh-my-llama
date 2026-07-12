export const OPTIONAL_ADVANCED_OPTIONS = [
  { key: 'n_predict', label: '最大生成数' },
  { key: 'n_gpu_layers', label: 'GPU 层数' },
  { key: 'threads', label: 'CPU 线程数' },
  { key: 'batch_size', label: '批处理大小' },
  { key: 'temp', label: '温度' },
  { key: 'flash_attn', label: 'Flash Attention' },
  { key: 'mmap', label: 'mmap' },
  { key: 'mlock', label: 'mlock' },
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

export const ADVANCED_LABELS: Record<AdvancedKey, string> = {
  ctx_size: '上下文长度',
  n_predict: '最大生成数',
  n_gpu_layers: 'GPU 层数',
  threads: 'CPU 线程数',
  batch_size: '批处理大小',
  temp: '温度',
  flash_attn: 'Flash Attention',
  mmap: 'mmap',
  mlock: 'mlock',
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
