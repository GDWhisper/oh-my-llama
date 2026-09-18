import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import { useWindowHidden } from '../hooks/useWindowHidden';
import type { PerfSnapshot } from '../types';
import './MetricsPanel.css';

interface GpuMetrics {
  name: string;
  usage: number;
  vram_total_mb: number;
  vram_used_mb: number;
  temperature: number | null;
  power_usage_w: number | null;
}

interface MetricsSnapshot {
  cpu_usage: number;
  mem_total_mb: number;
  mem_used_mb: number;
  mem_usage: number;
  gpus: GpuMetrics[];
}

const INTERVAL = 1500;
// 收起态**不停表**：收起仍显示一行紧凑摘要（CPU / 内存 / GPU / 显存 / 功耗），
// 停表会把摘要冻在旧值上（可见回归）。只降频到 3s——摘要仍在动，但用户没在看细节。
const INTERVAL_COLLAPSED = 3000;

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** 内存/显存换算成 16MB 桶：小于一格的抖动肉眼无差别，不应触发重渲染。 */
function mbBucket(mb: number): number {
  return Math.round(mb / 16);
}

/**
 * 快照等价比较：把「看不见的抖动」归一后再比（CPU/GPU 利用率与温度、功耗取整，
 * 内存/显存按 16MB 桶）。等价则复用旧引用，React 直接跳过重渲染。
 * 动因：2026-09-17 实测每次刷新在 WebView2 侧要花 45–95ms（指标条宽度过渡 +
 * 重排重绘），而 CPU 占用在小数位上每秒都在跳——静止场景占了大头。
 */
function sameSnapshot(prev: MetricsSnapshot | null, next: MetricsSnapshot): boolean {
  if (!prev) return false;
  if (Math.round(prev.cpu_usage) !== Math.round(next.cpu_usage)) return false;
  if (mbBucket(prev.mem_used_mb) !== mbBucket(next.mem_used_mb)) return false;
  if (mbBucket(prev.mem_total_mb) !== mbBucket(next.mem_total_mb)) return false;
  if (prev.gpus.length !== next.gpus.length) return false;
  for (let i = 0; i < prev.gpus.length; i += 1) {
    const a = prev.gpus[i];
    const b = next.gpus[i];
    if (Math.round(a.usage) !== Math.round(b.usage)) return false;
    if (mbBucket(a.vram_used_mb) !== mbBucket(b.vram_used_mb)) return false;
    if (mbBucket(a.vram_total_mb) !== mbBucket(b.vram_total_mb)) return false;
    if (Math.round(a.temperature ?? -1) !== Math.round(b.temperature ?? -1)) return false;
    if (Math.round(a.power_usage_w ?? -1) !== Math.round(b.power_usage_w ?? -1)) return false;
  }
  return true;
}

function fmtTps(tps: number | null): string {
  if (tps == null) return '—';
  const digits = tps >= 100 ? 0 : tps >= 10 ? 1 : 2;
  return `${tps.toFixed(digits)} tok/s`;
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

/** 「NVIDIA GeForce RTX 5070 Ti」→「RTX 5070 Ti」；完整型号仍走 title。 */
function shortGpuName(name: string): string {
  return name
    .replace(/^NVIDIA\s+GeForce\s+/i, '')
    .replace(/^NVIDIA\s+/i, '')
    .trim();
}

export function MetricsPanel({ perf }: { perf: PerfSnapshot | null }) {
  const { t } = useI18n();
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  // 「窗口看不见」真源：托盘隐藏由后端 window://visible 广播（WebView2 不会把页面置为
  // hidden），最小化等路径由 document.visibilityState 兜底。
  const hidden = useWindowHidden();

  useEffect(() => {
    // 门控：窗口不可见（托盘常驻/最小化）时**完全停表**——没人看的数字不必刷新
    // （实测每次刷新在 WebView2 侧要花 45–95ms）。面板收起则只降频（收起态仍有一行
    // 紧凑摘要，停表会把它冻住）。恢复可见/展开时立即 tick 一次，避免先显示陈旧值。
    if (hidden) {
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<MetricsSnapshot>('get_system_metrics');
        if (!alive) return;
        // 数值无实质变化则复用旧引用：React 跳过重渲染，省掉整段重排重绘。
        setSnap((prev) => (sameSnapshot(prev, s) ? prev : s));
        setErr(null);
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    const id = window.setInterval(tick, expanded ? INTERVAL : INTERVAL_COLLAPSED);
    tick();
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [hidden, expanded]);

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
                if (g.power_usage_w !== null) {
                  subBits.push(`${t('metrics.power')} ${g.power_usage_w.toFixed(0)} W`);
                }
                // 温度是 GPU 核心温（NVML TemperatureSensor::Gpu），与利用率同主行展示。
                const detailBits: string[] = [shortGpuName(g.name)];
                if (g.temperature !== null) {
                  detailBits.push(`${t('metrics.temp')} ${g.temperature.toFixed(0)}°C`);
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
                        {detailBits.join(' · ')}
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

            {/* 推理性能：来自 llama-server 日志 timings 行（「最近」= 最近一次净速率，
                「估计」= 会话下限包络拟合的速度，见后端 perf.rs）。 */}
            {perf && (
              <div className="metrics-perf">
                <div className="metrics-row">
                  <span className="metrics-label">{t('metrics.prefill')}</span>
                  <span className="metrics-value">
                    {t('metrics.last')} {fmtTps(perf.last_prompt_tps)} · {t('metrics.est')}{' '}
                    {fmtTps(perf.prompt_tps_est)}
                  </span>
                </div>
                <div className="metrics-row">
                  <span className="metrics-label">{t('metrics.generate')}</span>
                  <span className="metrics-value">
                    {t('metrics.last')} {fmtTps(perf.last_gen_tps)} · {t('metrics.est')}{' '}
                    {fmtTps(perf.gen_tps_est)}
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
            {snap.gpus.some((g) => g.power_usage_w !== null) && (
              <>
                <span className="metrics-sep">·</span>
                <span className="metrics-value">
                  {t('metrics.power')}{' '}
                  {snap.gpus
                    .map((g) =>
                      g.power_usage_w !== null ? `${g.power_usage_w.toFixed(0)} W` : '—',
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
