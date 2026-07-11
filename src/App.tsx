import { useServer } from './hooks/useServer';
import { ControlPanel } from './components/ControlPanel';
import { LogPanel } from './components/LogPanel';
import { BasicParamsPanel } from './components/BasicParamsPanel';
import { AdvancedParamsPanel } from './components/AdvancedParamsPanel';
import { PreviewBar } from './components/PreviewBar';
import { ConfigPanel } from './components/ConfigPanel';
import './App.css';

export default function App() {
  const server = useServer();
  const {
    config,
    status,
    logs,
    error,
    saving,
    starting,
    stopping,
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
  } = server;

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
        <h1>Llama Launcher</h1>
        <div className={`status ${statusClass}`}>{statusText}</div>
      </header>

      <div className="layout">
        <section className="column sidebar">
          <ControlPanel
            status={status}
            starting={starting}
            stopping={stopping}
            onStart={handleStart}
            onStop={handleStop}
            onOpenPreview={handleOpenPreview}
          />
          <LogPanel logs={logs} onClear={handleClearLogs} />
        </section>

        <section className="column main">
          <BasicParamsPanel config={config} onChange={setConfig} />
          <AdvancedParamsPanel
            config={config}
            addingAdvanced={addingAdvanced}
            removingAdvanced={removingAdvanced}
            availableAdvancedOptions={availableAdvancedOptions}
            enabledAdvancedKeys={enabledAdvancedKeys}
            advancedFlashAttn={advancedFlashAttn}
            advancedThreads={advancedThreads}
            advancedBatchSize={advancedBatchSize}
            advancedPredict={advancedPredict}
            onToggleAdd={() => setAddingAdvanced((value) => !value)}
            onStartRemove={startRemovingAdvanced}
            onStopRemove={stopRemovingAdvanced}
            onAddKey={addAdvancedKey}
            onRemoveKey={removeAdvancedKey}
            onChange={setConfig}
          />
          <PreviewBar status={status} previewUrl={previewUrl} onOpenPreview={handleOpenPreview} />
          <ConfigPanel saving={saving} onSave={handleSave} />
        </section>
      </div>

      {error && <div className="error-banner">{error}</div>}
    </main>
  );
}
