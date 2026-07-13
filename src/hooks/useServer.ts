import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ConfigsState, ServerConfig, ServerLogLine, ServerStatus } from '../types';
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
  // 轻量提示（保存成功 / 复制成功等）：固定底部居中，约 2.2s 后自动消失。
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [advancedEnabled, setAdvancedEnabled] =
    useState<Record<AdvancedKey, boolean>>(EMPTY_ADVANCED_ENABLED);
  // 「调整参数」模式：合并了原「添加参数」「移除参数」两种模式。
  // 开启后同时展示「可添加参数」候选片与各已启用参数上的「删除」按钮。
  const [adjustingAdvanced, setAdjustingAdvanced] = useState(false);
  // 模型路径指向的文件是否存在：null=未判定（含空路径），true=存在，false=已移走/删除
  const [modelExists, setModelExists] = useState<boolean | null>(null);
  // 模型目录下检测到的 .gguf 模型文件名列表（仅文件名，用于下拉框展示）
  const [models, setModels] = useState<string[]>([]);
  // 后端默认配置（ServerConfig::default()）：既作为「默认配置」只读模板，
  // 也用于「清空高级参数」时把各高级值复位到默认。
  const defaultRef = useRef<ServerConfig | null>(null);
  const [defaultConfig, setDefaultConfig] = useState<ServerConfig | null>(null);
  // 多配置管理：命名配置库 + 当前选中名（'default' 表示默认配置）。
  const [configs, setConfigs] = useState<Record<string, ServerConfig>>({});
  const [activeName, setActiveName] = useState<string>('default');
  // 「保存为新配置 / 新建空配置 / 重命名配置」的名称输入弹窗状态。
  const [nameDialog, setNameDialog] = useState<{
    open: boolean;
    mode: 'save-as-new' | 'create-empty' | 'rename';
  }>({ open: false, mode: 'save-as-new' });
  // 重命名弹窗对应的「原名」（确认时作为 old_name 传给后端）。
  const [renameTarget, setRenameTarget] = useState<string>('');
  // 用于避免闭包读到过期 state 的镜像 ref。
  const configsRef = useRef<Record<string, ServerConfig>>({});
  const activeRef = useRef<string>('default');

  // 根据一份完整配置（含 enabled_advanced_params）重算高级参数开关状态。
  const applyEnabled = (cfg: ServerConfig | null) => {
    const base = defaultRef.current;
    const enabledList =
      cfg?.enabled_advanced_params && cfg.enabled_advanced_params.length > 0
        ? cfg.enabled_advanced_params
        : (base?.enabled_advanced_params ?? ['ctx_size']);
    const enabledSet = new Set(enabledList);
    setAdvancedEnabled(() => {
      const next = {} as Record<AdvancedKey, boolean>;
      ADVANCED_ORDER.forEach((key) => {
        next[key] = enabledSet.has(key);
      });
      return next;
    });
  };

  const loadConfig = async () => {
    setError(null);
    try {
      const state = await invoke<ConfigsState>('get_configs_state');
      const def = state.default;
      defaultRef.current = def;
      setDefaultConfig(def);
      configsRef.current = state.configs;
      setConfigs(state.configs);
      const active =
        state.active === 'default' || state.configs[state.active] ? state.active : 'default';
      activeRef.current = active;
      setActiveName(active);
      const base = active === 'default' ? def : (state.configs[active] ?? def);
      setConfig({ ...def, ...base });
      applyEnabled(base);
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
    // 挂载时只拉取一次配置与状态（故意只在 [] 时执行）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 集中式保存：当前是默认配置时不能直接覆盖，改为弹出命名框生成新配置；
  // 当前是命名配置时直接覆盖原配置。
  const handleSave = async () => {
    if (!config) {
      return;
    }
    if (activeName === 'default') {
      setNameDialog({ open: true, mode: 'save-as-new' });
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await invoke('save_named_config', { name: activeName, config });
      configsRef.current = { ...configsRef.current, [activeName]: config };
      setConfigs(configsRef.current);
      showToast('保存成功');
    } catch (err) {
      setError('保存配置失败');
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  // 切换当前配置：把目标配置载入表单并持久化「当前选中」。
  const selectConfig = async (name: string) => {
    activeRef.current = name;
    setActiveName(name);
    try {
      await invoke('set_active', { name });
    } catch (err) {
      console.error(err);
    }
    const base = name === 'default' ? defaultRef.current : configsRef.current[name];
    if (!base) {
      return;
    }
    setConfig({ ...defaultRef.current, ...base });
    applyEnabled(base);
  };

  // 打开「新建空配置」命名弹窗（空配置 = 工厂默认参数的副本）。
  const requestCreateEmpty = () => {
    setNameDialog({ open: true, mode: 'create-empty' });
  };

  const cancelName = () => {
    setNameDialog({ open: false, mode: 'save-as-new' });
  };

  // 打开「重命名配置」弹窗（预填当前名，确认时作为 old_name 传给后端）。
  const requestRename = (name: string) => {
    setRenameTarget(name);
    setNameDialog({ open: true, mode: 'rename' });
  };

  // 名称留空时按日期时间自动生成。
  const autoConfigName = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `配置 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  // 命名弹窗确认：把 base 配置以给定名存为命名配置并切换过去。
  const confirmName = async (rawName: string) => {
    const def = defaultRef.current;
    if (!def) {
      return;
    }
    // 重命名分支：old_name 是当前配置名，new_name 为用户输入（不可为空/同名）。
    if (nameDialog.mode === 'rename') {
      const oldName = renameTarget;
      const newName = rawName.trim();
      if (!newName || newName === oldName) {
        // 空名或同名：视作未改动，直接关闭。
        setNameDialog({ open: false, mode: 'save-as-new' });
        setRenameTarget('');
        return;
      }
      setError(null);
      setSaving(true);
      try {
        // Tauri v2 把命令参数以 camelCase 暴露给 JS：Rust 端 old_name/new_name
        // 在 invoke 中须用 oldName/newName（本应用其余命令都是单词参数，未触发此约定）。
        await invoke('rename_named_config', { oldName: oldName, newName: newName });
        const next = { ...configsRef.current };
        const value = next[oldName];
        delete next[oldName];
        next[newName] = value;
        configsRef.current = next;
        setConfigs(next);
        if (activeRef.current === oldName) {
          activeRef.current = newName;
          setActiveName(newName);
          await invoke('set_active', { name: newName });
        }
      } catch (err) {
        // 透出真实错误（如「命令不存在」说明后端未重编，或「配置名已存在」等），便于定位。
        const message = err instanceof Error ? err.message : String(err);
        setError(`重命名失败：${message}`);
        console.error(err);
      } finally {
        setSaving(false);
        setNameDialog({ open: false, mode: 'save-as-new' });
        setRenameTarget('');
      }
      return;
    }
    const name = rawName.trim() || autoConfigName();
    const base = nameDialog.mode === 'save-as-new' ? (config ?? def) : def;
    setError(null);
    setSaving(true);
    try {
      await invoke('save_named_config', { name, config: base });
      configsRef.current = { ...configsRef.current, [name]: base };
      setConfigs(configsRef.current);
      activeRef.current = name;
      setActiveName(name);
      await invoke('set_active', { name });
      setConfig({ ...def, ...base });
      applyEnabled(base);
      showToast('保存成功');
    } catch (err) {
      setError('保存配置失败');
      console.error(err);
    } finally {
      setSaving(false);
      setNameDialog({ open: false, mode: 'save-as-new' });
    }
  };

  // 删除命名配置（默认配置不可删）；若正选中它则回退到默认配置。
  const deleteConfig = async (name: string) => {
    try {
      await invoke('delete_named_config', { name });
      const next = { ...configsRef.current };
      delete next[name];
      configsRef.current = next;
      setConfigs(next);
      if (activeRef.current === name) {
        activeRef.current = 'default';
        setActiveName('default');
        await invoke('set_active', { name: 'default' });
        const def = defaultRef.current;
        if (def) {
          setConfig({ ...def });
          applyEnabled(def);
        }
      }
    } catch (err) {
      setError('删除配置失败');
      console.error(err);
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
    setAdvancedEnabled((current) => ({ ...current, [key]: false }));
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
    setAdjustingAdvanced(false);
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
      const d = defaultRef.current;
      if (!d) {
        // defaults 尚未加载时退化为仅清空启用列表（保留常驻 ctx_size），避免用 undefined 覆盖原值。
        return { ...current, enabled_advanced_params: ['ctx_size'], extra_args: [] };
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
        extra_args: [],
      };
    });
  };

  const isDefault = activeName === 'default';

  return {
    config,
    status,
    logs,
    commandLine,
    error,
    toast,
    showToast,
    models,
    modelMissing,
    saving,
    starting,
    stopping,
    advancedEnabled,
    adjustingAdvanced,
    previewUrl,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    configs,
    activeName,
    isDefault,
    defaultConfig,
    renameTarget,
    nameDialog,
    selectConfig,
    requestCreateEmpty,
    requestRename,
    confirmName,
    cancelName,
    deleteConfig,
    setConfig,
    setAdvancedEnabled,
    setAdjustingAdvanced,
    handleSave,
    handleStart,
    handleStop,
    handleOpenPreview,
    handleClearLogs,
    addAdvancedKey,
    removeAdvancedKey,
    clearAdvanced,
  };
}
