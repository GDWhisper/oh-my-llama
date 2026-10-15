import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { useI18n, type MessageKey } from '../i18n';
import { REPO_URL } from '../lib/repo';
import { LangSwitch } from './LangSwitch';
import { Button } from './Button';
import type { AppSettings, UiTheme } from '../types';
import type { PendingUpdate } from '../hooks/useUpdater';
import { applyUiTheme, normalizeUiTheme } from '../lib/uiTheme';

// 任务栏小窗的可勾选参数：键与后端 taskbar_widget::ITEM_KEYS 对齐，顺序即小窗显示顺序。
const TASKBAR_ITEMS: Array<{ key: string; label: MessageKey }> = [
  { key: 'cpu', label: 'settings.taskbarMetricsCpu' },
  { key: 'mem', label: 'settings.taskbarMetricsMem' },
  { key: 'gpu', label: 'settings.taskbarMetricsGpu' },
  { key: 'vram', label: 'settings.taskbarMetricsVram' },
];

// 小窗样式与排列选项：键字符串与后端 taskbar_widget 的 STYLE_* / LAYOUT_* 常量对齐
// （后端对未知值宽松落回默认，前端选项即全部合法值）。
const TASKBAR_STYLES: Array<{ key: string; label: MessageKey }> = [
  { key: 'default', label: 'settings.taskbarMetricsStyleDefault' },
  { key: 'transparent', label: 'settings.taskbarMetricsStyleTransparent' },
];

const TASKBAR_LAYOUTS: Array<{ key: string; label: MessageKey }> = [
  { key: 'single', label: 'settings.taskbarMetricsLayoutSingle' },
  { key: 'double', label: 'settings.taskbarMetricsLayoutDouble' },
];

// 各分组标题前的装饰小图标：stroke 风格与弹窗关闭按钮一致，仅辅助扫读，不参与语义。
const sectionIcons = {
  language: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <ellipse cx="8" cy="8" rx="2.9" ry="6.2" />
      <path d="M2.4 5.6h11.2M2.4 10.4h11.2" />
    </svg>
  ),
  theme: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.4-.7 1.4-1.4 0-.4-.2-.8-.5-1.1-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4H12A2.2 2.2 0 0 0 14.2 7 6.2 6.2 0 0 0 8 1.8Z" />
      <circle cx="5.2" cy="7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="7.2" cy="4.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.2" cy="4.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  ),
  update: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M14 8a6 6 0 1 1-6-6c1.68 0 3.29.67 4.49 1.83L14 5.33" />
      <path d="M14 2v3.33h-3.33" />
    </svg>
  ),
  windowClose: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.8" />
      <path d="M6.4 6.7l3.2 2.6M9.6 6.7l-3.2 2.6" />
    </svg>
  ),
  startup: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.9v5.3" />
      <path d="M12.4 4.2a5.7 5.7 0 1 1-8.8 0" />
    </svg>
  ),
  taskbarMetrics: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.2 13.4h11.6" />
      <path d="M4.6 13.4V8.8M8 13.4V4.4M11.4 13.4v-2.6" />
    </svg>
  ),
  about: (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v3.4M8 5.1h.01" />
    </svg>
  ),
} as const;

interface Props {
  open: boolean;
  onClose: () => void;
  // 触发更新检查（由 App 的 useUpdater 提供）；checking 表示正在查询中。
  onCheckUpdate: () => void;
  checking: boolean;
  // 已知有可用更新（驱动版本号旁的 NEW 徽标）；为 null 时不显示徽标。
  pendingUpdate: PendingUpdate | null;
  // 点击 NEW 徽标：关闭设置并打开交互式更新弹窗。
  onOpenUpdate: () => void;
}

// 设置浮窗：居中弹层，承载语言、界面风格、更新（版本 / 自动检查 / 代理）、关闭窗口行为、
// 启动设置（开机自启 / 启动时最小化）与关于六组设置。
// 复用公共 modal 遮罩与样式。
export function SettingsDialog({
  open,
  onClose,
  onCheckUpdate,
  checking,
  pendingUpdate,
  onOpenUpdate,
}: Props) {
  const { t } = useI18n();
  const [version, setVersion] = useState('');
  const [proxy, setProxy] = useState('');
  const [autoCheck, setAutoCheck] = useState(false);
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyError, setProxyError] = useState('');
  // 窗口关闭行为三态：null = 每次询问（未选择过的默认），true = 最小化到托盘，false = 直接退出。
  const [closePref, setClosePref] = useState<boolean | null>(null);
  // 开机自启：true/false = 系统侧实况，null = 当前平台不支持（该行不渲染）。
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState('');
  // 启动时最小化：settings.json 里的布尔偏好，默认关闭（执行在后端启动阶段，下次启动生效）。
  const [startMinimized, setStartMinimized] = useState(false);
  const [startMinimizedError, setStartMinimizedError] = useState('');
  // 界面风格：null = 未设置（按羊皮纸渲染），'default' | 'parchment' = 用户选过。
  const [uiTheme, setUiTheme] = useState<UiTheme | null>(null);
  // 任务栏性能小窗：null = 本平台不支持（整张卡片不渲染）。
  const [taskbarMetrics, setTaskbarMetrics] = useState<{
    enabled: boolean;
    items: string[];
    style: string;
    layout: string;
    detailed: boolean;
  } | null>(null);
  const [taskbarSupported, setTaskbarSupported] = useState(false);
  const [taskbarMetricsError, setTaskbarMetricsError] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 打开时取一次应用版本（来自 tauri.conf.json 的 version）。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // 打开时读取「更新代理 + 自动检查」设置。
  useEffect(() => {
    if (!open) return;
    setProxySaved(false);
    setProxyError('');
    setTaskbarMetricsError('');
    setStartMinimizedError('');
    invoke<AppSettings>('read_settings')
      .then((s) => {
        setProxy(s.update_proxy ?? '');
        setAutoCheck(Boolean(s.auto_check_updates));
        setClosePref(s.minimize_to_tray ?? null);
        setUiTheme(normalizeUiTheme(s.ui_theme));
        setStartMinimized(Boolean(s.start_minimized));
        setTaskbarMetrics({
          enabled: Boolean(s.taskbar_metrics_enabled),
          items: s.taskbar_metrics_items ?? [],
          // 旧 settings.json 无这几个字段时后端已给出缺省，?? 兜底仅防异常载荷。
          style: s.taskbar_metrics_style ?? 'default',
          layout: s.taskbar_metrics_layout ?? 'single',
          detailed: Boolean(s.taskbar_metrics_detailed),
        });
      })
      .catch(() => {
        setProxy('');
        setAutoCheck(false);
        setClosePref(null);
        setUiTheme('parchment');
        setStartMinimized(false);
        setTaskbarMetrics({
          enabled: false,
          items: [],
          style: 'default',
          layout: 'single',
          detailed: false,
        });
      });
  }, [open]);

  // 打开时实查本平台是否支持任务栏小窗（仅 Windows）。不支持则整卡不渲染。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    invoke<boolean>('get_taskbar_widget_support')
      .then((supported) => {
        if (alive) setTaskbarSupported(Boolean(supported));
      })
      .catch(() => {
        if (alive) setTaskbarSupported(false);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 打开时实查系统侧的自启状态。真源是系统（注册表），不是 settings.json——用户手工
  // 删掉条目后我们才知道实况，所以每次开窗都重新问一次；null 表示本平台不支持。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setAutostartError('');
    invoke<boolean | null>('get_autostart')
      .then((enabled) => {
        if (alive) setAutostart(enabled);
      })
      .catch(() => {
        if (alive) setAutostart(null);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  // 切换「关闭窗口行为」并立即落盘：乐观回填，再以后端返回值校准。
  const saveClosePref = (pref: boolean | null) => {
    setClosePref(pref);
    invoke<AppSettings>('set_close_pref', { pref })
      .then((s) => setClosePref(s.minimize_to_tray ?? null))
      .catch(() => {});
  };

  // 切换开机自启：乐观回填，再以后端读回的真实状态校准；写失败则回滚并就地提示。
  const saveAutostart = (enabled: boolean) => {
    const prev = autostart;
    setAutostart(enabled);
    setAutostartError('');
    invoke<boolean>('set_autostart', { enabled })
      .then((next) => setAutostart(next))
      .catch((e) => {
        setAutostart(prev);
        setAutostartError(String(e));
      });
  };

  // 切换「启动时最小化」：乐观回填，再以后端返回值校准；写失败则回滚并就地提示。
  // 本命令只落盘偏好，真正的最小化发生在下次启动（后端 setup 阶段读取执行）。
  const saveStartMinimized = (enabled: boolean) => {
    const prev = startMinimized;
    setStartMinimized(enabled);
    setStartMinimizedError('');
    invoke<AppSettings>('set_start_minimized', { enabled })
      .then((s) => setStartMinimized(Boolean(s.start_minimized)))
      .catch((e) => {
        setStartMinimized(prev);
        setStartMinimizedError(String(e));
      });
  };

  // 切换界面风格：先写 DOM 让整页 token 立刻换，再落盘；失败时以后端返回值校准。
  const saveUiTheme = (theme: UiTheme) => {
    setUiTheme(theme);
    applyUiTheme(theme);
    invoke<AppSettings>('set_ui_theme', { theme })
      .then((s) => {
        const next = normalizeUiTheme(s.ui_theme);
        setUiTheme(next);
        applyUiTheme(next);
      })
      .catch(() => {});
  };

  // 保存「更新代理 + 自动检查」两项（settings.json），二者一并写入，互不覆盖。
  // 代理在「保存」按钮处落盘（见 onSaveProxy），自动检查开关则在勾选时即时落盘。
  const onSaveProxy = async () => {
    setProxySaved(false);
    setProxyError('');
    try {
      const s = await invoke<AppSettings>('save_settings', {
        updateProxy: proxy,
        autoCheckUpdates: autoCheck,
      });
      setProxy(s.update_proxy);
      setAutoCheck(Boolean(s.auto_check_updates));
      setProxySaved(true);
    } catch (e) {
      setProxyError(String(e));
    }
  };

  // 保存任务栏小窗全部五项（开关 + 勾选 + 样式 + 排列 + 详细数据）：乐观回填，再以后端
  // 返回值校准（与其它设置一致）。勾选全空时后端会按关闭落盘，前端同步把开关关掉，
  // 保持 UI 与落盘一致。
  const saveTaskbarMetrics = (next: {
    enabled: boolean;
    items: string[];
    style: string;
    layout: string;
    detailed: boolean;
  }) => {
    const prev = taskbarMetrics;
    const applied = { ...next, enabled: next.enabled && next.items.length > 0 };
    setTaskbarMetrics(applied);
    setTaskbarMetricsError('');
    invoke<AppSettings>('set_taskbar_metrics', {
      enabled: applied.enabled,
      items: applied.items,
      style: applied.style,
      layout: applied.layout,
      detailed: applied.detailed,
    })
      .then((s) =>
        setTaskbarMetrics({
          enabled: Boolean(s.taskbar_metrics_enabled),
          items: s.taskbar_metrics_items ?? [],
          style: s.taskbar_metrics_style ?? 'default',
          layout: s.taskbar_metrics_layout ?? 'single',
          detailed: Boolean(s.taskbar_metrics_detailed),
        }),
      )
      .catch((e) => {
        setTaskbarMetrics(prev);
        setTaskbarMetricsError(String(e));
      });
  };

  // 开启时若勾选为空（此前被全部取消过），回到四项全选——否则开关会因「无内容」被后端立刻关回。
  const onToggleTaskbarEnabled = (enabled: boolean) => {
    if (!taskbarMetrics) return;
    const items = taskbarMetrics.items.length
      ? taskbarMetrics.items
      : TASKBAR_ITEMS.map((item) => item.key);
    saveTaskbarMetrics({ ...taskbarMetrics, enabled, items });
  };

  const onToggleTaskbarItem = (key: string, checked: boolean) => {
    if (!taskbarMetrics) return;
    const items = checked
      ? [...taskbarMetrics.items, key]
      : taskbarMetrics.items.filter((item) => item !== key);
    saveTaskbarMetrics({ ...taskbarMetrics, items });
  };

  // 样式 / 排列为单选组：改动即时落盘；后端广播设置事件让小窗立刻重绘，
  // 排列变化引起的高度差由小窗 ResizeObserver 重报尺寸、定位线程跟随。
  const onSelectTaskbarStyle = (style: string) => {
    if (!taskbarMetrics) return;
    saveTaskbarMetrics({ ...taskbarMetrics, style });
  };

  const onSelectTaskbarLayout = (layout: string) => {
    if (!taskbarMetrics) return;
    saveTaskbarMetrics({ ...taskbarMetrics, layout });
  };

  // 详细数据开关：内存/显存项在百分比后追加「已用/总量 GB」。
  const onToggleTaskbarDetailed = (detailed: boolean) => {
    if (!taskbarMetrics) return;
    saveTaskbarMetrics({ ...taskbarMetrics, detailed });
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('settings.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-title">
          {t('settings.title')}
          <button
            type="button"
            className="modal-close"
            aria-label={t('settings.close')}
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="settings-columns">
            <div className="settings-column">
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.language}
                    {t('settings.language')}
                  </span>
                  <span className="settings-hint">{t('settings.languageHint')}</span>
                </div>
                <LangSwitch variant="list" />
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.theme}
                    {t('settings.theme')}
                  </span>
                  <span className="settings-hint">{t('settings.themeHint')}</span>
                </div>
                <label className="settings-option-row">
                  <input
                    type="radio"
                    name="ui-theme"
                    className="settings-checkbox"
                    checked={uiTheme === 'default'}
                    onChange={() => saveUiTheme('default')}
                  />
                  <span className="settings-check-label">{t('settings.themeDefault')}</span>
                </label>
                <label className="settings-option-row">
                  <input
                    type="radio"
                    name="ui-theme"
                    className="settings-checkbox"
                    checked={uiTheme === 'parchment'}
                    onChange={() => saveUiTheme('parchment')}
                  />
                  <span className="settings-check-label">{t('settings.themeParchment')}</span>
                </label>
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.update}
                    {t('settings.update')}
                  </span>
                  <span className="settings-hint">{t('settings.updateHint')}</span>
                </div>
                <div className="settings-meta-row">
                  <span className="settings-hint">{t('about.version')}</span>
                  <span className="settings-meta">
                    <span className="settings-meta-value">{version}</span>
                    {pendingUpdate && (
                      <button
                        type="button"
                        className="update-badge"
                        title={t('update.badgeTitle')}
                        aria-label={t('update.badgeTitle')}
                        onClick={() => {
                          onClose();
                          onOpenUpdate();
                        }}
                      >
                        {t('update.badgeNew')}
                      </button>
                    )}
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={onCheckUpdate}
                      disabled={checking}
                    >
                      {checking ? t('update.checking') : t('update.check')}
                    </Button>
                  </span>
                </div>
                <label className="settings-option-row">
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={autoCheck}
                    onChange={(event) => {
                      setAutoCheck(event.target.checked);
                      // 立即落盘（含当前代理值），无需点「保存」也能记住开关。
                      invoke<AppSettings>('save_settings', {
                        updateProxy: proxy,
                        autoCheckUpdates: event.target.checked,
                      })
                        .then((s) => {
                          setProxy(s.update_proxy);
                          setAutoCheck(Boolean(s.auto_check_updates));
                        })
                        .catch(() => {});
                    }}
                  />
                  <span className="settings-check-label">{t('settings.autoCheck')}</span>
                </label>
                <div className="settings-section-head">
                  <span className="settings-sublabel">{t('settings.updateProxy')}</span>
                  <span className="settings-hint">{t('settings.updateProxyHint')}</span>
                </div>
                <div className="settings-proxy-row">
                  <input
                    className="settings-proxy-input"
                    type="text"
                    placeholder="http://127.0.0.1:7897"
                    value={proxy}
                    onChange={(event) => {
                      setProxy(event.target.value);
                      setProxySaved(false);
                    }}
                  />
                  <Button variant="secondary" type="button" onClick={onSaveProxy}>
                    {t('common.save')}
                  </Button>
                </div>
                {proxySaved && (
                  <div className="settings-proxy-ok">{t('settings.updateProxySaved')}</div>
                )}
                {proxyError && <div className="settings-proxy-err">{proxyError}</div>}
              </div>

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.windowClose}
                    {t('settings.windowClose')}
                  </span>
                  <span className="settings-hint">{t('settings.windowCloseHint')}</span>
                </div>
                <label className="settings-option-row">
                  <input
                    type="radio"
                    name="close-pref"
                    className="settings-checkbox"
                    checked={closePref === null}
                    onChange={() => saveClosePref(null)}
                  />
                  <span className="settings-check-label">{t('settings.windowCloseAsk')}</span>
                </label>
                <label className="settings-option-row">
                  <input
                    type="radio"
                    name="close-pref"
                    className="settings-checkbox"
                    checked={closePref === true}
                    onChange={() => saveClosePref(true)}
                  />
                  <span className="settings-check-label">{t('settings.windowCloseTray')}</span>
                </label>
                <label className="settings-option-row">
                  <input
                    type="radio"
                    name="close-pref"
                    className="settings-checkbox"
                    checked={closePref === false}
                    onChange={() => saveClosePref(false)}
                  />
                  <span className="settings-check-label">{t('settings.windowCloseQuit')}</span>
                </label>
              </div>
            </div>
            <div className="settings-column">
              {/* 启动设置：开机自启仅在本平台支持时渲染该行（不支持时后端返回 null，
              宁可不出这一行，也不给一个点了必然报错的开关；默认关闭 = 从未勾选过时
              注册表无条目）。启动时最小化平台无关、始终可设，默认关闭。 */}
              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.startup}
                    {t('settings.startup')}
                  </span>
                  <span className="settings-hint">{t('settings.startupHint')}</span>
                </div>
                {autostart !== null && (
                  <label className="settings-option-row">
                    <input
                      type="checkbox"
                      className="settings-checkbox"
                      checked={autostart}
                      onChange={(event) => saveAutostart(event.target.checked)}
                    />
                    <span className="settings-check-label">{t('settings.autostartLabel')}</span>
                  </label>
                )}
                <label className="settings-option-row">
                  <input
                    type="checkbox"
                    className="settings-checkbox"
                    checked={startMinimized}
                    onChange={(event) => saveStartMinimized(event.target.checked)}
                  />
                  <span className="settings-check-label">{t('settings.startMinimizedLabel')}</span>
                </label>
                {autostartError && <div className="settings-proxy-err">{autostartError}</div>}
                {startMinimizedError && (
                  <div className="settings-proxy-err">{startMinimizedError}</div>
                )}
              </div>

              {/* 仅 Windows 渲染（后端 get_taskbar_widget_support 为假时整卡不出现）：
              开关 + 要显示的参数复选 + 样式/排列单选。各项随时可改（关闭状态下也持久化），
              勾选全空会自动把开关关掉。 */}
              {taskbarSupported && taskbarMetrics && (
                <div className="settings-section">
                  <div className="settings-section-head">
                    <span className="settings-label">
                      {sectionIcons.taskbarMetrics}
                      {t('settings.taskbarMetrics')}
                    </span>
                    <span className="settings-hint">{t('settings.taskbarMetricsHint')}</span>
                  </div>
                  <label className="settings-option-row">
                    <input
                      type="checkbox"
                      className="settings-checkbox"
                      checked={taskbarMetrics.enabled}
                      onChange={(event) => onToggleTaskbarEnabled(event.target.checked)}
                    />
                    <span className="settings-check-label">
                      {t('settings.taskbarMetricsEnable')}
                    </span>
                  </label>
                  <div className="settings-section-head">
                    <span className="settings-sublabel">{t('settings.taskbarMetricsItems')}</span>
                    <span className="settings-hint">{t('settings.taskbarMetricsItemsHint')}</span>
                  </div>
                  {TASKBAR_ITEMS.map((item) => (
                    <label className="settings-option-row" key={item.key}>
                      <input
                        type="checkbox"
                        className="settings-checkbox"
                        checked={taskbarMetrics.items.includes(item.key)}
                        onChange={(event) => onToggleTaskbarItem(item.key, event.target.checked)}
                      />
                      <span className="settings-check-label">{t(item.label)}</span>
                    </label>
                  ))}
                  <div className="settings-section-head">
                    <span className="settings-sublabel">{t('settings.taskbarMetricsDetails')}</span>
                    <span className="settings-hint">{t('settings.taskbarMetricsDetailsHint')}</span>
                  </div>
                  <label className="settings-option-row">
                    <input
                      type="checkbox"
                      className="settings-checkbox"
                      checked={taskbarMetrics.detailed}
                      onChange={(event) => onToggleTaskbarDetailed(event.target.checked)}
                    />
                    <span className="settings-check-label">
                      {t('settings.taskbarMetricsDetailed')}
                    </span>
                  </label>
                  <div className="settings-section-head">
                    <span className="settings-sublabel">{t('settings.taskbarMetricsStyle')}</span>
                    <span className="settings-hint">{t('settings.taskbarMetricsStyleHint')}</span>
                  </div>
                  {TASKBAR_STYLES.map((item) => (
                    <label className="settings-option-row" key={item.key}>
                      <input
                        type="radio"
                        name="taskbar-metrics-style"
                        className="settings-checkbox"
                        checked={taskbarMetrics.style === item.key}
                        onChange={() => onSelectTaskbarStyle(item.key)}
                      />
                      <span className="settings-check-label">{t(item.label)}</span>
                    </label>
                  ))}
                  <div className="settings-section-head">
                    <span className="settings-sublabel">{t('settings.taskbarMetricsLayout')}</span>
                    <span className="settings-hint">{t('settings.taskbarMetricsLayoutHint')}</span>
                  </div>
                  {TASKBAR_LAYOUTS.map((item) => (
                    <label className="settings-option-row" key={item.key}>
                      <input
                        type="radio"
                        name="taskbar-metrics-layout"
                        className="settings-checkbox"
                        checked={taskbarMetrics.layout === item.key}
                        onChange={() => onSelectTaskbarLayout(item.key)}
                      />
                      <span className="settings-check-label">{t(item.label)}</span>
                    </label>
                  ))}
                  {taskbarMetricsError && (
                    <div className="settings-proxy-err">{taskbarMetricsError}</div>
                  )}
                </div>
              )}

              <div className="settings-section">
                <div className="settings-section-head">
                  <span className="settings-label">
                    {sectionIcons.about}
                    {t('about.title')}
                  </span>
                </div>
                <p className="settings-about-desc">{t('about.desc')}</p>
                <div className="settings-repo-row">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => openUrl(REPO_URL).catch(() => {})}
                  >
                    {t('about.repo')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
