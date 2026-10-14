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
  mem_total_mb: number;
  mem_used_mb: number;
  gpus: GpuMetrics[];
}

type ItemKey = 'cpu' | 'mem' | 'gpu' | 'vram';
type WidgetStyle = 'default' | 'transparent';
type WidgetLayout = 'single' | 'double';
// 任务栏明暗（后端按 SystemUsesLightTheme 广播）：仅透明样式用于选文字色。
type WidgetTheme = 'light' | 'dark';

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

/** 样式归一化：未知值落回默认（settings.json 可被手改，事件载荷同理）。 */
function normalizeStyle(raw: unknown): WidgetStyle {
  return raw === 'transparent' ? 'transparent' : 'default';
}

/** 排列归一化：未知值落回单行。 */
function normalizeLayout(raw: unknown): WidgetLayout {
  return raw === 'double' ? 'double' : 'single';
}

/** 高占用告警线：显示值达到即染红。取 80 而非主面板占用条的 70/90 两档——
 *  条带只有一格字号，两档分不出主次，一档够传达「该看一眼」。 */
const HOT_PCT = 80;

interface PctText {
  text: string;
  hot: boolean;
}

/** 0-100 取整百分比 + 是否触线；非法/缺值显示顿号占位，不让条带出现 NaN。
 *  触线判定用四舍五入后的显示值，红色与看到的数字一致（79.6 显示 80% 即红）。 */
function pct(value: number | null): PctText {
  if (value === null || !Number.isFinite(value)) return { text: '—', hot: false };
  const rounded = Math.round(Math.max(0, Math.min(100, value)));
  return { text: `${rounded}%`, hot: rounded >= HOT_PCT };
}

function itemPct(key: ItemKey, snap: MetricsSnapshot | null): PctText {
  const gpu = snap?.gpus[0]; // 多卡时取第一张，与设置卡片/主面板口径一致
  switch (key) {
    case 'cpu':
      return pct(snap?.cpu_usage ?? null);
    case 'mem':
      return pct(snap?.mem_usage ?? null);
    case 'gpu':
      return pct(gpu?.usage ?? null);
    case 'vram':
      return pct(
        gpu && gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100 : null,
      );
  }
}

/** 紧凑容量对（GB 一位小数，单位只写一次）：如 22.1/31.9G——条带横向空间有限。 */
function gbPair(usedMb: number, totalMb: number): string | null {
  if (!Number.isFinite(usedMb) || !Number.isFinite(totalMb) || totalMb <= 0) return null;
  const g = (mb: number) => (mb / 1024).toFixed(1);
  return `${g(usedMb)}/${g(totalMb)}G`;
}

/** 详细数据（设置可关）：仅内存/显存有可展开的具体量——占用率本身即具体值；
 *  取不到数据时返回 null，条带只显示百分比。 */
function itemExtra(key: ItemKey, snap: MetricsSnapshot | null): string | null {
  if (!snap) return null;
  const gpu = snap.gpus[0];
  switch (key) {
    case 'mem':
      return gbPair(snap.mem_used_mb, snap.mem_total_mb);
    case 'vram':
      return gpu ? gbPair(gpu.vram_used_mb, gpu.vram_total_mb) : null;
    default:
      return null;
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
  const [style, setStyle] = useState<WidgetStyle>('default');
  const [layout, setLayout] = useState<WidgetLayout>('single');
  // 详细数据：内存/显存项在百分比后追加「已用/总量 GB」（设置卡片可开关）。
  const [detailed, setDetailed] = useState(false);
  // 透明样式的文字色由任务栏明暗决定；null = 后端还没给出（键缺失），
  // 由 CSS 的 prefers-color-scheme 兜底（见 widget.css）。
  const [theme, setTheme] = useState<WidgetTheme | null>(null);
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
        if (!alive) return;
        setItems(normalizeItems(s.taskbar_metrics_items));
        setStyle(normalizeStyle(s.taskbar_metrics_style));
        setLayout(normalizeLayout(s.taskbar_metrics_layout));
        setDetailed(Boolean(s.taskbar_metrics_detailed));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 后端事件：设置变更（勾选/样式/排列/详细数据）/ 可见性 / 任务栏朝向 / 任务栏明暗。
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
      listen<{ items?: unknown; style?: unknown; layout?: unknown; detailed?: unknown }>(
        'taskbar-widget://settings',
        (e) => {
          const p = e.payload ?? {};
          setItems(normalizeItems(p.items));
          setStyle(normalizeStyle(p.style));
          setLayout(normalizeLayout(p.layout));
          setDetailed(Boolean(p.detailed));
        },
      ),
    );
    track(listen<boolean>('taskbar-widget://visible', (e) => setVisible(Boolean(e.payload))));
    track(listen<boolean>('taskbar-widget://vertical', (e) => setVertical(Boolean(e.payload))));
    track(
      listen<string>('taskbar-widget://theme', (e) => {
        if (e.payload === 'light' || e.payload === 'dark') setTheme(e.payload);
      }),
    );
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

  // 类名组合：竖排 / 透明样式 / 两行排列 / 明暗主题（缺一不可，CSS 按此选色与布局）。
  const classes = [
    'taskbar-metrics',
    vertical ? 'vertical' : '',
    style === 'transparent' ? 'transparent' : '',
    layout === 'double' ? 'layout-double' : '',
    theme ? `theme-${theme}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={stripRef} className={classes}>
      {items.map((key) => {
        const { text, hot } = itemPct(key, snap);
        const extra = detailed ? itemExtra(key, snap) : null;
        return (
          <span key={key} className="taskbar-metrics-item">
            <span className="taskbar-metrics-label">{t(ITEM_LABEL[key])}</span>
            <span className={`taskbar-metrics-value${hot ? ' hot' : ''}`}>{text}</span>
            {extra && <span className="taskbar-metrics-extra">{extra}</span>}
          </span>
        );
      })}
    </div>
  );
}
