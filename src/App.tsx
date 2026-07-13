import { useState, useRef } from 'react';
import { useServer } from './hooks/useServer';
import { ControlPanel } from './components/ControlPanel';
import { LogPanel } from './components/LogPanel';
import { BasicParamsPanel } from './components/BasicParamsPanel';
import { AdvancedParamsPanel } from './components/AdvancedParamsPanel';
import { ParamPaste } from './components/ParamPaste';
import { ConfigManager } from './components/ConfigManager';
import { configToCommand, type ApplyPlan } from './lib/parseArgs';
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
    models,
    modelMissing,
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

  // 「一键传参」窗口开关：在必要参数与高级参数两张卡片之间展开。
  const [showParamPaste, setShowParamPaste] = useState(false);

  // 轻量提示（复制成功等）：固定底部居中，约 2.2s 后自动消失。
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };
  // 「分享参数」：把当前配置序列化成启动命令行复制到剪切板。
  const shareConfig = async () => {
    if (!config) {
      return;
    }
    const text = configToCommand(config);
    const ok = await copyToClipboard(text);
    showToast(ok ? '已复制启动参数到剪切板' : '复制失败，请手动复制');
  };

  // 把解析出的套用计划真正写入配置：已知 flag 落到对应字段并启用高级键，
  // 未知 flag 以自定义参数（extra_args）原样进入启动命令。
  const applyPlan = (plan: ApplyPlan) => {
    setConfig((current) => {
      if (!current) return current;
      const next = { ...current, ...plan.patch };
      // -m/--model 附带推导 model_dir，让下拉框仍能定位到模型所在目录。
      if (plan.patch.model !== undefined) {
        const v = plan.patch.model as string;
        const idx = Math.max(v.lastIndexOf('/'), v.lastIndexOf('\\'));
        next.model_dir = idx > 0 ? v.slice(0, idx) : current.model_dir;
      }
      const enabledSet = new Set(current.enabled_advanced_params);
      plan.enable.forEach((key) => enabledSet.add(key));
      next.enabled_advanced_params = [...enabledSet];
      next.extra_args = plan.extraArgs;
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
            onRename={requestRename}
            onDelete={deleteConfig}
            nameDialog={nameDialog}
            onNameConfirm={confirmName}
            onNameCancel={cancelName}
          />
          <BasicParamsPanel
            config={config}
            models={models}
            saving={saving}
            onSave={handleSave}
            onChange={setConfig}
          />
          {showParamPaste && (
            <ParamPaste onConfirm={applyPlan} onClose={() => setShowParamPaste(false)} />
          )}
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
