import { useState } from 'react';
import { useServer } from './hooks/useServer';
import { ControlPanel } from './components/ControlPanel';
import { LogPanel } from './components/LogPanel';
import { BasicParamsPanel } from './components/BasicParamsPanel';
import { AdvancedParamsPanel, type ExtraArgList } from './components/AdvancedParamsPanel';
import { RawParams } from './components/RawParams';
import { IconButton } from './components/IconButton';
import { ConfigManager } from './components/ConfigManager';
import { configToCommand, splitExtraArg, type ApplyPlan } from './lib/parseArgs';
import { useI18n } from './i18n';
import { SettingsDialog } from './components/SettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MetricsPanel } from './components/MetricsPanel';
import { useUpdater } from './hooks/useUpdater';
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
  const { t } = useI18n();
  const server = useServer();
  // 更新（方案 A）：手动检查、下载可见且可取消、安装需显式确认。
  const updater = useUpdater();
  const {
    config,
    configEpoch,
    isDirty,
    status,
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
    adjustingAdvanced,
    previewUrl,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    disabledAdvancedKeys,
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
    applyEnabled,
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
    setAdvancedEnabled,
  } = server;

  // 切配置守卫：当前有未保存改动时，先弹二次确认而非静默丢弃（脏数据提示）。
  const [pendingSelect, setPendingSelect] = useState<string | null>(null);
  const requestSelect = (name: string) => {
    if (isDirty) {
      setPendingSelect(name);
      return;
    }
    selectConfig(name);
  };

  // 恢复为当前选中配置的已保存版本：有未保存改动时弹确认（避免误点丢改动），
  // 否则直接回滚（此时回滚是无害的同配置重载）。按钮在干净时 disabled，故通常只脏时触发。
  const [pendingRestore, setPendingRestore] = useState(false);
  const requestRestore = () => {
    if (!isDirty) {
      selectConfig(activeName);
      return;
    }
    setPendingRestore(true);
  };

  // （追加参数提醒弹窗已移除：原始参数卡片改为实时回写，不再区分覆盖/追加）

  // 设置浮窗开关：齿轮图标触发，承载语言等偏好设置。
  const [showSettings, setShowSettings] = useState(false);

  // 「分享参数」：把当前配置序列化成启动命令行复制到剪切板。
  const shareConfig = async () => {
    if (!config) {
      return;
    }
    const text = configToCommand(config);
    const ok = await copyToClipboard(text);
    showToast(ok ? t('app.share.copied') : t('app.share.copyFailed'));
  };

  // 把解析出的套用计划真正写入配置：已知 flag 落到对应字段并启用高级键，
  // 未知 flag 以自定义参数（extra_args）原样进入启动命令。
  // 编辑态统一以覆盖方式实时回写配置（含必要参数一并套用，复原按钮负责回退）。
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
      // 套用粘帖命令是「重算整份自定义参数」，临时禁用态无意义：两个禁用列表一并清空，
      // 避免残留的禁用标记与本次套用结果脱节。
      next.disabled_advanced_params = [];
      next.disabled_extra_args = [];
      return next;
    });
    setAdvancedEnabled((current) => {
      const next = { ...current };
      plan.enable.forEach((key) => {
        next[key] = true;
      });
      return next;
    });
  };

  // （handleAppend 已移除：原始参数卡片编辑态统一覆盖回写，不再区分追加模式）

  // 自定义参数的归属列表：'enabled' 写入启动命令行，'disabled' 仅保留文本。

  // 移除某个自定义参数（按扁平数组里的起始下标，连同其值一并删掉）。
  const removeExtraArg = (list: ExtraArgList, start: number) => {
    setConfig((current) => {
      if (!current) return current;
      const key = list === 'enabled' ? 'extra_args' : 'disabled_extra_args';
      return {
        ...current,
        [key]: current[key].filter((_, i) => i < start || i >= start + 2),
      };
    });
  };

  // 编辑某个自定义参数：把整行文本重新拆成 [flag, value]，就地写回扁平数组的
  // [start, start+1] 两个槽位（保持成对结构不变，不影响其它条目的下标）。
  const updateExtraArg = (list: ExtraArgList, start: number, text: string) => {
    const [flag, value] = splitExtraArg(text);
    setConfig((current) => {
      if (!current) return current;
      const key = list === 'enabled' ? 'extra_args' : 'disabled_extra_args';
      const next = [...current[key]];
      next[start] = flag;
      next[start + 1] = value;
      return { ...current, [key]: next };
    });
  };

  // 临时禁用 / 启用某个自定义参数：把整组 [flag, value]（两个槽位）在两条列表间移动，
  // 文本保留，仅决定是否写入启动命令行。
  const toggleExtraArg = (list: ExtraArgList, start: number) => {
    setConfig((current) => {
      if (!current) return current;
      const fromKey = list === 'enabled' ? 'extra_args' : 'disabled_extra_args';
      const toKey = list === 'enabled' ? 'disabled_extra_args' : 'extra_args';
      const pair: [string, string] = [
        current[fromKey][start] ?? '',
        current[fromKey][start + 1] ?? '',
      ];
      const from = current[fromKey].filter((_, i) => i < start || i >= start + 2);
      const to = [...current[toKey], ...pair];
      return { ...current, [fromKey]: from, [toKey]: to };
    });
  };

  // 加载门前拦截：配置从后端拉取完成前不渲染表单，避免任何默认值落到前端硬编码。
  if (!config) {
    return (
      <main className="app">
        <div style={{ padding: '48px', textAlign: 'center', color: '#888' }}>
          {t('app.loading')}
        </div>
      </main>
    );
  }

  const statusText = status?.running ? t('status.running') : t('status.stopped');
  const statusClass = status?.running ? 'running' : 'stopped';

  return (
    <main className="app">
      <header className="header">
        <div className="header-top">
          <div className="header-title">
            <h1>Oh My Llama</h1>
            <div className={`status ${statusClass}`}>{statusText}</div>
          </div>
          <IconButton label={t('settings.title')} onClick={() => setShowSettings(true)}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"
              />
            </svg>
          </IconButton>
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
            isDirty={isDirty}
            renameTarget={renameTarget}
            onSelect={requestSelect}
            onRestoreConfig={requestRestore}
            onCreateEmpty={requestCreateEmpty}
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
          <RawParams
            config={config}
            configName={activeName}
            configEpoch={configEpoch}
            onApply={(p) => applyPlan(p)}
            onRestore={(cfg) => {
              setConfig(cfg);
              applyEnabled(cfg);
            }}
            showToast={showToast}
          />
          {/* （追加提醒弹窗已移除） */}
          <BasicParamsPanel config={config} models={models} onChange={setConfig} />
          <AdvancedParamsPanel
            config={config}
            adjustingAdvanced={adjustingAdvanced}
            availableAdvancedOptions={availableAdvancedOptions}
            enabledAdvancedKeys={enabledAdvancedKeys}
            disabledAdvancedKeys={disabledAdvancedKeys}
            advancedFlashAttn={advancedFlashAttn}
            advancedThreads={advancedThreads}
            advancedBatchSize={advancedBatchSize}
            advancedPredict={advancedPredict}
            onRemoveExtraArg={removeExtraArg}
            onUpdateExtraArg={updateExtraArg}
            onToggleExtraArg={toggleExtraArg}
            onToggleAdjust={() => setAdjustingAdvanced((value) => !value)}
            onAddKey={addAdvancedKey}
            onRemoveKey={removeAdvancedKey}
            onToggleDisableKey={toggleDisableKey}
            onClearAdvanced={clearAdvanced}
            onChange={setConfig}
          />
        </section>

        <section className="column main log-side">
          <MetricsPanel />
          <LogPanel logs={logs} onClear={handleClearLogs} />
        </section>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {toast && <div className="toast">{toast}</div>}
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onCheckUpdate={updater.check}
        checking={updater.status.kind === 'checking'}
      />
      <UpdateDialog
        status={updater.status}
        onDownload={updater.download}
        onCancel={updater.cancel}
        onInstall={updater.install}
        onDismiss={updater.dismiss}
        onRetry={updater.check}
      />
      <ConfirmDialog
        open={pendingSelect !== null}
        title={t('config.dirtySwitch.title')}
        message={t('config.dirtySwitch.body')}
        confirmText={t('config.dirtySwitch.confirm')}
        cancelText={t('common.cancel')}
        danger
        onConfirm={() => {
          if (pendingSelect) selectConfig(pendingSelect);
          setPendingSelect(null);
        }}
        onCancel={() => setPendingSelect(null)}
      />
      <ConfirmDialog
        open={pendingRestore}
        title={t('config.restoreTitle')}
        message={t('config.restoreBody', {
          name: activeName === 'default' ? t('config.default') : activeName,
        })}
        confirmText={t('config.restoreConfirm')}
        cancelText={t('common.cancel')}
        danger
        onConfirm={() => {
          selectConfig(activeName);
          setPendingRestore(false);
        }}
        onCancel={() => setPendingRestore(false)}
      />
    </main>
  );
}
