import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from '../i18n';
import { LANG_STORAGE_KEY } from '../i18n/I18nProvider';
import type { MessageKey } from '../i18n/messages';
import type { AppSettings } from '../types';

interface GpuMetrics {
  usage: number;
  vram_total_mb: number;
  vram_used_mb: number;
}

interface MetricsSnapshot {
  cpu_usage: number;
  mem_usage: number;
  gpus: GpuMetrics[];
}

type ItemKey = 'cpu' | 'mem' | 'gpu' | 'vram';

// 与后端 taskbar_widget::ITEM_KEYS 对齐；顺序即条带内的显示顺序（后端已按此归一化）。
const ITEM_KEYS: readonly ItemKey[] = ['cpu', 'mem', 'gpu', 'vram'];

const ITEM_LABEL: Record<ItemKey, MessageKey> = {
  cpu: 'metrics.cpu',
  mem: 'metrics.memory',
  gpu: 'metrics.gpu',
  vram: 'metrics.vram',
};

// 与主窗口 MetricsPanel 同频，避免同一个采集器被两处不同节奏地刷新。
const INTERVAL = 1500;

/** 勾选项归一化：过滤未知键、按固定顺序排列（事件载荷可能带旧设置留下的脏值）。 */
function normalizeItems(raw: unknown): ItemKey[] {
  if (!Array.isArray(raw)) return [];
  return ITEM_KEYS.filter((key) => raw.includes(key));
}

/** 0-100 取整百分比；非法值显示顿号占位，不让条带出现 NaN。 */
function pct(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`;
}

function itemText(key: ItemKey, snap: MetricsSnapshot | null): string {
  if (!snap) return '—';
  const gpu = snap.gpus[0]; // 多卡时取第一张，与设置卡片/主面板口径一致
  switch (key) {
    case 'cpu':
      return pct(snap.cpu_usage);
    case 'mem':
      return pct(snap.mem_usage);
    case 'gpu':
      return gpu ? pct(gpu.usage) : '—';
    case 'vram':
      return gpu && gpu.vram_total_mb > 0 ? pct((gpu.vram_used_mb / gpu.vram_total_mb) * 100) : '—';
  }
}

/** 语言同步：主窗口切换语言写 localStorage，本窗口（同源）收 storage 事件跟随切换。 */
function useLangSync() {
  const { setLang } = useI18n();
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANG_STORAGE_KEY && (event.newValue === 'zh' || event.newValue === 'en')) {
        setLang(event.newValue);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [setLang]);
}

export function TaskbarMetrics() {
  useLangSync();
  const { t } = useI18n();
  // 首帧先按全选渲染，读到设置后再校准（避免空条带闪一下）。
  const [items, setItems] = useState<ItemKey[]>([...ITEM_KEYS]);
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  // 可见性真源在后端定位线程（任务栏自动隐藏 / 前台全屏时收条带）；WebView2 被
  // window.hide() 后不会翻 document.visibilityState，只能听事件（同主窗口的教训）。
  // 注意：**不要**接 `window://visible` 或其它主窗口可见性信号——主窗口最小化到托盘时
  // 主面板停表（省 CPU 的既有优化），而本小窗是「常驻监控」，托盘期必须照常刷新。
  const [visible, setVisible] = useState(true);
  const [vertical, setVertical] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // 挂载时读一次设置（后端广播可能早于监听注册，这里是兜底），之后随事件更新。
  useEffect(() => {
    let alive = true;
    invoke<AppSettings>('read_settings')
      .then((s) => {
        if (alive) setItems(normalizeItems(s.taskbar_metrics_items));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 后端事件：勾选项变更 / 可见性 / 任务栏朝向（竖任务栏时条带改竖排）。
  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const track = (pending: Promise<() => void>) => {
      pending
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch(() => {});
    };
    track(
      listen<string[]>('taskbar-widget://settings', (e) => setItems(normalizeItems(e.payload))),
    );
    track(listen<boolean>('taskbar-widget://visible', (e) => setVisible(Boolean(e.payload))));
    track(listen<boolean>('taskbar-widget://vertical', (e) => setVertical(Boolean(e.payload))));
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, []);

  // 指标轮询：条带被收起时完全停表（没人看就不刷，同主面板的门控思路）。
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    const tick = async () => {
      try {
        const next = await invoke<MetricsSnapshot>('get_system_metrics');
        if (alive) setSnap(next);
      } catch {
        // 采集异常保留旧值，下一拍重试（后端已按平台降级，此处只兜 IPC 异常）。
      }
    };
    const id = window.setInterval(tick, INTERVAL);
    tick();
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [visible]);

  // 尺寸上报：条带用 max-content 布局、不随窗口收缩，量出多少就报多少，
  // 由后端换算物理尺寸并落位；内容/朝向变化触发 ResizeObserver 自动重报。
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    let reported = '';
    const report = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const key = `${width}x${height}`;
      if (width <= 0 || height <= 0 || key === reported) return;
      reported = key;
      invoke('taskbar_widget_ready', { width, height }).catch(() => {});
    };
    const observer = new ResizeObserver(report);
    observer.observe(el);
    report();
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={stripRef} className={`taskbar-metrics${vertical ? ' vertical' : ''}`}>
      {items.map((key) => (
        <span key={key} className="taskbar-metrics-item">
          <span className="taskbar-metrics-label">{t(ITEM_LABEL[key])}</span>
          <span className="taskbar-metrics-value">{itemText(key, snap)}</span>
        </span>
      ))}
    </div>
  );
}
