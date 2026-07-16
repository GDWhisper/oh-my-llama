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
import { useI18n } from './i18n';
import type { MessageKey } from './i18n/messages';
import { SettingsDialog } from './components/SettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { useUpdater } from './hooks/useUpdater';
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
  const { t } = useI18n();
  const server = useServer();
  // 更新（方案 A）：手动检查、下载可见且可取消、安装需显式确认。
  const updater = useUpdater();
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

  // 追加参数前的提醒弹窗状态：非 null 时展示，列出将被剔除的必要参数与重复的自定义参数。
  const [appendWarn, setAppendWarn] = useState<{
    plan: ApplyPlan;
    necessary: string[];
    dups: string[];
  } | null>(null);

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

  // 追加模式下「必要参数」：用户粘贴了这些字段也不覆盖当前配置（追加只加高级/自定义参数）。
  const NECESSARY_FIELDS = new Set<keyof ServerConfig>([
    'model',
    'host',
    'port',
    'llama_server_path',
    'model_dir',
  ]);
  // 弹窗里要提示剔除的必要参数字段（model_dir 是派生字段，无需单列提示）。
  // 值为 i18n 文案键，渲染时用 t() 取译文。
  const NECESSARY_LABEL_KEYS: Partial<Record<keyof ServerConfig, MessageKey>> = {
    model: 'field.model',
    host: 'field.host',
    port: 'field.port',
    llama_server_path: 'field.serverPath',
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
  };

  // 点击【追加参数】：先收集「必要参数」与「重复自定义参数」两项提醒；
  // 都为空则直接追加、不打断；否则弹窗让用户决定「仍要追加 / 覆盖参数 / 取消」。
  const handleAppend = (plan: ApplyPlan) => {
    const necessary = (Object.keys(plan.patch) as (keyof ServerConfig)[]).filter(
      (k) => k in NECESSARY_LABEL_KEYS,
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
          <button
            type="button"
            className="gear-btn"
            aria-label={t('settings.title')}
            onClick={() => setShowSettings(true)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"
              />
            </svg>
          </button>
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
          <ParamPaste
            onOverwrite={(p) => applyPlan(p, 'overwrite')}
            onAppend={(p) => handleAppend(p)}
          />
          {appendWarn && (
            <div className="modal-overlay" onClick={() => setAppendWarn(null)}>
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                aria-label={t('append.title')}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="modal-title">{t('append.title')}</div>
                <div className="modal-body">
                  {appendWarn.necessary.length > 0 && (
                    <div>
                      <p style={{ margin: '0 0 6px' }}>
                        {t('append.necessaryPre')}
                        <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                          {t('append.necessaryStrong')}
                        </span>
                        {t('append.necessaryPost')}
                      </p>
                      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                        {appendWarn.necessary.map((key) => (
                          <li key={key}>{t(NECESSARY_LABEL_KEYS[key as keyof ServerConfig]!)}</li>
                        ))}
                      </ul>
                      <p style={{ margin: '0 0 8px' }}>{t('append.necessaryHint')}</p>
                    </div>
                  )}
                  {appendWarn.dups.length > 0 && (
                    <div>
                      <p style={{ margin: '0 0 6px' }}>{t('append.dupsIntro')}</p>
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
                    {t('common.cancel')}
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
                    {t('paramPaste.overwrite')}
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
                    {t('append.stillAppend')}
                  </Button>
                </div>
              </div>
            </div>
          )}
          <BasicParamsPanel config={config} models={models} onChange={setConfig} />
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
            onChange={setConfig}
          />
        </section>

        <section className="column main log-side">
          <LogPanel logs={logs} commandLine={commandLine} onClear={handleClearLogs} />
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
    </main>
  );
}
