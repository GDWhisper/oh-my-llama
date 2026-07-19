import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import './MetricsPanel.css';

interface GpuMetrics {
  name: string;
  usage: number;
  vram_total_mb: number;
  vram_used_mb: number;
  temperature: number | null;
}

interface MetricsSnapshot {
  cpu_usage: number;
  cpu_cores: number[];
  mem_total_mb: number;
  mem_used_mb: number;
  mem_usage: number;
  gpus: GpuMetrics[];
}

const INTERVAL = 1500;

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function MetricsPanel() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<MetricsSnapshot>('get_system_metrics');
        if (!alive) return;
        setSnap(s);
        setErr(null);
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    tick();
    const id = window.setInterval(tick, INTERVAL);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className="panel metrics-panel">
      <div className="panel-header">
        <h2>{t('metrics.title')}</h2>
        {snap && !err && (
          <button
            type="button"
            className="metrics-toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t('metrics.collapse') : t('metrics.expand')}
          </button>
        )}
      </div>

      {err && <div className="metrics-error">{t('metrics.loadError')}</div>}

      {!err &&
        snap &&
        (expanded ? (
          <div className="metrics-grid">
            {/* CPU */}
            <div className="metrics-row">
              <span className="metrics-label">{t('metrics.cpu')}</span>
              <span className="metrics-value">{snap.cpu_usage.toFixed(0)}%</span>
            </div>

            {/* 内存 */}
            <div className="metrics-row">
              <span className="metrics-label">{t('metrics.memory')}</span>
              <span className="metrics-value">
                {fmtMB(snap.mem_used_mb)} / {fmtMB(snap.mem_total_mb)} ({snap.mem_usage.toFixed(0)}
                %)
              </span>
            </div>

            {/* GPU(s) */}
            {snap.gpus.length === 0 ? (
              <div className="metrics-row">
                <span className="metrics-label">{t('metrics.gpu')}</span>
                <span className="metrics-value metrics-muted">{t('metrics.gpuNone')}</span>
              </div>
            ) : (
              snap.gpus.map((g, i) => (
                <div className="metrics-gpu" key={i}>
                  <div className="metrics-row">
                    <span className="metrics-label">
                      {t('metrics.gpu')}
                      {snap.gpus.length > 1 ? ` ${i + 1}` : ''}
                    </span>
                    <span className="metrics-value">{g.usage.toFixed(0)}%</span>
                  </div>
                  <div className="metrics-sub">
                    <span>{g.name}</span>
                    {g.vram_total_mb > 0 && (
                      <span className="metrics-sub-line">
                        {' · '}
                        {t('metrics.vram')} {fmtMB(g.vram_used_mb)} / {fmtMB(g.vram_total_mb)}
                      </span>
                    )}
                    {g.temperature !== null && (
                      <span className="metrics-sub-line">
                        {' · '}
                        {t('metrics.temp')} {g.temperature.toFixed(0)}°C
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        ) : (
          // 收起态：仅展示关键数值（一行紧凑）
          <div className="metrics-compact">
            <span className="metrics-value">
              {t('metrics.cpu')} {snap.cpu_usage.toFixed(0)}%
            </span>
            <span className="metrics-sep">·</span>
            <span className="metrics-value">
              {t('metrics.memory')} {snap.mem_usage.toFixed(0)}%
            </span>
            <span className="metrics-sep">·</span>
            <span className="metrics-value">
              {t('metrics.gpu')}{' '}
              {snap.gpus.length === 0
                ? '—'
                : snap.gpus.map((g) => g.usage.toFixed(0) + '%').join(' / ')}
            </span>
            {snap.gpus.length > 0 && (
              <>
                <span className="metrics-sep">·</span>
                <span className="metrics-value">
                  {t('metrics.vram')}{' '}
                  {snap.gpus
                    .map((g) =>
                      g.vram_total_mb > 0
                        ? ((g.vram_used_mb / g.vram_total_mb) * 100).toFixed(0) + '%'
                        : '—',
                    )
                    .join(' / ')}
                </span>
              </>
            )}
          </div>
        ))}
    </div>
  );
}
