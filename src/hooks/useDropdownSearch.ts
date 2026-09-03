import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';

interface Options<T> {
  // 下拉是否展开（open 状态由调用方持有）
  open: boolean;
  // 全量条目；在 hook 内按 getLabel 做大小写不敏感子串过滤
  items: T[];
  // 条目的可搜索/展示文本
  getLabel: (item: T) => string;
  // 关闭下拉（点击外部 / Escape）
  onClose: () => void;
  // 回车选中过滤后第一项
  onSelectFirst: (item: T) => void;
}

// 可搜索下拉框的共用行为：搜索框状态与过滤、打开时清空查询并聚焦、
// 点击外部关闭、列表空间自适应展开方向（向下/向上）、Enter 选中第一项 / Escape 关闭。
// 由 ModelSelect 与 ConfigManager 的「选择配置」共用，保证交互完全同款；
// 视觉复用 .model-search / .model-options 等既有样式，本 hook 不含任何样式逻辑。
export function useDropdownSearch<T>({
  open,
  items,
  getLabel,
  onClose,
  onSelectFirst,
}: Options<T>) {
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
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);

  // 打开时清空查询并聚焦搜索框（setTimeout 确保 DOM 已渲染）。
  useEffect(() => {
    if (!open) return;
    setQuery('');
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? items.filter((item) => getLabel(item).toLowerCase().includes(trimmed))
    : items;
  const matchCount = filtered.length;

  // 空间自适应：列表默认向下展开；当下方空间不足、且上方更宽裕时翻转为向上展开。
  // 在渲染后、绘制前测量（useLayoutEffect 避免闪烁）。选项行高固定（单行截断），
  // 列表高度只随条目数变化，故以 matchCount 作为内容变化的测量依赖。
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
  }, [open, matchCount]);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // 回车直接选中过滤后第一项。
      const first = filtered[0];
      if (first !== undefined) {
        onSelectFirst(first);
      }
      event.preventDefault();
    } else if (event.key === 'Escape') {
      onClose();
    }
  };

  return {
    query,
    setQuery,
    filtered,
    dropUp,
    boxRef,
    triggerRef,
    listRef,
    searchRef,
    onSearchKeyDown,
  };
}
