import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "./types";
import type { ServerConfig, ServerLogLine } from "./types";
import "./App.css";

function useInterval(callback: () => void, delay: number | null) {
  useEffect(() => {
    if (delay == null) {
      return;
    }
    const id = window.setInterval(callback, delay);
    return () => window.clearInterval(id);
  }, [callback, delay]);
}

const DEFAULT_CONFIG: ServerConfig = {
  llama_server_path: "",
  model: "",
  host: "127.0.0.1",
  port: 8080,
  ctx_size: 4096,
  n_predict: -1,
  n_gpu_layers: 0,
  threads: 0,
  batch_size: 512,
  temp: 0.7,
  flash_attn: "auto",
  mmap: true,
  mlock: false,
  enabled_advanced_params: ["ctx_size"],
};

const OPTIONAL_ADVANCED_OPTIONS = [
  { key: "n_predict", label: "最大生成数" },
  { key: "n_gpu_layers", label: "GPU 层数" },
  { key: "threads", label: "CPU 线程数" },
  { key: "batch_size", label: "批处理大小" },
  { key: "temp", label: "温度" },
  { key: "flash_attn", label: "Flash Attention" },
  { key: "mmap", label: "mmap" },
  { key: "mlock", label: "mlock" },
] as const;

type OptionalAdvancedKey = (typeof OPTIONAL_ADVANCED_OPTIONS)[number]["key"];

type AdvancedKey = "ctx_size" | OptionalAdvancedKey;

const ADVANCED_ORDER: AdvancedKey[] = [
  "ctx_size",
  "n_predict",
  "n_gpu_layers",
  "threads",
  "batch_size",
  "temp",
  "flash_attn",
  "mmap",
  "mlock",
];

const ADVANCED_DEFAULT: Record<AdvancedKey, boolean> = {
  ctx_size: true,
  n_predict: false,
  n_gpu_layers: false,
  threads: false,
  batch_size: false,
  temp: false,
  flash_attn: false,
  mmap: false,
  mlock: false,
};

const ADVANCED_LABELS: Record<AdvancedKey, string> = {
  ctx_size: "上下文长度",
  n_predict: "最大生成数",
  n_gpu_layers: "GPU 层数",
  threads: "CPU 线程数",
  batch_size: "批处理大小",
  temp: "温度",
  flash_attn: "Flash Attention",
  mmap: "mmap",
  mlock: "mlock",
};

function isUnlimitedPredict(value: number) {
  return value === -1;
}

function modelBasename(path: string) {
  const cleaned = path.trim();
  if (!cleaned) return "";
  const normalized = cleaned.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : cleaned;
}

function App() {
  const [config, setConfig] = useState<ServerConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<ServerLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [advancedEnabled, setAdvancedEnabled] = useState<Record<AdvancedKey, boolean>>(ADVANCED_DEFAULT);
  const [addingAdvanced, setAddingAdvanced] = useState(false);
  const [removingAdvanced, setRemovingAdvanced] = useState(false);

  const loadConfig = async () => {
    setError(null);
    try {
      const data = await invoke<ServerConfig>("read_config");
      const enabledList = data.enabled_advanced_params || ["ctx_size"];
      const enabledSet = new Set(enabledList);
      setAdvancedEnabled(() => {
        const next = { ...ADVANCED_DEFAULT };
        ADVANCED_ORDER.forEach((key) => {
          if (enabledSet.has(key)) {
            next[key] = true;
          }
        });
        return next;
      });
      setConfig({
        ...DEFAULT_CONFIG,
        ...data,
        host: data.host || DEFAULT_CONFIG.host,
        flash_attn: data.flash_attn || DEFAULT_CONFIG.flash_attn,
        enabled_advanced_params: enabledList,
      });
    } catch (err) {
      setError("读取配置失败");
      console.error(err);
    }
  };

  const loadStatus = async () => {
    try {
      const data = await invoke<ServerStatus>("get_status");
      setStatus(data);
    } catch (err) {
      console.error(err);
    }
  };

  const loadLogs = async () => {
    try {
      const data = await invoke<ServerLogLine[]>("read_logs");
      setLogs(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    loadConfig();
    loadStatus();
    loadLogs();
  }, []);

  useInterval(() => {
    loadStatus();
    loadLogs();
  }, 1500);

  const previewUrl = useMemo(() => status?.running ? status.url : "", [status]);
  const autoFlashAttn = useMemo(() => (config.n_gpu_layers > 0 ? "on" : "auto"), [config.n_gpu_layers]);
  const advancedFlashAttn = useMemo(() => (config.flash_attn === "auto" ? autoFlashAttn : config.flash_attn), [autoFlashAttn, config.flash_attn]);
  const advancedThreads = useMemo(() => (config.threads === 0 ? "auto" : String(config.threads)), [config.threads]);
  const advancedBatchSize = useMemo(() => (config.batch_size === 0 ? "auto" : String(config.batch_size)), [config.batch_size]);
  const advancedPredict = useMemo(() => (isUnlimitedPredict(config.n_predict) ? "unlimited" : String(config.n_predict)), [config.n_predict]);
  const availableAdvancedOptions = useMemo(
    () => OPTIONAL_ADVANCED_OPTIONS.filter((option) => !advancedEnabled[option.key]),
    [advancedEnabled]
  );

  const enabledAdvancedKeys = useMemo(
    () => ADVANCED_ORDER.filter((key) => advancedEnabled[key]),
    [advancedEnabled]
  );

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      await invoke("save_config", { config });
    } catch (err) {
      setError("保存配置失败");
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    setError(null);
    setStarting(true);
    try {
      await invoke("start_server", { config });
      await loadStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : "启动失败";
      setError(message);
      console.error(err);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    setError(null);
    setStopping(true);
    try {
      await invoke("stop_server");
      await loadStatus();
    } catch (err) {
      setError("停止失败");
      console.error(err);
    } finally {
      setStopping(false);
    }
  };

  const handleOpenPreview = async () => {
    if (!previewUrl) {
      return;
    }
    try {
      await invoke("open_preview");
    } catch (err) {
      setError("打开预览失败");
      console.error(err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await invoke("clear_logs");
      setLogs([]);
    } catch (err) {
      console.error(err);
    }
  };

  const startRemovingAdvanced = () => {
    setRemovingAdvanced(true);
    setAddingAdvanced(false);
  };

  const stopRemovingAdvanced = () => {
    setRemovingAdvanced(false);
  };

  const removeAdvancedKey = (key: AdvancedKey) => {
    setAdvancedEnabled((current) => {
      const next = { ...current, [key]: false };
      const hasEnabled = ADVANCED_ORDER.some((item) => next[item]);
      if (!hasEnabled) {
        setRemovingAdvanced(false);
      }
      return next;
    });
    setConfig((current) => ({
      ...current,
      enabled_advanced_params: current.enabled_advanced_params.filter((item) => item !== key)
    }));
  };

  const statusText = status?.running ? "运行中" : "已停止";
  const statusClass = status?.running ? "running" : "stopped";
  const modelLabel = modelBasename(config.model) || "模型文件";

  return (
    <main className="app">
      <header className="header">
        <h1>Llama Launcher</h1>
        <div className={`status ${statusClass}`}>{statusText}</div>
      </header>

      <div className="layout">
        <section className="column sidebar">
          <div className="panel">
            <h2>服务控制</h2>
            <div className="actions">
              <button onClick={handleStart} disabled={starting || status?.running}>
                {starting ? "正在启动..." : "启动"}
              </button>
              <button className="secondary" onClick={handleStop} disabled={stopping || !status?.running}>
                {stopping ? "正在停止..." : "停止"}
              </button>
              <button className="secondary" onClick={handleOpenPreview} disabled={!status?.running}>
                打开预览
              </button>
            </div>
          </div>

          <div className="panel">
            <h2>日志</h2>
            <div className="log-list">
              {logs.length === 0 && <div className="empty">暂无日志</div>}
              {logs.map((line, index) => (
                <div className="log-line" key={`${line.ts}-${index}`}>
                  <div>{line.ts}</div>
                  <div className={`level ${line.level}`}>{line.level}</div>
                  <div>{line.text}</div>
                </div>
              ))}
            </div>
            <div className="actions">
              <button className="secondary" onClick={handleClearLogs}>
                清空日志
              </button>
            </div>
          </div>
        </section>

        <section className="column main">
          <div className="panel">
            <h2>必要参数</h2>
            <div className="fields">
              <div className="field">
                <label>llama-server 路径</label>
                <input
                  value={config.llama_server_path}
                  onChange={(event) =>
                    setConfig({ ...config, llama_server_path: event.currentTarget.value })
                  }
                />
              </div>
              <div className="field">
                <label>模型路径</label>
                <input
                  value={config.model}
                  onChange={(event) => setConfig({ ...config, model: event.currentTarget.value })}
                />
                {modelLabel !== config.model && (
                  <div className="field-hint">当前模型：{modelLabel}</div>
                )}
              </div>
              <div className="field">
                <label>监听地址</label>
                <input
                  value={config.host}
                  onChange={(event) => setConfig({ ...config, host: event.currentTarget.value })}
                />
              </div>
              <div className="field">
                <label>监听端口</label>
                <input
                  type="number"
                  value={config.port}
                  onChange={(event) =>
                    setConfig({ ...config, port: Number(event.currentTarget.value || 0) })
                  }
                />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="section-header">
              <h2>高级参数</h2>
              <div className="actions">
                <button className="secondary" type="button" onClick={() => setAddingAdvanced((value) => !value)}>
                  {addingAdvanced ? "关闭添加" : "添加参数"}
                </button>
                <button className="secondary" type="button" onClick={removingAdvanced ? stopRemovingAdvanced : startRemovingAdvanced}>
                  {removingAdvanced ? "退出移除" : "移除参数"}
                </button>
              </div>
            </div>
            {addingAdvanced && availableAdvancedOptions.length > 0 && (
              <div className="advanced-chooser">
                {availableAdvancedOptions.map((option) => (
                  <button
                    key={option.key}
                    className="chip"
                    type="button"
                    onClick={() => {
                      const key = option.key;
                      setAdvancedEnabled((current) => ({ ...current, [key]: true }));
                      setConfig((current) => {
                        if (current.enabled_advanced_params.includes(key)) {
                          return current;
                        }
                        return {
                          ...current,
                          enabled_advanced_params: [...current.enabled_advanced_params, key]
                        };
                      });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            {enabledAdvancedKeys.map((key) => {
              const removable = removingAdvanced && key !== "ctx_size";
              return (
                <div className="field" key={key}>
                  <div className="field-header">
                    <label>{ADVANCED_LABELS[key]}</label>
                    {removable && (
                      <button
                        className="danger"
                        type="button"
                        onClick={() => removeAdvancedKey(key)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                  {key === "ctx_size" && (
                    <input
                      type="number"
                      value={config.ctx_size}
                      onChange={(event) =>
                        setConfig({ ...config, ctx_size: Number(event.currentTarget.value || 0) })
                      }
                    />
                  )}
                  {key === "n_predict" && (
                    <>
                      <input
                        value={advancedPredict}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          if (raw === "unlimited") {
                            setConfig({ ...config, n_predict: -1 });
                          } else if (raw === "") {
                            setConfig({ ...config, n_predict: 0 });
                          } else {
                            setConfig({ ...config, n_predict: Number(raw) });
                          }
                        }}
                      />
                      <div className="field-hint">输入 unlimited 表示不限制生成长度</div>
                    </>
                  )}
                  {key === "n_gpu_layers" && (
                    <>
                      <select
                        value={config.n_gpu_layers}
                        onChange={(event) =>
                          setConfig({ ...config, n_gpu_layers: Number(event.currentTarget.value || 0) })
                        }
                      >
                        <option value="0">auto</option>
                        <option value="1">1</option>
                        <option value="16">16</option>
                        <option value="32">32</option>
                        <option value="99">99</option>
                        <option value="999">全部</option>
                      </select>
                      <div className="field-hint">当前自动映射 Flash Attention 为 {advancedFlashAttn}</div>
                    </>
                  )}
                  {key === "threads" && (
                    <>
                      <input
                        value={advancedThreads}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          if (raw === "auto") {
                            setConfig({ ...config, threads: 0 });
                          } else if (raw === "") {
                            setConfig({ ...config, threads: 0 });
                          } else {
                            setConfig({ ...config, threads: Number(raw) });
                          }
                        }}
                      />
                      <div className="field-hint">留空或输入 auto 时由 llama-server 自动选择</div>
                    </>
                  )}
                  {key === "batch_size" && (
                    <>
                      <input
                        value={advancedBatchSize}
                        onChange={(event) => {
                          const raw = event.currentTarget.value;
                          if (raw === "auto") {
                            setConfig({ ...config, batch_size: 0 });
                          } else if (raw === "") {
                            setConfig({ ...config, batch_size: 0 });
                          } else {
                            setConfig({ ...config, batch_size: Number(raw) });
                          }
                        }}
                      />
                      <div className="field-hint">留空或输入 auto 时使用默认批处理大小</div>
                    </>
                  )}
                  {key === "temp" && (
                    <input
                      type="number"
                      step="0.05"
                      value={config.temp}
                      onChange={(event) =>
                        setConfig({ ...config, temp: Number(event.currentTarget.value || 0) })
                      }
                    />
                  )}
                  {key === "flash_attn" && (
                    <select
                      value={config.flash_attn}
                      onChange={(event) =>
                        setConfig({ ...config, flash_attn: event.currentTarget.value })
                      }
                    >
                      <option value="auto">auto</option>
                      <option value="on">on</option>
                      <option value="off">off</option>
                    </select>
                  )}
                  {key === "mmap" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={config.mmap}
                        onChange={(event) =>
                          setConfig({ ...config, mmap: event.currentTarget.checked })
                        }
                      />
                      mmap
                    </label>
                  )}
                  {key === "mlock" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={config.mlock}
                        onChange={(event) =>
                          setConfig({ ...config, mlock: event.currentTarget.checked })
                        }
                      />
                      mlock
                    </label>
                  )}
                </div>
              );
            })}
          </div>

          <div className="panel preview-bar">
            <div>
              <div className="preview-title">预览</div>
              <div className="preview-url">
                {previewUrl ? `预览地址：${previewUrl}` : "请先启动服务"}
              </div>
            </div>
            <div className="actions">
              <button className="secondary" onClick={handleOpenPreview} disabled={!status?.running}>
                打开预览
              </button>
            </div>
          </div>

          <div className="panel">
            <div className="section-header">
              <h2>配置</h2>
              <div className="actions">
                <button onClick={handleSave} disabled={saving}>
                  {saving ? "保存中..." : "保存配置"}
                </button>
              </div>
            </div>
            <div className="empty">
              高级参数按需添加；未加入的参数不会写入配置，启动时由 llama-server 自动决定。
            </div>
          </div>
        </section>
      </div>

      {error && <div className="error-banner">{error}</div>}
    </main>
  );
}

export default App;

