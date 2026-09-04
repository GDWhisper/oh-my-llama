import { useState } from 'react';
import { useI18n } from '../i18n';
import { TruncatedText } from './TruncatedText';
import { useDropdownSearch } from '../hooks/useDropdownSearch';

interface Props {
  // 检测到的 .gguf 模型文件名列表（不含绝对路径，仅用于下拉框展示）
  models: string[];
  // 当前选中的模型 basename（可能为空）
  value: string;
  // 未选择模型目录时为 true，下拉框禁用
  disabled: boolean;
  onSelect: (name: string) => void;
}

// 可搜索的模型选择器：替代原生 <select>（原生不支持内置搜索）。
// 复用项目既有的 .select-box / .select-list / .select-option 样式与交互，
// 搜索框、点击外部关闭、空间自适应展开方向、回车选中等共用行为见 useDropdownSearch。
// 纯展示组件：模型列表来自 props，选择通过 onSelect 回传，不在此实现任何文件读写（严守分层）。
export function ModelSelect({ models, value, disabled, onSelect }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const choose = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  const {
    query,
    setQuery,
    filtered,
    dropUp,
    boxRef,
    triggerRef,
    listRef,
    searchRef,
    onSearchKeyDown,
  } = useDropdownSearch({
    open,
    items: models,
    getLabel: (name) => name,
    onClose: () => setOpen(false),
    onSelectFirst: choose,
    selectedKey: value,
  });

  const triggerLabel = !value
    ? models.length > 0
      ? t('basic.selectModelPlaceholder')
      : t('basic.noModels')
    : value;

  return (
    <div className="select-box model-select-box" ref={boxRef}>
      <button
        type="button"
        className="select-trigger"
        disabled={disabled}
        ref={triggerRef}
        onClick={() => {
          if (!disabled) {
            setOpen((visible) => !visible);
          }
        }}
      >
        <span className="select-value">
          <TruncatedText text={disabled ? t('basic.pickDirFirst') : triggerLabel} />
        </span>
        <span className="select-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className={`select-list model-select-list${dropUp ? ' drop-up' : ''}`}>
          <div className="model-search">
            <input
              ref={searchRef}
              type="text"
              className="model-search-input"
              placeholder={t('basic.searchModel')}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          {models.length === 0 ? (
            <div className="model-search-empty">{t('basic.noModels')}</div>
          ) : filtered.length === 0 ? (
            <div className="model-search-empty">{t('basic.noMatch')}</div>
          ) : (
            <ul className="model-options">
              {filtered.map((name) => (
                <li key={name} className="select-option" data-dropdown-key={name}>
                  <button
                    type="button"
                    className={`option-main${value === name ? ' selected' : ''}`}
                    onClick={() => choose(name)}
                  >
                    <TruncatedText text={name} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
