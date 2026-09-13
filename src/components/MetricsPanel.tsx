import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import type { PerfSnapshot } from '../types';
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
  mem_total_mb: number;
  mem_used_mb: number;
  mem_usage: number;
  gpus: GpuMetrics[];
}

const INTERVAL = 1500;
// 窗口隐藏/托盘常驻时降到 8s：面板看不见，满频采集是恒定浪费；切回即恢复满频。
const INTERVAL_HIDDEN = 8000;

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtTps(tps: number | null): string {
  if (tps == null) return '—';
  const digits = tps >= 100 ? 0 : tps >= 10 ? 1 : 2;
  return `${tps.toFixed(digits)} tok/s`;
}

// 平均吞吐 = Σtokens / Σ时间：后端只下发累计值，平均在此派生（吞吐的真实平均，非各请求 TPS 均值）。
function avgTps(tokensTotal: number, msTotal: number): string {
  if (tokensTotal <= 0 || msTotal <= 0) return '—';
  return fmtTps(tokensTotal / (msTotal / 1000));
}

/** 占用条与百分比共用：0–100，非法值归 0；≥70 高亮 accent，≥90 用 stop */
function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function Meter({ value }: { value: number }) {
  const pct = clampPct(value);
  const level = pct >= 90 ? ' level-critical' : pct >= 70 ? ' level-high' : '';
  return (
    <div className="meter" aria-hidden>
      <div className={`meter-fill${level}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function fmtPct(value: number): string {
  return `${clampPct(value).toFixed(0)}%`;
}

export function MetricsPanel({ perf }: { perf: PerfSnapshot | null }) {
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
    // 频率随窗口可见性切换：visibilitychange 时按当前可见性重建定时器。
    const currentInterval = () =>
      document.visibilityState === 'hidden' ? INTERVAL_HIDDEN : INTERVAL;
    let id = window.setInterval(tick, currentInterval());
    const onVisibility = () => {
      window.clearInterval(id);
      id = window.setInterval(tick, currentInterval());
    };
    tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
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
              <Meter value={snap.cpu_usage} />
              <span className="metrics-value metrics-pct">{fmtPct(snap.cpu_usage)}</span>
            </div>

            {/* 内存 */}
            <div className="metrics-row">
              <span className="metrics-label">{t('metrics.memory')}</span>
              <Meter value={snap.mem_usage} />
              <span className="metrics-value metrics-pct">{fmtPct(snap.mem_usage)}</span>
              <span className="metrics-detail">
                {fmtMB(snap.mem_used_mb)} / {fmtMB(snap.mem_total_mb)}
              </span>
            </div>

            {/* GPU(s) */}
            {snap.gpus.length === 0 ? (
              <div className="metrics-row">
                <span className="metrics-label">{t('metrics.gpu')}</span>
                <span className="metrics-muted">{t('metrics.gpuNone')}</span>
              </div>
            ) : (
              snap.gpus.map((g, i) => {
                const hasVram = g.vram_total_mb > 0;
                const vramPct = hasVram ? (g.vram_used_mb / g.vram_total_mb) * 100 : 0;
                const subBits: string[] = [];
                if (hasVram) {
                  subBits.push(`${fmtMB(g.vram_used_mb)} / ${fmtMB(g.vram_total_mb)}`);
                }
                if (g.temperature !== null) {
                  subBits.push(`${t('metrics.temp')} ${g.temperature.toFixed(0)}°C`);
                }
                return (
                  <div className="metrics-gpu" key={`${g.name}-${i}`}>
                    <div className="metrics-row">
                      <span className="metrics-label">
                        {t('metrics.gpu')}
                        {snap.gpus.length > 1 ? ` ${i + 1}` : ''}
                      </span>
                      <Meter value={g.usage} />
                      <span className="metrics-value metrics-pct">{fmtPct(g.usage)}</span>
                      <span className="metrics-detail" title={g.name}>
                        {g.name}
                      </span>
                    </div>
                    {subBits.length > 0 && (
                      <div className="metrics-sub">
                        {hasVram ? (
                          <>
                            <span className="metrics-label">{t('metrics.vram')}</span>
                            <Meter value={vramPct} />
                            <span className="metrics-value metrics-pct">{fmtPct(vramPct)}</span>
                          </>
                        ) : (
                          <span className="metrics-label" />
                        )}
                        <span className="metrics-sub-detail">{subBits.join(' · ')}</span>
                      </div>
                    )}
                  </div>
                );
              })
            )}

            {/* 推理性能：来自 llama-server 日志 timings 行（最近一次请求 + 进程生命周期累计平均）。 */}
            {perf && (
              <div className="metrics-perf">
                <div className="metrics-row">
                  <span className="metrics-label">{t('metrics.prefill')}</span>
                  <span className="metrics-value">
                    {t('metrics.last')} {fmtTps(perf.last_prompt_tps)} · {t('metrics.avg')}{' '}
                    {avgTps(perf.prompt_tokens_total, perf.prompt_ms_total)}
                  </span>
                </div>
                <div className="metrics-row">
                  <span className="metrics-label">{t('metrics.generate')}</span>
                  <span className="metrics-value">
                    {t('metrics.last')} {fmtTps(perf.last_gen_tps)} · {t('metrics.avg')}{' '}
                    {avgTps(perf.gen_tokens_total, perf.gen_ms_total)}
                  </span>
                </div>
                <div className="metrics-perf-meta">
                  {t('metrics.requests', { count: perf.requests })}
                </div>
              </div>
            )}
          </div>
        ) : (
          // 收起态：仅展示关键数值（一行紧凑）
          <div className="metrics-compact">
            <span className="metrics-value">
              {t('metrics.cpu')} {fmtPct(snap.cpu_usage)}
            </span>
            <span className="metrics-sep">·</span>
            <span className="metrics-value">
              {t('metrics.memory')} {fmtPct(snap.mem_usage)}
            </span>
            <span className="metrics-sep">·</span>
            <span className="metrics-value">
              {t('metrics.gpu')}{' '}
              {snap.gpus.length === 0 ? '—' : snap.gpus.map((g) => fmtPct(g.usage)).join(' / ')}
            </span>
            {snap.gpus.length > 0 && (
              <>
                <span className="metrics-sep">·</span>
                <span className="metrics-value">
                  {t('metrics.vram')}{' '}
                  {snap.gpus
                    .map((g) =>
                      g.vram_total_mb > 0 ? fmtPct((g.vram_used_mb / g.vram_total_mb) * 100) : '—',
                    )
                    .join(' / ')}
                </span>
              </>
            )}
            {perf && (
              <>
                <span className="metrics-sep">·</span>
                <span className="metrics-value">
                  {t('metrics.prefill')} {fmtTps(perf.last_prompt_tps)}
                </span>
                <span className="metrics-sep">·</span>
                <span className="metrics-value">
                  {t('metrics.generate')} {fmtTps(perf.last_gen_tps)}
                </span>
              </>
            )}
          </div>
        ))}
    </div>
  );
}
