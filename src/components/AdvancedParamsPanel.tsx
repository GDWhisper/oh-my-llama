import { useState } from 'react';
import type { ServerConfig } from '../types';
import { ADVANCED_LABELS, type AdvancedKey, type AdvancedOption } from '../lib/advanced';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  config: ServerConfig;
  addingAdvanced: boolean;
  removingAdvanced: boolean;
  availableAdvancedOptions: AdvancedOption[];
  enabledAdvancedKeys: AdvancedKey[];
  advancedFlashAttn: string;
  advancedThreads: string;
  advancedBatchSize: string;
  advancedPredict: string;
  onToggleAdd: () => void;
  onStartRemove: () => void;
  onStopRemove: () => void;
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
    addingAdvanced,
    removingAdvanced,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    onToggleAdd,
    onStartRemove,
    onStopRemove,
    onAddKey,
    onRemoveKey,
    onClearAdvanced,
    saving,
    onSave,
    onChange,
  } = props;
  // 清空高级参数需二次确认：点击「清空参数」弹出确认弹窗，确认后才执行。
  const [showClearDialog, setShowClearDialog] = useState(false);

  return (
    <div className="panel">
      <div className="section-header">
        <h2>高级参数</h2>
        <div className="actions">
          <Button
            variant={addingAdvanced ? 'secondary-active' : 'secondary'}
            type="button"
            onClick={onToggleAdd}
          >
            {addingAdvanced ? '关闭添加' : '添加参数'}
          </Button>
          <Button
            variant={removingAdvanced ? 'secondary-danger' : 'secondary'}
            type="button"
            onClick={removingAdvanced ? onStopRemove : onStartRemove}
          >
            {removingAdvanced ? '退出移除' : '移除参数'}
          </Button>
        </div>
      </div>
      {addingAdvanced && availableAdvancedOptions.length > 0 && (
        <div className="advanced-chooser">
          {availableAdvancedOptions.map((option) => (
            <button
              key={option.key}
              className="chip"
              type="button"
              onClick={() => onAddKey(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {enabledAdvancedKeys.map((key) => {
        const removable = removingAdvanced && key !== 'ctx_size';
        return (
          <div className="field" key={key}>
            <div className="field-header">
              <label>{ADVANCED_LABELS[key]}</label>
              {removable && (
                <Button variant="danger" type="button" onClick={() => onRemoveKey(key)}>
                  删除
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
                <div className="field-hint">输入 unlimited 表示不限制生成长度</div>
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
                  <option value="999">全部</option>
                </select>
                <div className="field-hint">
                  当前自动映射 Flash Attention 为 {advancedFlashAttn}
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
                <div className="field-hint">留空或输入 auto 时由 llama-server 自动选择</div>
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
                <div className="field-hint">留空或输入 auto 时使用默认批处理大小</div>
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
      <div className="empty">
        高级参数按需添加；未加入的参数不会写入配置，启动时由 llama-server 自动决定。
      </div>
      <div className="panel-actions">
        <Button variant="danger" type="button" onClick={() => setShowClearDialog(true)}>
          清空参数
        </Button>
        <Button onClick={onSave} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>
      <ConfirmDialog
        open={showClearDialog}
        title="清空所有高级参数"
        danger
        confirmText="确认清空"
        message="将移除全部已启用的高级参数，并把各高级值复位为默认值。此操作需点「保存配置」才会生效。"
        onConfirm={() => {
          onClearAdvanced();
          setShowClearDialog(false);
        }}
        onCancel={() => setShowClearDialog(false)}
      />
    </div>
  );
}
