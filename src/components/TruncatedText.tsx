import { useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  // 需要展示（并在溢出时提示）的完整文本。
  text: string;
  // 透传给内层 span 的样式类（用于承接既有主题色等）。
  className?: string;
}

interface TooltipState {
  // true 表示悬浮提示显示在目标上方（下方空间不足时）。
  above: boolean;
  left: number;
  // 视口坐标系：below 时为 top，above 时为 bottom。
  edge: number;
}

// 文本溢出省略号展示；hover 且仅当文本实际被截断（未完全显示）时，
// 在视口内渲染一处悬浮提示，内容为完整文本。
// - 提示通过 Portal 挂到 body，避免被下拉列表的 overflow 裁剪；
// - 通过 scrollWidth/clientWidth 判断真实溢出，短文本 hover 不弹窗；
// - 纯展示组件，无业务副作用，不依赖任何外部 UI 库。
export function TruncatedText({ text, className }: Props) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const maxWidth = 360;

  const handleEnter = () => {
    const el = ref.current;
    if (!el) return;
    // +1 容差：避免亚像素四舍五入导致的误判。
    if (el.scrollWidth > el.clientWidth + 1) {
      const rect = el.getBoundingClientRect();
      const left = Math.min(rect.left, window.innerWidth - maxWidth - 16);
      // 下方放得下就放在下方，否则翻到上方。
      const belowTop = rect.bottom + 8;
      if (belowTop + 40 <= window.innerHeight) {
        setTooltip({ above: false, left, edge: belowTop });
      } else {
        setTooltip({ above: true, left, edge: window.innerHeight - rect.top + 8 });
      }
    }
  };

  const handleLeave = () => setTooltip(null);

  const style: CSSProperties = {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };

  let tooltipStyle: CSSProperties | null = null;
  if (tooltip) {
    tooltipStyle = {
      position: 'fixed',
      left: Math.max(8, tooltip.left),
      maxWidth,
    };
    if (tooltip.above) {
      tooltipStyle.bottom = tooltip.edge;
    } else {
      tooltipStyle.top = tooltip.edge;
    }
  }

  return (
    <>
      <span
        ref={ref}
        className={className}
        style={style}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {text}
      </span>
      {tooltip &&
        tooltipStyle &&
        createPortal(
          <div className="option-tooltip" style={tooltipStyle}>
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
