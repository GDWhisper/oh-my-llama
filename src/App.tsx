import { useState } from 'react';
import { useServer } from './hooks/useServer';
import { ControlPanel } from './components/ControlPanel';
import { LogPanel } from './components/LogPanel';
import { BasicParamsPanel } from './components/BasicParamsPanel';
import { AdvancedParamsPanel } from './components/AdvancedParamsPanel';
import { ParamPaste } from './components/ParamPaste';
import { Button } from './components/Button';
import { ConfigManager } from './components/ConfigManager';
import { configToCommand, splitExtraArg, type ApplyPlan } from './lib/parseArgs';
import type { ServerConfig } from './types';
import './App.css';

// 复制到剪切板：优先 navigator.clipboard（安全上下文），失败时回退 execCommand。
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下方回退
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export default function App() {
  const server = useServer();
  const {
    config,
    status,
    logs,
    commandLine,
    error,
    toast,
    showToast,
    models,
    modelMissing,
    modelSize,
    saving,
    starting,
    stopping,
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
    setAdjustingAdvanced,
    handleSave,
    handleStart,
    handleStop,
    handleOpenPreview,
    handleClearLogs,
    addAdvancedKey,
    removeAdvancedKey,
    clearAdvanced,
    setAdvancedEnabled,
  } = server;

  // 「一键传参」窗口开关：在配置管理卡片与必要参数卡片之间展开。
  const [showParamPaste, setShowParamPaste] = useState(false);
  // 追加参数前的提醒弹窗状态：非 null 时展示，列出将被剔除的必要参数与重复的自定义参数。
  const [appendWarn, setAppendWarn] = useState<{
    plan: ApplyPlan;
    necessary: string[];
    dups: string[];
  } | null>(null);

  // 「分享参数」：把当前配置序列化成启动命令行复制到剪切板。
  const shareConfig = async () => {
    if (!config) {
      return;
    }
    const text = configToCommand(config);
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制启动参数到剪切板' : '复制失败，请手动复制');
  };

  // 追加模式下「必要参数」：用户粘贴了这些字段也不覆盖当前配置（追加只加高级/自定义参数）。
  const NECESSARY_FIELDS = new Set<keyof ServerConfig>([
    'model',
    'host',
    'port',
    'llama_server_path',
    'model_dir',
  ]);
  // 弹窗里要提示剔除的必要参数字段（model_dir 是派生字段，无需单列提示）。
  const NECESSARY_LABELS: Partial<Record<keyof ServerConfig, string>> = {
    model: '模型路径',
    host: '监听地址',
    port: '监听端口',
    llama_server_path: '启动器路径',
  };

  // 把解析出的套用计划真正写入配置：已知 flag 落到对应字段并启用高级键，
  // 未知 flag 以自定义参数（extra_args）原样进入启动命令。
  // mode='overwrite'：所有已知字段套用 + 自定义参数整体替换（与旧「确认添加」一致）；
  // mode='append'：仅套用高级参数并启用高级键、自定义参数接到现有之后，
  //   必要参数（model/host/port/启动器路径）保持现有、不覆盖。
  const applyPlan = (plan: ApplyPlan, mode: 'overwrite' | 'append') => {
    setConfig((current) => {
      if (!current) return current;
      const next = { ...current };
      if (mode === 'append') {
        // 仅套用非必要字段（即高级参数）；必要参数保持现有，不覆盖。
        for (const key of Object.keys(plan.patch) as (keyof ServerConfig)[]) {
          if (!NECESSARY_FIELDS.has(key)) {
            (next as Record<string, unknown>)[key] = (plan.patch as Record<string, unknown>)[key];
          }
        }
      } else {
        Object.assign(next, plan.patch);
      }
      // -m/--model 附带推导 model_dir，让下拉框仍能定位到模型所在目录（仅覆盖模式）。
      if (mode === 'overwrite' && plan.patch.model !== undefined) {
        const v = plan.patch.model as string;
        const idx = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
        next.model_dir = idx > 0 ? v.slice(0, idx) : current.model_dir;
      }
      const enabledSet = new Set(current.enabled_advanced_params);
      plan.enable.forEach((key) => enabledSet.add(key));
      next.enabled_advanced_params = [...enabledSet];
      next.extra_args =
        mode === 'append' ? [...current.extra_args, ...plan.extraArgs] : plan.extraArgs;
      return next;
    });
    setAdvancedEnabled((current) => {
      const next = { ...current };
      plan.enable.forEach((key) => {
        next[key] = true;
      });
      return next;
    });
    setShowParamPaste(false);
  };

  // 点击【追加参数】：先收集「必要参数」与「重复自定义参数」两项提醒；
  // 都为空则直接追加、不打断；否则弹窗让用户决定「仍要追加 / 覆盖参数 / 取消」。
  const handleAppend = (plan: ApplyPlan) => {
    const necessary = (Object.keys(plan.patch) as (keyof ServerConfig)[]).filter(
      (k) => k in NECESSARY_LABELS,
    );
    const currentPairs: [string, string][] = [];
    if (config) {
      for (let i = 0; i + 1 < config.extra_args.length; i += 2) {
        currentPairs.push([config.extra_args[i], config.extra_args[i + 1]]);
      }
    }
    const dups: string[] = [];
    for (let i = 0; i + 1 < plan.extraArgs.length; i += 2) {
      const flag = plan.extraArgs[i];
      const value = plan.extraArgs[i + 1];
      if (currentPairs.some(([f, v]) => f === flag && v === value)) {
        dups.push(value !== '' ? `${flag} ${value}` : flag);
      }
    }
    if (necessary.length === 0 && dups.length === 0) {
      applyPlan(plan, 'append');
      return;
    }
    setAppendWarn({ plan, necessary, dups });
  };

  // 移除某个自定义参数（按扁平数组里的起始下标，连同其值一并删掉）。
  const removeExtraArg = (start: number) => {
    setConfig((current) => {
      if (!current) return current;
      return {
        ...current,
        extra_args: current.extra_args.filter((_, i) => i < start || i >= start + 2),
      };
    });
  };

  // 编辑某个自定义参数：把整行文本重新拆成 [flag, value]，就地写回扁平数组的
  // [start, start+1] 两个槽位（保持成对结构不变，不影响其它条目的下标）。
  const updateExtraArg = (start: number, text: string) => {
    const [flag, value] = splitExtraArg(text);
    setConfig((current) => {
      if (!current) return current;
      const next = [...current.extra_args];
      next[start] = flag;
      next[start + 1] = value;
      return { ...current, extra_args: next };
    });
  };

  // 加载门前拦截：配置从后端拉取完成前不渲染表单，避免任何默认值落到前端硬编码。
  if (!config) {
    return (
      <main className="app">
        <div style={{ padding: '48px', textAlign: 'center', color: '#888' }}>加载配置中…</div>
      </main>
    );
  }

  const statusText = status?.running ? '运行中' : '已停止';
  const statusClass = status?.running ? 'running' : 'stopped';

  return (
    <main className="app">
      <header className="header">
        <div className="header-top">
          <h1>Oh My Llama</h1>
          <div className={`status ${statusClass}`}>{statusText}</div>
        </div>
        <ControlPanel
          status={status}
          config={config}
          modelMissing={modelMissing}
          modelSize={modelSize}
          starting={starting}
          stopping={stopping}
          previewUrl={previewUrl}
          onStart={handleStart}
          onStop={handleStop}
          onOpenPreview={handleOpenPreview}
        />
      </header>

      <div className="layout">
        <section className="column sidebar">
          <ConfigManager
            configs={configs}
            activeName={activeName}
            renameTarget={renameTarget}
            onSelect={selectConfig}
            onCreateEmpty={requestCreateEmpty}
            onParamPaste={() => setShowParamPaste(true)}
            onShare={shareConfig}
            onSaveAsNew={requestSaveAsNew}
            onSave={handleSave}
            saving={saving}
            onRename={requestRename}
            onDelete={deleteConfig}
            nameDialog={nameDialog}
            onNameConfirm={confirmName}
            onNameCancel={cancelName}
          />
          {showParamPaste && (
            <ParamPaste
              onOverwrite={(p) => applyPlan(p, 'overwrite')}
              onAppend={(p) => handleAppend(p)}
              onClose={() => setShowParamPaste(false)}
            />
          )}
          {appendWarn && (
            <div className="modal-overlay" onClick={() => setAppendWarn(null)}>
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label="追加参数提醒"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-title">追加参数提醒</div>
                <div className="modal-body">
                  {appendWarn.necessary.length > 0 && (
                    <div>
                      <p style={{ margin: '0 0 6px' }}>
                        以下必要参数将
                        <span style={{ color: '#b91c1c', fontWeight: 600 }}>不填入</span>
                        当前配置（追加模式只追加高级参数）：
                      </p>
                      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                        {appendWarn.necessary.map((key) => (
                          <li key={key}>{NECESSARY_LABELS[key as keyof ServerConfig]}</li>
                        ))}
                      </ul>
                      <p style={{ margin: '0 0 8px' }}>
                        如需填入这些必要参数，请点击【覆盖参数】。
                      </p>
                    </div>
                  )}
                  {appendWarn.dups.length > 0 && (
                    <div>
                      <p style={{ margin: '0 0 6px' }}>以下自定义参数与现有完全相同（已存在）：</p>
                      <ul style={{ margin: '0', paddingLeft: 18 }}>
                        {appendWarn.dups.map((text) => (
                          <li key={text}>{text}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="modal-actions">
                  <Button variant="secondary" type="button" onClick={() => setAppendWarn(null)}>
                    取消
                  </Button>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      const p = appendWarn.plan;
                      setAppendWarn(null);
                      applyPlan(p, 'overwrite');
                    }}
                  >
                    覆盖参数
                  </Button>
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => {
                      const p = appendWarn.plan;
                      setAppendWarn(null);
                      applyPlan(p, 'append');
                    }}
                  >
                    仍要追加
                  </Button>
                </div>
              </div>
            </div>
          )}
          <BasicParamsPanel
            config={config}
            models={models}
            saving={saving}
            onSave={handleSave}
            onChange={setConfig}
          />
          <AdvancedParamsPanel
            config={config}
            adjustingAdvanced={adjustingAdvanced}
            availableAdvancedOptions={availableAdvancedOptions}
            enabledAdvancedKeys={enabledAdvancedKeys}
            advancedFlashAttn={advancedFlashAttn}
            advancedThreads={advancedThreads}
            advancedBatchSize={advancedBatchSize}
            advancedPredict={advancedPredict}
            onRemoveExtraArg={removeExtraArg}
            onUpdateExtraArg={updateExtraArg}
            onToggleAdjust={() => setAdjustingAdvanced((value) => !value)}
            onAddKey={addAdvancedKey}
            onRemoveKey={removeAdvancedKey}
            onClearAdvanced={clearAdvanced}
            saving={saving}
            onSave={handleSave}
            onChange={setConfig}
          />
        </section>

        <section className="column main log-side">
          <LogPanel logs={logs} commandLine={commandLine} onClear={handleClearLogs} />
        </section>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}
