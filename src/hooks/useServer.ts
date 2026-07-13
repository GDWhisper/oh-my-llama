import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ServerConfig, ServerLogLine, ServerStatus } from '../types';
import {
  ADVANCED_ORDER,
  OPTIONAL_ADVANCED_OPTIONS,
  isUnlimitedPredict,
  type AdvancedKey,
} from '../lib/advanced';

function useInterval(callback: () => void, delay: number | null) {
  useEffect(() => {
    if (delay == null) {
      return;
    }
    const id = window.setInterval(callback, delay);
    return () => window.clearInterval(id);
  }, [callback, delay]);
}

// 默认值唯一真源在后端（ServerConfig::default()）。前端不在任何地方硬编码默认值，
// 统一通过 get_default_config / read_config 命令从后端获取，避免前后端默认值漂移。
const EMPTY_ADVANCED_ENABLED = (): Record<AdvancedKey, boolean> =>
  ADVANCED_ORDER.reduce(
    (acc, key) => {
      acc[key] = false;
      return acc;
    },
    {} as Record<AdvancedKey, boolean>,
  );

export function useServer() {
  // 初始为 null：挂载后由后端默认值填充，加载完成前由 App 渲染加载占位。
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [logs, setLogs] = useState<ServerLogLine[]>([]);
  // 我们发送给 llama-server 的命令行（level=cmd）：单独保存，供原生模式置顶固定显示，
  // 不进日志滚动缓冲、不会随输出增多被挤掉。
  const [commandLine, setCommandLine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [advancedEnabled, setAdvancedEnabled] =
    useState<Record<AdvancedKey, boolean>>(EMPTY_ADVANCED_ENABLED);
  const [addingAdvanced, setAddingAdvanced] = useState(false);
  const [removingAdvanced, setRemovingAdvanced] = useState(false);
  // 模型路径指向的文件是否存在：null=未判定（含空路径），true=存在，false=已移走/删除
  const [modelExists, setModelExists] = useState<boolean | null>(null);
  // 模型目录下检测到的 .gguf 模型文件名列表（仅文件名，用于下拉框展示）
  const [models, setModels] = useState<string[]>([]);
  // 后端默认配置（ServerConfig::default()），仅用于「清空高级参数」时把各高级值复位到默认。
  const defaultsRef = useRef<ServerConfig | null>(null);

  const loadConfig = async () => {
    setError(null);
    try {
      const [data, defaults] = await Promise.all([
        invoke<ServerConfig>('read_config'),
        invoke<ServerConfig>('get_default_config'),
      ]);
      const enabledList =
        data.enabled_advanced_params && data.enabled_advanced_params.length > 0
          ? data.enabled_advanced_params
          : defaults.enabled_advanced_params;
      const enabledSet = new Set(enabledList);
      setAdvancedEnabled(() => {
        const next = {} as Record<AdvancedKey, boolean>;
        ADVANCED_ORDER.forEach((key) => {
          next[key] = enabledSet.has(key);
        });
        return next;
      });
      defaultsRef.current = defaults;
      setConfig({
        ...defaults,
        ...data,
        host: data.host || defaults.host,
        flash_attn: data.flash_attn || defaults.flash_attn,
        enabled_advanced_params: enabledList,
      });
    } catch (err) {
      setError('读取配置失败');
      console.error(err);
    }
  };

  const loadStatus = async () => {
    try {
      const data = await invoke<ServerStatus>('get_status');
      setStatus(data);
    } catch (err) {
      console.error(err);
    }
  };

  // 调用后端 file_exists 命令判定模型路径指向的文件是否仍存在。
  // 文件检查属于后端职责（前端严守分层，不直接读文件系统）。
  const checkModelExists = async (path: string) => {
    if (!path.trim()) {
      setModelExists(null);
      return;
    }
    try {
      const exists = await invoke<boolean>('file_exists', { path });
      setModelExists(exists);
    } catch (err) {
      console.error(err);
      setModelExists(null);
    }
  };

  // 调用后端 list_models 命令，拉取指定目录下的 .gguf 模型文件名列表。
  // 目录读取属于后端职责（前端严守分层，不直接读文件系统）。
  const loadModels = async (dir: string) => {
    try {
      const list = await invoke<string[]>('list_models', { dir });
      setModels(list);
    } catch (err) {
      console.error(err);
      setModels([]);
    }
  };

  useEffect(() => {
    loadConfig();
    loadStatus();
  }, []);

  // 日志实时透传：挂载时先拉一次历史，随后订阅后端 log://line 增量事件逐行追加，
  // 不再靠轮询——这样进度/输出一产生就实时出现在面板。命令行(level=cmd)单独提取到
  // commandLine 供置顶显示。log://clear 用于清空同步。
  useEffect(() => {
    let unlistenLine: (() => void) | undefined;
    let unlistenClear: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const data = await invoke<ServerLogLine[]>('read_logs');
        if (!disposed) {
          setLogs(data);
          const lastCmd = [...data].reverse().find((line) => line.level === 'cmd');
          if (lastCmd) {
            setCommandLine(lastCmd.text);
          }
        }
      } catch (err) {
        console.error(err);
      }
      unlistenLine = await listen<ServerLogLine>('log://line', (event) => {
        const line = event.payload;
        if (line.level === 'cmd') {
          setCommandLine(line.text);
        }
        setLogs((prev) => {
          const next = [...prev, line];
          if (next.length > 5000) {
            next.shift();
          }
          return next;
        });
      });
      unlistenClear = await listen('log://clear', () => {
        setLogs([]);
        setCommandLine(null);
      });
    })();
    return () => {
      disposed = true;
      unlistenLine?.();
      unlistenClear?.();
    };
  }, []);

  // 模型路径变化时立即判定一次指向的文件是否还存在。
  useEffect(() => {
    if (config?.model?.trim()) {
      void checkModelExists(config.model);
    } else {
      setModelExists(null);
    }
  }, [config?.model]);

  // 模型目录变化时（含初次加载）向后端拉取该目录下的 .gguf 模型列表，驱动下拉框。
  useEffect(() => {
    const dir = config?.model_dir?.trim();
    if (dir) {
      void loadModels(dir);
    } else {
      setModels([]);
    }
  }, [config?.model_dir]);

  useInterval(() => {
    loadStatus();
    // 日志已改为事件实时推送，这里不再轮询日志。
    // 顺带轮询模型文件是否存在，覆盖"应用开着时被外部移走"的情况
    if (config?.model?.trim()) {
      void checkModelExists(config.model);
    } else {
      setModelExists(null);
    }
  }, 1500);

  const previewUrl = useMemo(() => (status?.running ? status.url : ''), [status]);
  const modelMissing = modelExists === false;
  const autoFlashAttn = useMemo(
    () => ((config?.n_gpu_layers ?? 0) > 0 ? 'on' : 'auto'),
    [config?.n_gpu_layers],
  );
  const advancedFlashAttn = useMemo(
    () => (config?.flash_attn === 'auto' ? autoFlashAttn : (config?.flash_attn ?? 'auto')),
    [autoFlashAttn, config?.flash_attn],
  );
  const advancedThreads = useMemo(
    () => ((config?.threads ?? 0) === 0 ? 'auto' : String(config?.threads ?? 0)),
    [config?.threads],
  );
  const advancedBatchSize = useMemo(
    () => ((config?.batch_size ?? 0) === 0 ? 'auto' : String(config?.batch_size ?? 0)),
    [config?.batch_size],
  );
  const advancedPredict = useMemo(
    () =>
      isUnlimitedPredict(config?.n_predict ?? -1) ? 'unlimited' : String(config?.n_predict ?? -1),
    [config?.n_predict],
  );
  const availableAdvancedOptions = useMemo(
    () => OPTIONAL_ADVANCED_OPTIONS.filter((option) => !advancedEnabled[option.key]),
    [advancedEnabled],
  );

  const enabledAdvancedKeys = useMemo(
    () => ADVANCED_ORDER.filter((key) => advancedEnabled[key]),
    [advancedEnabled],
  );

  const handleSave = async () => {
    if (!config) {
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await invoke('save_config', { config });
    } catch (err) {
      setError('保存配置失败');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleStart = async () => {
    if (!config) {
      return;
    }
    setError(null);
    setStarting(true);
    try {
      await invoke('start_server', { config });
      await loadStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : '启动失败';
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
      await invoke('stop_server');
      await loadStatus();
    } catch (err) {
      setError('停止失败');
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
      await invoke('open_preview');
    } catch (err) {
      setError('打开预览失败');
      console.error(err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await invoke('clear_logs');
      setLogs([]);
      setCommandLine(null);
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
      if (!current || current.enabled_advanced_params.includes(key)) {
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
    setConfig((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        enabled_advanced_params: current.enabled_advanced_params.filter((item) => item !== key),
      };
    });
  };

  // 清空所有高级参数：移除全部已启用项（enabled_advanced_params 置空），
  // 并把各高级值复位到后端默认值；UI 开关状态同步清空。需用户先二次确认再调用。
  // 与「移除参数」一致，仅修改内存配置，仍需点「保存配置」才会持久化。
  const clearAdvanced = () => {
    setAddingAdvanced(false);
    setRemovingAdvanced(false);
    // ctx_size（上下文长度）是常驻必选参数：不可删除、也不在「可添加」列表里。
    // 清空时必须保留它启用，否则它既不显示、又无法再添加，会造成死锁。
    setAdvancedEnabled(() => {
      const next = EMPTY_ADVANCED_ENABLED();
      next.ctx_size = true;
      return next;
    });
    setConfig((current) => {
      if (!current) {
        return current;
      }
      const d = defaultsRef.current;
      if (!d) {
        // defaults 尚未加载时退化为仅清空启用列表（保留常驻 ctx_size），避免用 undefined 覆盖原值。
        return { ...current, enabled_advanced_params: ['ctx_size'] };
      }
      return {
        ...current,
        ctx_size: d.ctx_size,
        n_predict: d.n_predict,
        n_gpu_layers: d.n_gpu_layers,
        threads: d.threads,
        batch_size: d.batch_size,
        temp: d.temp,
        flash_attn: d.flash_attn,
        mmap: d.mmap,
        mlock: d.mlock,
        enabled_advanced_params: ['ctx_size'],
      };
    });
  };

  return {
    config,
    status,
    logs,
    commandLine,
    error,
    models,
    modelMissing,
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
    clearAdvanced,
  };
}
