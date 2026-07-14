import { useEffect, useState } from 'react';
import type { ServerConfig } from '../types';
import { ADVANCED_LABEL_KEYS, type AdvancedKey, type AdvancedOption } from '../lib/advanced';
import { groupExtraArgs } from '../lib/parseArgs';
import { useI18n } from '../i18n';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

// 单条「自定义参数」的可编辑行。用本地草稿承接输入、失焦时才提交，
// 避免「受控输入 + 每次按键重新分词归一化」导致的光标跳动 / 尾随空格被吞。
// 当外部文本变化（如切换配置、提交后归一化）时通过 effect 同步草稿。
function ExtraArgRow({
  text,
  onCommit,
  onRemove,
}: {
  text: string;
  onCommit: (value: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    setDraft(text);
  }, [text]);
  return (
    <div className="field extra-args">
      <div className="field-header">
        <label>{t('advanced.customParam')}</label>
        <Button variant="danger" type="button" onClick={onRemove}>
          {t('common.delete')}
        </Button>
      </div>
      <input
        className="extra-value-input"
        value={draft}
        spellCheck={false}
        placeholder={t('advanced.customPlaceholder')}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (draft !== text) {
            onCommit(draft);
          }
        }}
      />
    </div>
  );
}

interface Props {
  config: ServerConfig;
  adjustingAdvanced: boolean;
  availableAdvancedOptions: AdvancedOption[];
  enabledAdvancedKeys: AdvancedKey[];
  advancedFlashAttn: string;
  advancedThreads: string;
  advancedBatchSize: string;
  advancedPredict: string;
  onRemoveExtraArg: (index: number) => void;
  onUpdateExtraArg: (index: number, text: string) => void;
  onToggleAdjust: () => void;
  onAddKey: (key: AdvancedKey) => void;
  onRemoveKey: (key: AdvancedKey) => void;
  onClearAdvanced: () => void;
  saving: boolean;
  onSave: () => void;
  onChange: (config: ServerConfig) => void;
}

export function AdvancedParamsPanel(props: Props) {
  const {
    config,
    adjustingAdvanced,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    onRemoveExtraArg,
    onUpdateExtraArg,
    onToggleAdjust,
    onAddKey,
    onRemoveKey,
    onClearAdvanced,
    saving,
    onSave,
    onChange,
  } = props;
  const { t } = useI18n();
  // 清空高级参数需二次确认：点击「清空参数」弹出确认弹窗，确认后才执行。
  const [showClearDialog, setShowClearDialog] = useState(false);

  return (
    <div className="panel">
      <div className="section-header">
        <h2>{t('advanced.title')}</h2>
        <div className="actions">
          <Button
            variant={adjustingAdvanced ? 'secondary-active' : 'secondary'}
            type="button"
            onClick={onToggleAdjust}
          >
            {adjustingAdvanced ? t('advanced.doneAdjust') : t('advanced.adjust')}
          </Button>
        </div>
      </div>
      {adjustingAdvanced && availableAdvancedOptions.length > 0 && (
        <div className="advanced-chooser">
          {availableAdvancedOptions.map((option) => (
            <button
              key={option.key}
              className="chip"
              type="button"
              onClick={() => onAddKey(option.key)}
            >
              {t(ADVANCED_LABEL_KEYS[option.key])}
            </button>
          ))}
        </div>
      )}
      {enabledAdvancedKeys.map((key) => {
        const removable = adjustingAdvanced && key !== 'ctx_size';
        return (
          <div className="field" key={key}>
            <div className="field-header">
              <label>{t(ADVANCED_LABEL_KEYS[key])}</label>
              {removable && (
                <Button variant="danger" type="button" onClick={() => onRemoveKey(key)}>
                  {t('common.delete')}
                </Button>
              )}
            </div>
            {key === 'ctx_size' && (
              <input
                type="number"
                value={config.ctx_size}
                onChange={(event) =>
                  onChange({ ...config, ctx_size: Number(event.currentTarget.value || 0) })
                }
              />
            )}
            {key === 'n_predict' && (
              <>
                <input
                  value={advancedPredict}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    if (raw === 'unlimited') {
                      onChange({ ...config, n_predict: -1 });
                    } else if (raw === '') {
                      onChange({ ...config, n_predict: 0 });
                    } else {
                      onChange({ ...config, n_predict: Number(raw) });
                    }
                  }}
                />
                <div className="field-hint">{t('advanced.predictHint')}</div>
              </>
            )}
            {key === 'n_gpu_layers' && (
              <>
                <select
                  value={config.n_gpu_layers}
                  onChange={(event) =>
                    onChange({ ...config, n_gpu_layers: Number(event.currentTarget.value || 0) })
                  }
                >
                  <option value="0">auto</option>
                  <option value="1">1</option>
                  <option value="16">16</option>
                  <option value="32">32</option>
                  <option value="99">99</option>
                  <option value="999">{t('advanced.gpuAll')}</option>
                </select>
                <div className="field-hint">
                  {t('advanced.flashHint', { value: advancedFlashAttn })}
                </div>
              </>
            )}
            {key === 'threads' && (
              <>
                <input
                  value={advancedThreads}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    if (raw === 'auto') {
                      onChange({ ...config, threads: 0 });
                    } else if (raw === '') {
                      onChange({ ...config, threads: 0 });
                    } else {
                      onChange({ ...config, threads: Number(raw) });
                    }
                  }}
                />
                <div className="field-hint">{t('advanced.threadsHint')}</div>
              </>
            )}
            {key === 'batch_size' && (
              <>
                <input
                  value={advancedBatchSize}
                  onChange={(event) => {
                    const raw = event.currentTarget.value;
                    if (raw === 'auto') {
                      onChange({ ...config, batch_size: 0 });
                    } else if (raw === '') {
                      onChange({ ...config, batch_size: 0 });
                    } else {
                      onChange({ ...config, batch_size: Number(raw) });
                    }
                  }}
                />
                <div className="field-hint">{t('advanced.batchHint')}</div>
              </>
            )}
            {key === 'temp' && (
              <input
                type="number"
                step="0.05"
                value={config.temp}
                onChange={(event) =>
                  onChange({ ...config, temp: Number(event.currentTarget.value || 0) })
                }
              />
            )}
            {key === 'flash_attn' && (
              <select
                value={config.flash_attn}
                onChange={(event) => onChange({ ...config, flash_attn: event.currentTarget.value })}
              >
                <option value="auto">auto</option>
                <option value="on">on</option>
                <option value="off">off</option>
              </select>
            )}
            {key === 'mmap' && (
              <label>
                <input
                  type="checkbox"
                  checked={config.mmap}
                  onChange={(event) => onChange({ ...config, mmap: event.currentTarget.checked })}
                />
                mmap
              </label>
            )}
            {key === 'mlock' && (
              <label>
                <input
                  type="checkbox"
                  checked={config.mlock}
                  onChange={(event) => onChange({ ...config, mlock: event.currentTarget.checked })}
                />
                mlock
              </label>
            )}
          </div>
        );
      })}
      {groupExtraArgs(config.extra_args).map((group) => (
        <ExtraArgRow
          key={group.start}
          text={group.text}
          onCommit={(value) => onUpdateExtraArg(group.start, value)}
          onRemove={() => onRemoveExtraArg(group.start)}
        />
      ))}
      <div className="empty">{t('advanced.empty')}</div>
      <div className="panel-actions">
        <Button variant="danger" type="button" onClick={() => setShowClearDialog(true)}>
          {t('advanced.clear')}
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving ? t('common.saving') : t('config.save')}
        </Button>
      </div>
      <ConfirmDialog
        open={showClearDialog}
        title={t('advanced.clearTitle')}
        danger
        confirmText={t('advanced.clearConfirm')}
        message={t('advanced.clearMessage')}
        onConfirm={() => {
          onClearAdvanced();
          setShowClearDialog(false);
        }}
        onCancel={() => setShowClearDialog(false)}
      />
    </div>
  );
}
