import { useEffect, useMemo, useState } from 'react';
import type { ParamSpec, ServerConfig } from '../types';
import { ADVANCED_LABEL_KEYS, type AdvancedKey, type AdvancedOption } from '../lib/advanced';
import { groupExtraArgs } from '../lib/parseArgs';
import { useI18n } from '../i18n';
import type { MessageKey, Translator } from '../i18n/messages';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

// 结构化参数的显示名：优先取 i18n 的 advanced.structured.<key>，
// 缺文案时（如注册表新加了参数还没配翻译）回退到 flag，绝不显示裸 key。
function structuredLabel(t: Translator, spec: ParamSpec): string {
  const key = `advanced.structured.${spec.key}` as MessageKey;
  const label = t(key);
  return label === key ? spec.flag : label;
}

// 「可添加参数」搜索结果一次最多渲染的条目数：注册表有 160+ 项，
// 全量铺开会淹没面板，超出部分提示用户继续输入缩小范围。
const MAX_SUGGESTIONS = 24;

// 自定义参数行的归属列表：'enabled' = 启用（写入启动命令行），'disabled' = 临时禁用（保留文本不写入）。
export type ExtraArgList = 'enabled' | 'disabled';

// 单条「自定义参数」的可编辑行。用本地草稿承接输入、失焦时才提交，
// 避免「受控输入 + 每次按键重新分词归一化」导致的光标跳动 / 尾随空格被吞。
// 当外部文本变化（如切换配置、提交后归一化）时通过 effect 同步草稿。
// disabled 行整体置灰，按钮用于「启用 / 禁用」切换。
function ExtraArgRow({
  text,
  disabled,
  onCommit,
  onRemove,
  onToggle,
}: {
  text: string;
  disabled: boolean;
  onCommit: (value: string) => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(text);
  useEffect(() => {
    setDraft(text);
  }, [text]);
  return (
    <div className={`field extra-args${disabled ? ' disabled' : ''}`}>
      <div className="field-header">
        <label>{t('advanced.customParam')}</label>
        <div className="field-actions">
          {disabled && <span className="disabled-badge">{t('advanced.disabled')}</span>}
          <Button variant="secondary" type="button" onClick={onToggle}>
            {disabled ? t('advanced.enable') : t('advanced.disable')}
          </Button>
          <Button variant="danger" type="button" onClick={onRemove}>
            {t('common.delete')}
          </Button>
        </div>
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

// 单条「结构化高级参数」卡片：完全由注册表声明（type/choices/min/max）驱动渲染，
// 因此一套组件即可覆盖注册表里的全部官方参数——新增参数无需再写一段 UI。
// 文本 / 数值走「草稿 + 失焦提交」，避免逐字回写导致光标跳动与整树重渲染；
// 布尔 / 枚举语义离散，即时提交。
function StructuredParamRow({
  spec,
  value,
  disabled,
  removable,
  onCommit,
  onRemove,
  onToggle,
}: {
  spec: ParamSpec;
  value: string;
  disabled: boolean;
  removable: boolean;
  onCommit: (value: string) => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const label = structuredLabel(t, spec);
  const isBool = spec.type === 'bool';
  const commitDraft = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };

  return (
    <div className={`field${disabled ? ' disabled' : ''}`}>
      <div className="field-header">
        {isBool ? (
          <label className="bool-field">
            {label}
            <input
              type="checkbox"
              checked={value === 'true'}
              onChange={(event) => onCommit(event.currentTarget.checked ? 'true' : 'false')}
            />
          </label>
        ) : (
          <label>{label}</label>
        )}
        <div className="field-actions">
          {disabled && <span className="disabled-badge">{t('advanced.disabled')}</span>}
          <Button variant="secondary" type="button" onClick={onToggle}>
            {disabled ? t('advanced.enable') : t('advanced.disable')}
          </Button>
          {removable && (
            <Button variant="danger" type="button" onClick={onRemove}>
              {t('common.delete')}
            </Button>
          )}
        </div>
      </div>
      {spec.type === 'enum' && (
        <select value={value} onChange={(event) => onCommit(event.currentTarget.value)}>
          {(spec.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
      {(spec.type === 'int' || spec.type === 'float') && (
        <input
          type="number"
          step={spec.type === 'float' ? '0.01' : '1'}
          min={spec.min}
          max={spec.max}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitDraft}
        />
      )}
      {spec.type === 'str' && (
        <input
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commitDraft}
        />
      )}
      <div className="field-hint">{spec.flag}</div>
    </div>
  );
}

interface Props {
  config: ServerConfig;
  adjustingAdvanced: boolean;
  availableAdvancedOptions: AdvancedOption[];
  enabledAdvancedKeys: AdvancedKey[];
  disabledAdvancedKeys: Record<AdvancedKey, boolean>;
  advancedFlashAttn: string;
  advancedThreads: string;
  advancedBatchSize: string;
  advancedPredict: string;
  onRemoveExtraArg: (list: ExtraArgList, start: number) => void;
  onUpdateExtraArg: (list: ExtraArgList, start: number, text: string) => void;
  onToggleAdjust: () => void;
  onAddKey: (key: AdvancedKey) => void;
  onRemoveKey: (key: AdvancedKey) => void;
  onToggleDisableKey: (key: AdvancedKey) => void;
  onToggleExtraArg: (list: ExtraArgList, start: number) => void;
  onClearAdvanced: () => void;
  onChange: (config: ServerConfig) => void;
  // 结构化高级参数（数据驱动）：注册表 + 四个通用操作，覆盖全部官方参数。
  registry: ParamSpec[];
  onAddStructuredKey: (key: string) => void;
  onRemoveStructuredKey: (key: string) => void;
  onStructuredValueChange: (key: string, value: string) => void;
  onToggleDisableStructuredKey: (key: string) => void;
}

export function AdvancedParamsPanel(props: Props) {
  const {
    config,
    adjustingAdvanced,
    availableAdvancedOptions,
    enabledAdvancedKeys,
    disabledAdvancedKeys,
    advancedFlashAttn,
    advancedThreads,
    advancedBatchSize,
    advancedPredict,
    onRemoveExtraArg,
    onUpdateExtraArg,
    onToggleAdjust,
    onAddKey,
    onRemoveKey,
    onToggleDisableKey,
    onToggleExtraArg,
    onClearAdvanced,
    onChange,
    registry,
    onAddStructuredKey,
    onRemoveStructuredKey,
    onStructuredValueChange,
    onToggleDisableStructuredKey,
  } = props;
  const { t } = useI18n();
  // 清空高级参数需二次确认：点击「清空参数」弹出确认弹窗，确认后才执行。
  const [showClearDialog, setShowClearDialog] = useState(false);
  // 「可添加的官方参数」搜索词：注册表 160+ 项无法平铺，靠搜索定位。
  const [paramQuery, setParamQuery] = useState('');

  const specByKey = useMemo(() => new Map(registry.map((spec) => [spec.key, spec])), [registry]);
  const enabledStructured = useMemo(
    () => new Set(config.enabled_structured_params),
    [config.enabled_structured_params],
  );
  const disabledStructured = useMemo(
    () => new Set(config.disabled_structured_params),
    [config.disabled_structured_params],
  );

  // 候选项 = 注册表里尚未启用的参数，按「显示名 / key / flag」模糊匹配。
  const suggestions = useMemo(() => {
    const query = paramQuery.trim().toLowerCase();
    const pool = registry.filter((spec) => !enabledStructured.has(spec.key));
    if (!query) {
      return pool.slice(0, MAX_SUGGESTIONS);
    }
    return pool.filter(
      (spec) =>
        spec.key.includes(query) ||
        spec.flag.toLowerCase().includes(query) ||
        structuredLabel(t, spec).toLowerCase().includes(query),
    );
  }, [registry, enabledStructured, paramQuery, t]);

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
      {adjustingAdvanced && registry.length > 0 && (
        <div className="structured-chooser">
          <input
            className="structured-search"
            value={paramQuery}
            spellCheck={false}
            placeholder={t('advanced.searchPlaceholder')}
            onChange={(event) => setParamQuery(event.currentTarget.value)}
          />
          {suggestions.length === 0 ? (
            <div className="empty">{t('advanced.searchNoMatch')}</div>
          ) : (
            <div className="advanced-chooser">
              {suggestions.slice(0, MAX_SUGGESTIONS).map((spec) => (
                <button
                  key={spec.key}
                  className="chip"
                  type="button"
                  title={spec.flag}
                  onClick={() => {
                    onAddStructuredKey(spec.key);
                    setParamQuery('');
                  }}
                >
                  {structuredLabel(t, spec)}
                </button>
              ))}
            </div>
          )}
          {suggestions.length > MAX_SUGGESTIONS && (
            <div className="field-hint">
              {t('advanced.searchMore', { count: suggestions.length - MAX_SUGGESTIONS })}
            </div>
          )}
        </div>
      )}
      {enabledAdvancedKeys.map((key) => {
        const removable = adjustingAdvanced && key !== 'ctx_size';
        const isBool = key === 'mmap' || key === 'mlock';
        const isDisabled = disabledAdvancedKeys[key];
        return (
          <div className={`field${isDisabled ? ' disabled' : ''}`} key={key}>
            <div className="field-header">
              {isBool ? (
                <label className="bool-field">
                  {t(ADVANCED_LABEL_KEYS[key])}
                  <input
                    type="checkbox"
                    checked={key === 'mmap' ? config.mmap : config.mlock}
                    onChange={
                      key === 'mmap'
                        ? (event) => onChange({ ...config, mmap: event.currentTarget.checked })
                        : (event) => onChange({ ...config, mlock: event.currentTarget.checked })
                    }
                  />
                </label>
              ) : (
                <label>{t(ADVANCED_LABEL_KEYS[key])}</label>
              )}
              <div className="field-actions">
                {isDisabled && <span className="disabled-badge">{t('advanced.disabled')}</span>}
                {key !== 'ctx_size' && (
                  <Button variant="secondary" type="button" onClick={() => onToggleDisableKey(key)}>
                    {isDisabled ? t('advanced.enable') : t('advanced.disable')}
                  </Button>
                )}
                {removable && (
                  <Button variant="danger" type="button" onClick={() => onRemoveKey(key)}>
                    {t('common.delete')}
                  </Button>
                )}
              </div>
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
          </div>
        );
      })}
      {config.enabled_structured_params.map((key) => {
        const spec = specByKey.get(key);
        if (!spec) return null;
        return (
          <StructuredParamRow
            key={`structured-${key}`}
            spec={spec}
            value={config.structured_params[key] ?? spec.default}
            disabled={disabledStructured.has(key)}
            removable={adjustingAdvanced}
            onCommit={(value) => onStructuredValueChange(key, value)}
            onRemove={() => onRemoveStructuredKey(key)}
            onToggle={() => onToggleDisableStructuredKey(key)}
          />
        );
      })}
      {groupExtraArgs(config.extra_args).map((group) => (
        <ExtraArgRow
          key={`enabled-${group.start}`}
          text={group.text}
          disabled={false}
          onCommit={(value) => onUpdateExtraArg('enabled', group.start, value)}
          onRemove={() => onRemoveExtraArg('enabled', group.start)}
          onToggle={() => onToggleExtraArg('enabled', group.start)}
        />
      ))}
      {groupExtraArgs(config.disabled_extra_args).map((group) => (
        <ExtraArgRow
          key={`disabled-${group.start}`}
          text={group.text}
          disabled
          onCommit={(value) => onUpdateExtraArg('disabled', group.start, value)}
          onRemove={() => onRemoveExtraArg('disabled', group.start)}
          onToggle={() => onToggleExtraArg('disabled', group.start)}
        />
      ))}
      <div className="empty">{t('advanced.empty')}</div>
      <div className="panel-actions">
        <Button variant="danger" type="button" onClick={() => setShowClearDialog(true)}>
          {t('advanced.clear')}
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
