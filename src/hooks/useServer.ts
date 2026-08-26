import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ConfigsState, ParamSpec, ServerConfig, ServerLogLine, ServerStatus } from '../types';
import {
  ADVANCED_ORDER,
  OPTIONAL_ADVANCED_OPTIONS,
  isUnlimitedPredict,
  type AdvancedKey,
} from '../lib/advanced';
import { useI18n } from '../i18n';

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

// listen 封装：注册成功后若组件已卸载（disposed）则立即取消监听。
// 背景：React StrictMode 开发模式会 mount→unmount→再 mount。effect 的 async IIFE 里
// `await listen(...)` 可能在 cleanup 执行之后才 resolve——cleanup 时 unlisten 尚未赋值、
// 监听注册成功后若无人复查 disposed，残留 listener 会一直存活，导致同一条事件被处理
// 两次（症状：日志面板每行双份、时间戳相同）。此封装把「注册后复查 disposed」收敛到一处。
async function listenGuarded<T>(
  event: string,
  handler: (payload: T) => void,
  isDisposed: () => boolean,
): Promise<(() => void) | undefined> {
  const unlisten = await listen(event, (ev) => handler(ev.payload as T));
  if (isDisposed()) {
    unlisten();
    return undefined;
  }
  return unlisten;
}

// 受管进程「曾可服务但持续无响应」判定阈值（毫秒）。
// 仅当进程曾被确认可服务（running=true）之后，又持续 N 秒探测不到（managed && !running），
// 才判定为「无响应」。这样能区别于「大模型仍在加载」的正常 加载中 态，
// 避免把慢加载误判为假死。60s = 约 40 次 1.5s 轮询，远超单次瞬断窗口。
const UNRESPONSIVE_MS = 60000;

export function useServer() {
  const { t } = useI18n();
  // 初始为 null：挂载后由后端默认值填充，加载完成前由 App 渲染加载占位。
  const [config, setConfig] = useState<ServerConfig | null>(null);
  // 配置镜像 ref：供轮询/状态检测的闭包读取最新 config，避免闭包捕获到过期 state。
  const configRef = useRef<ServerConfig | null>(null);
  configRef.current = config;
  const [status, setStatus] = useState<ServerStatus | null>(null);
  // 受管但持续无响应：managed && 曾可服务(running=true) && 持续 !running ≥ UNRESPONSIVE_MS。
  // wasReadyRef 记忆"是否曾被确认可服务"，unreachableSinceRef 记录首次失联时刻；
  // 两者皆 ref，使判定逻辑在轮询/唤醒/启动/停止后复用而无需依赖过期 state。
  const [unresponsive, setUnresponsive] = useState(false);
  const wasReadyRef = useRef(false);
  const unreachableSinceRef = useRef<number | null>(null);
  const [logs, setLogs] = useState<ServerLogLine[]>([]);
  // 启动命令行现由「原始参数」卡片从 config 实时派生展示，此处不再单独保存。
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
  // 各高级参数的「临时禁用」开关：与 advancedEnabled 平行；
  // 仅作用于已启用（显示）的参数，决定本次启动是否把它写入命令行。
  // ctx_size 是常驻必选参数，不参与禁用（始终生效）。
  const [disabledAdvancedKeys, setDisabledAdvancedKeys] =
    useState<Record<AdvancedKey, boolean>>(EMPTY_ADVANCED_ENABLED);
  // 「调整参数」模式：合并了原「添加参数」「移除参数」两种模式。
  // 开启后同时展示「可添加参数」候选片与各已启用参数上的「删除」按钮。
  const [adjustingAdvanced, setAdjustingAdvanced] = useState(false);
  // 模型路径指向的文件是否存在：null=未判定（含空路径），true=存在，false=已移走/删除
  const [modelExists, setModelExists] = useState<boolean | null>(null);
  // 当前模型文件字节大小：null=未判定/不存在（标题卡片用于展示 GB）
  const [modelSize, setModelSize] = useState<number | null>(null);
  // 模型目录下检测到的 .gguf 模型文件名列表（仅文件名，用于下拉框展示）
  const [models, setModels] = useState<string[]>([]);
  // 结构化高级参数注册表：单一真源在后端 params::PARAM_REGISTRY，挂载时拉取一次。
  // 前端据此通用渲染控件与序列化命令行，无需为每个官方参数硬编码 UI。
  const [registry, setRegistry] = useState<ParamSpec[]>([]);
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
  // 配置「重载纪元」：每次从已落盘版本载入 config（切换配置 / 恢复配置）时 +1。
  // 用于让「原始参数」卡片在「回滚到同名已保存配置」时也能感知并重置编辑态，
  // 避免把旧编辑文本误写回刚恢复的干净配置（切配置时 configName 不变，仅靠它无法触发）。
  const [configEpoch, setConfigEpoch] = useState(0);

  // 根据一份完整配置（含 enabled_advanced_params / disabled_advanced_params）重算高级参数开关状态。
  const applyEnabled = (cfg: ServerConfig | null) => {
    const base = defaultRef.current;
    const enabledList =
      cfg?.enabled_advanced_params && cfg.enabled_advanced_params.length > 0
        ? cfg.enabled_advanced_params
        : (base?.enabled_advanced_params ?? ['ctx_size']);
    const enabledSet = new Set(enabledList);
    const disabledList =
      cfg?.disabled_advanced_params && cfg.disabled_advanced_params.length > 0
        ? cfg.disabled_advanced_params
        : (base?.disabled_advanced_params ?? []);
    const disabledSet = new Set(disabledList);
    setAdvancedEnabled(() => {
      const next = {} as Record<AdvancedKey, boolean>;
      ADVANCED_ORDER.forEach((key) => {
        next[key] = enabledSet.has(key);
      });
      return next;
    });
    // 禁用态：仅对「已启用且非 ctx_size」的参数生效，避免给常驻参数加禁用开关。
    setDisabledAdvancedKeys(() => {
      const next = {} as Record<AdvancedKey, boolean>;
      ADVANCED_ORDER.forEach((key) => {
        next[key] = key !== 'ctx_size' && disabledSet.has(key);
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
      setError(t('err.loadConfig'));
      console.error(err);
    }
  };

  const loadStatus = async () => {
    // get_status 以配置地址做端口探测，需要当前配置；配置未加载时不探测以免误判。
    const cfg = configRef.current;
    if (!cfg) {
      return;
    }
    try {
      const data = await invoke<ServerStatus>('get_status', { config: cfg });
      setStatus(data);
      // 受管但持续无响应判定：只有"曾经可服务"之后又持续探测不到，才标无响应；
      // 从没 Ready 过（大模型仍在加载）一律只算 加载中，避免把慢加载误判为假死。
      // 此逻辑只读 ref/常量与稳定 setter，无过期 state 依赖，轮询/唤醒/启停后均可复用。
      if (data.running) {
        wasReadyRef.current = true;
        unreachableSinceRef.current = null;
        setUnresponsive(false);
      } else if (data.managed) {
        if (wasReadyRef.current) {
          if (unreachableSinceRef.current === null) {
            unreachableSinceRef.current = Date.now();
          } else if (Date.now() - unreachableSinceRef.current >= UNRESPONSIVE_MS) {
            setUnresponsive(true);
          }
        }
        // wasReady 为 false：仍在加载中，不标无响应（保持 加载中）。
      } else {
        wasReadyRef.current = false;
        unreachableSinceRef.current = null;
        setUnresponsive(false);
      }
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

  // 调用后端 file_size 命令取当前模型文件的字节大小，供标题卡片展示 GB。
  const loadModelSize = async (path: string) => {
    if (!path.trim()) {
      setModelSize(null);
      return;
    }
    try {
      const size = await invoke<number | null>('file_size', { path });
      setModelSize(size ?? null);
    } catch {
      setModelSize(null);
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
    invoke<ParamSpec[]>('get_param_registry')
      .then(setRegistry)
      .catch((err) => console.error(err));
    // 挂载时只拉取一次配置、状态与参数注册表（故意只在 [] 时执行）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 日志实时透传：挂载时先拉一次历史，随后订阅后端 log://line 增量事件逐行追加，
  // 不再靠轮询——这样进度/输出一产生就实时出现在面板。log://clear 用于清空同步。
  // 用 listenGuarded 注册：StrictMode 双挂载下若本 effect 已被卸载，注册成功后立即
  // 取消，避免残留 listener 把每条日志追加两遍（每行双份）。
  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    (async () => {
      try {
        const data = await invoke<ServerLogLine[]>('read_logs');
        if (!disposed) {
          setLogs(data);
        }
      } catch (err) {
        console.error(err);
      }
      const unLine = await listenGuarded<ServerLogLine>(
        'log://line',
        (line) => {
          setLogs((prev) => {
            const next = [...prev, line];
            if (next.length > 5000) {
              next.shift();
            }
            return next;
          });
        },
        () => disposed,
      );
      if (unLine) {
        unlisteners.push(unLine);
      }
      const unClear = await listenGuarded(
        'log://clear',
        () => setLogs([]),
        () => disposed,
      );
      if (unClear) {
        unlisteners.push(unClear);
      }
    })();
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);

  // 模型路径变化时立即判定一次指向的文件是否还存在。
  useEffect(() => {
    if (config?.model?.trim()) {
      void checkModelExists(config.model);
      void loadModelSize(config.model);
    } else {
      setModelExists(null);
      setModelSize(null);
    }
  }, [config?.model]);

  // 模型目录变化时（含初次加载）向后端拉取该目录下的 .gguf 模型列表，驱动下拉框。
  // 同时监听窗口聚焦 / 标签页可见：程序运行中往模型目录新增 .gguf 时无需重启即可秒刷新，
  // 用户切回窗口即触发一次重扫，体验无感（仅前端事件，不引入新依赖、不破坏分层）。
  useEffect(() => {
    const dir = config?.model_dir?.trim();
    if (!dir) {
      setModels([]);
      return;
    }
    const rescan = () => {
      void loadModels(dir);
    };
    // 初次进入（或目录变更）即扫一次，等价于原行为。
    rescan();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        rescan();
      }
    };
    window.addEventListener('focus', rescan);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', rescan);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [config?.model_dir]);

  // 即时刷新（状态探测 + 模型存在性/大小复查）：供 1.5s 轮询与「系统唤醒」事件共用，
  // 单一真源，避免轮询体重复。loadStatus/checkModelExists/loadModelSize 仅依赖稳定 ref
  // 与状态 setter，闭包恒稳定，故 useCallback 依赖为空。
  const refreshNow = useCallback(() => {
    void loadStatus();
    // 日志已改为事件实时推送，这里不再轮询日志。
    // 顺带复查模型文件是否存在，覆盖"应用开着时被外部移走/改名"的情况。
    const path = configRef.current?.model?.trim() ?? '';
    if (path) {
      void checkModelExists(path);
      void loadModelSize(path);
    } else {
      setModelExists(null);
      setModelSize(null);
    }
  }, []);

  useInterval(refreshNow, 1500);

  // 系统从睡眠/休眠唤醒时立即刷新状态：睡眠期间 JS 定时器被系统挂起，
  // 仅靠 1.5s 轮询会在唤醒后延迟最多一个周期才反映「睡眠中被回收/挂死的服务」。
  // Tauri 在 app 级派发 tauri://resume，挂上即「唤醒即查」，状态秒级回正（与外部杀进程同理）。
  // 用 listenGuarded 注册，与日志 listener 同一竞态防护（StrictMode 双挂载不残留）。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        unlisten = await listenGuarded(
          'tauri://resume',
          () => {
            if (!disposed) {
              refreshNow();
            }
          },
          () => disposed,
        );
      } catch (err) {
        console.error(err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshNow]);

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

  // 另存为：无论当前是默认还是命名配置，都基于「当前表单内容」弹命名窗，
  // 以新名称生成一个独立的新配置（不覆盖当前激活的配置）。
  const requestSaveAsNew = () => {
    setNameDialog({ open: true, mode: 'save-as-new' });
  };

  // 集中式保存：当前是默认配置时不能直接覆盖，改为弹出命名框生成新配置；
  // 当前是命名配置时直接覆盖原配置。
  const handleSave = async () => {
    if (!config) {
      return;
    }
    if (activeName === 'default') {
      requestSaveAsNew();
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await invoke('save_named_config', { name: activeName, config });
      configsRef.current = { ...configsRef.current, [activeName]: config };
      setConfigs(configsRef.current);
      showToast(t('toast.saveSuccess'));
    } catch (err) {
      setError(t('err.saveConfig'));
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
    setConfigEpoch((value) => value + 1);
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
    return `${t('config.autoNamePrefix')} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
        setError(t('err.rename', { message }));
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
      showToast(t('toast.saveSuccess'));
    } catch (err) {
      setError(t('err.saveConfig'));
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
      setError(t('err.deleteConfig'));
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
      const message = err instanceof Error ? err.message : t('err.startFallback');
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
      setError(t('err.stop'));
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
      setError(t('err.openPreview'));
      console.error(err);
    }
  };

  const handleClearLogs = async () => {
    try {
      await invoke('clear_logs');
      setLogs([]);
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
        // 新加入的参数默认处于「启用」状态：若它曾在禁用列表中，移除以免矛盾。
        disabled_advanced_params: current.disabled_advanced_params.filter((k) => k !== key),
      };
    });
  };

  const removeAdvancedKey = (key: AdvancedKey) => {
    setAdvancedEnabled((current) => ({ ...current, [key]: false }));
    setDisabledAdvancedKeys((current) => ({ ...current, [key]: false }));
    setConfig((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        enabled_advanced_params: current.enabled_advanced_params.filter((item) => item !== key),
        disabled_advanced_params: current.disabled_advanced_params.filter((item) => item !== key),
      };
    });
  };

  // 临时禁用/恢复某个高级参数：仅切换 disabled_advanced_params 与本地开关，
  // 不动用值与启用态（卡片仍显示、值保留）。ctx_size 无禁用开关。
  const toggleDisableKey = (key: AdvancedKey) => {
    if (key === 'ctx_size') {
      return;
    }
    setDisabledAdvancedKeys((current) => ({ ...current, [key]: !current[key] }));
    setConfig((current) => {
      if (!current) {
        return current;
      }
      const disabledSet = new Set(current.disabled_advanced_params);
      if (disabledSet.has(key)) {
        disabledSet.delete(key);
      } else {
        disabledSet.add(key);
      }
      return { ...current, disabled_advanced_params: [...disabledSet] };
    });
  };

  // ── 结构化高级参数的增删改（数据驱动：一套操作覆盖注册表里的全部官方参数）──
  // 与硬编码高级参数同构：enabled = 卡片显示，disabled = 显示但本次不传，值存字符串。
  const addStructuredKey = (key: string) => {
    setConfig((current) => {
      if (!current || current.enabled_structured_params.includes(key)) {
        return current;
      }
      const spec = registry.find((item) => item.key === key);
      return {
        ...current,
        enabled_structured_params: [...current.enabled_structured_params, key],
        disabled_structured_params: current.disabled_structured_params.filter((k) => k !== key),
        // 首次加入时用注册表默认值占位，避免出现「已启用但无值」的空卡片。
        structured_params: {
          ...current.structured_params,
          [key]: current.structured_params[key] ?? spec?.default ?? '',
        },
      };
    });
  };

  const removeStructuredKey = (key: string) => {
    setConfig((current) => {
      if (!current) {
        return current;
      }
      const nextValues = { ...current.structured_params };
      delete nextValues[key];
      return {
        ...current,
        enabled_structured_params: current.enabled_structured_params.filter((k) => k !== key),
        disabled_structured_params: current.disabled_structured_params.filter((k) => k !== key),
        structured_params: nextValues,
      };
    });
  };

  const setStructuredValue = (key: string, value: string) => {
    setConfig((current) =>
      current
        ? { ...current, structured_params: { ...current.structured_params, [key]: value } }
        : current,
    );
  };

  const toggleDisableStructuredKey = (key: string) => {
    setConfig((current) => {
      if (!current) {
        return current;
      }
      const disabledSet = new Set(current.disabled_structured_params);
      if (disabledSet.has(key)) {
        disabledSet.delete(key);
      } else {
        disabledSet.add(key);
      }
      return { ...current, disabled_structured_params: [...disabledSet] };
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
    setDisabledAdvancedKeys(() => EMPTY_ADVANCED_ENABLED());
    setConfig((current) => {
      if (!current) {
        return current;
      }
      const d = defaultRef.current;
      if (!d) {
        // defaults 尚未加载时退化为仅清空启用列表（保留常驻 ctx_size），避免用 undefined 覆盖原值。
        return {
          ...current,
          enabled_advanced_params: ['ctx_size'],
          disabled_advanced_params: [],
          extra_args: [],
          disabled_extra_args: [],
          enabled_structured_params: [],
          disabled_structured_params: [],
          structured_params: {},
        };
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
        disabled_advanced_params: [],
        extra_args: [],
        disabled_extra_args: [],
        enabled_structured_params: [],
        disabled_structured_params: [],
        structured_params: {},
      };
    });
  };

  const isDefault = activeName === 'default';

  // 脏数据检测：当前 live 配置（config）与「已落盘基线」是否不同。
  // 基线 = 默认配置(defaultRef) 或 当前命名配置(configsRef[activeName])。
  // 任何面板（必要/高级/原始参数）未保存的改动都会让 isDirty 为 true，
  // 供「未保存」标识与切配置前的二次确认使用。纯前端派生，不触后端默认值/IPC。
  const dirtyBaseline =
    activeName === 'default' ? defaultRef.current : configsRef.current[activeName];
  const isDirty =
    !!config && !!dirtyBaseline && JSON.stringify(config) !== JSON.stringify(dirtyBaseline);

  return {
    config,
    isDirty,
    configEpoch,
    status,
    unresponsive,
    logs,
    error,
    toast,
    showToast,
    models,
    modelMissing,
    modelSize,
    saving,
    starting,
    stopping,
    advancedEnabled,
    disabledAdvancedKeys,
    adjustingAdvanced,
    previewUrl,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    registry,
    configs,
    activeName,
    isDefault,
    defaultConfig,
    renameTarget,
    nameDialog,
    selectConfig,
    requestCreateEmpty,
    requestSaveAsNew,
    requestRename,
    confirmName,
    cancelName,
    deleteConfig,
    setConfig,
    applyEnabled,
    setAdvancedEnabled,
    setAdjustingAdvanced,
    handleSave,
    handleStart,
    handleStop,
    handleOpenPreview,
    handleClearLogs,
    addAdvancedKey,
    removeAdvancedKey,
    toggleDisableKey,
    clearAdvanced,
    addStructuredKey,
    removeStructuredKey,
    setStructuredValue,
    toggleDisableStructuredKey,
  };
}
