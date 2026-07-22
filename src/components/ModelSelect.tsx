import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useI18n } from '../i18n';

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
// 复用项目既有的 .select-box / .select-list / .select-option 样式与交互（点击外部关闭），
// 仅在列表顶部加一个搜索框，对 .gguf 文件名做大小写不敏感子串过滤。
// 纯展示组件：模型列表来自 props，选择通过 onSelect 回传，不在此实现任何文件读写（严守分层）。
export function ModelSelect({ models, value, disabled, onSelect }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 下拉列表展开方向：默认向下；空间不足时翻转为向上（由 useLayoutEffect 计算）。
  const [dropUp, setDropUp] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // 点击下拉框外部时收起列表。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 打开时清空查询并聚焦搜索框（setTimeout 确保 DOM 已渲染）。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // 空间自适应：列表默认向下展开；当下方空间不足、且上方更宽裕时翻转为向上展开。
  // 在渲染后、绘制前测量（useLayoutEffect 避免闪烁）；列表高度随搜索过滤变化也会重新决策。
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !listRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const listHeight = listRef.current.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    let up = false;
    if (listHeight <= spaceBelow) {
      up = false; // 下方放得下，优先向下
    } else if (listHeight <= spaceAbove) {
      up = true; // 下方放不下但上方放得下
    } else {
      up = spaceAbove > spaceBelow; // 两边都放不下，选更宽裕的一侧
    }
    setDropUp(up);
  }, [open, models, query]);

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? models.filter((name) => name.toLowerCase().includes(trimmed)) : models;

  const triggerLabel = !value
    ? models.length > 0
      ? t('basic.selectModelPlaceholder')
      : t('basic.noModels')
    : value;

  const choose = (name: string) => {
    onSelect(name);
    setOpen(false);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // 回车直接选中过滤后第一项。
      if (filtered.length > 0) {
        choose(filtered[0]);
      }
      event.preventDefault();
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

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
        <span className="select-value">{disabled ? t('basic.pickDirFirst') : triggerLabel}</span>
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
                <li key={name} className="select-option">
                  <button
                    type="button"
                    className={`option-main${value === name ? ' selected' : ''}`}
                    onClick={() => choose(name)}
                  >
                    {name}
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
