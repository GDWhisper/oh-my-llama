import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useI18n } from '../i18n';
import './MetricsPanel.css';

interface GpuMetrics {
  name: string;
  usage: number; // 0-100
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

const HISTORY = 40;
const INTERVAL = 1500;

type Hist = { cpu: number[]; mem: number[]; gpus: number[][] };

function fmtMB(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

// 迷你折线：输入 0-100 的占用率序列，自适应宽度、恒定描边。
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const W = 100;
  const H = 100;
  if (data.length < 2) {
    return <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" />;
  }
  const pts = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * W;
      const y = H - Math.max(0, Math.min(100, v)) * (H / 100);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function Meter({
  value,
  color,
  headLeft,
  headRight,
}: {
  value: number;
  color: string;
  headLeft: string;
  headRight: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{headLeft}</span>
        <span className="meter-val">{headRight}</span>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

export function MetricsPanel() {
  const { t } = useI18n();
  const [snap, setSnap] = useState<MetricsSnapshot | null>(null);
  const [hist, setHist] = useState<Hist>({ cpu: [], mem: [], gpus: [] });
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await invoke<MetricsSnapshot>('get_system_metrics');
        if (!alive) return;
        setSnap(s);
        setErr(null);
        setHist((prev) => ({
          cpu: [...prev.cpu, s.cpu_usage].slice(-HISTORY),
          mem: [...prev.mem, s.mem_usage].slice(-HISTORY),
          gpus: s.gpus.map((g, i) => [...(prev.gpus[i] ?? []), g.usage].slice(-HISTORY)),
        }));
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
      </div>

      {err && <div className="metrics-error">{t('metrics.loadError')}</div>}

      {!err && snap && (
        <div className="metrics-body">
          {/* CPU */}
          <div className="metric-block">
            <Meter
              value={snap.cpu_usage}
              color="#3b82f6"
              headLeft={t('metrics.cpu')}
              headRight={`${snap.cpu_usage.toFixed(0)}%`}
            />
            <Sparkline data={hist.cpu} color="#3b82f6" />
            {snap.cpu_cores.length > 0 && (
              <div className="cores" title={t('metrics.cores')}>
                {snap.cpu_cores.map((c, i) => (
                  <div className="core" key={i} style={{ height: `${Math.max(2, c)}%` }} />
                ))}
              </div>
            )}
          </div>

          {/* Memory */}
          <div className="metric-block">
            <Meter
              value={snap.mem_usage}
              color="#10b981"
              headLeft={t('metrics.memory')}
              headRight={`${fmtMB(snap.mem_used_mb)} / ${fmtMB(snap.mem_total_mb)}`}
            />
            <Sparkline data={hist.mem} color="#10b981" />
          </div>

          {/* GPU(s) */}
          {snap.gpus.length === 0 ? (
            <div className="metrics-gpu-none">{t('metrics.gpuNone')}</div>
          ) : (
            snap.gpus.map((g, i) => (
              <div className="metric-block" key={i}>
                <Meter
                  value={g.usage}
                  color="#f59e0b"
                  headLeft={`${t('metrics.gpu')}${snap.gpus.length > 1 ? ` ${i + 1}` : ''}`}
                  headRight={`${g.usage.toFixed(0)}%`}
                />
                <div className="gpu-name" title={g.name}>
                  {g.name}
                </div>
                <Sparkline data={hist.gpus[i] ?? []} color="#f59e0b" />
                <Meter
                  value={g.vram_total_mb > 0 ? (g.vram_used_mb / g.vram_total_mb) * 100 : 0}
                  color="#8b5cf6"
                  headLeft={t('metrics.vram')}
                  headRight={`${fmtMB(g.vram_used_mb)} / ${fmtMB(g.vram_total_mb)}`}
                />
                {g.temperature !== null && (
                  <div className="gpu-temp">
                    {t('metrics.temp')}: {g.temperature.toFixed(0)}°C
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
