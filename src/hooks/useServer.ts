import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig, ServerLogLine, ServerStatus } from "../types";
import {
  ADVANCED_DEFAULT,
  ADVANCED_ORDER,
  OPTIONAL_ADVANCED_OPTIONS,
  isUnlimitedPredict,
  type AdvancedKey,
} from "../lib/advanced";

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

export function useServer() {
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

  const previewUrl = useMemo(() => (status?.running ? status.url : ""), [status]);
  const autoFlashAttn = useMemo(() => (config.n_gpu_layers > 0 ? "on" : "auto"), [config.n_gpu_layers]);
  const advancedFlashAttn = useMemo(
    () => (config.flash_attn === "auto" ? autoFlashAttn : config.flash_attn),
    [autoFlashAttn, config.flash_attn]
  );
  const advancedThreads = useMemo(
    () => (config.threads === 0 ? "auto" : String(config.threads)),
    [config.threads]
  );
  const advancedBatchSize = useMemo(
    () => (config.batch_size === 0 ? "auto" : String(config.batch_size)),
    [config.batch_size]
  );
  const advancedPredict = useMemo(
    () => (isUnlimitedPredict(config.n_predict) ? "unlimited" : String(config.n_predict)),
    [config.n_predict]
  );
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

  const addAdvancedKey = (key: AdvancedKey) => {
    setAdvancedEnabled((current) => ({ ...current, [key]: true }));
    setConfig((current) => {
      if (current.enabled_advanced_params.includes(key)) {
        return current;
      }
      return {
        ...current,
        enabled_advanced_params: [...current.enabled_advanced_params, key],
      };
    });
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
      enabled_advanced_params: current.enabled_advanced_params.filter((item) => item !== key),
    }));
  };

  return {
    config,
    status,
    logs,
    error,
    saving,
    starting,
    stopping,
    advancedEnabled,
    addingAdvanced,
    removingAdvanced,
    previewUrl,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    setConfig,
    setAdvancedEnabled,
    setAddingAdvanced,
    handleSave,
    handleStart,
    handleStop,
    handleOpenPreview,
    handleClearLogs,
    startRemovingAdvanced,
    stopRemovingAdvanced,
    addAdvancedKey,
    removeAdvancedKey,
  };
}
