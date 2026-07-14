import { useEffect, useRef, useState } from 'react';
import type { ServerLogLine } from '../types';
import { useI18n } from '../i18n';
import { Button } from './Button';

type LogMode = 'brief' | 'raw';

interface Props {
  logs: ServerLogLine[];
  commandLine: string | null;
  onClear: () => void;
}

// 判断节点是否真正承载滚动（overflow 为 auto/scroll/overlay 且内容溢出）。
const isScroller = (n: HTMLElement): boolean => {
  const cs = getComputedStyle(n);
  const oy = cs.overflowY !== 'visible' ? cs.overflowY : cs.overflow;
  return (
    (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight - n.clientHeight > 1
  );
};

// 从 terminal 出发向上找到真正的滚动容器（terminal 自身或外层 .column.main/日志列）。
const findScroller = (term: HTMLElement | null): HTMLElement | null => {
  if (!term) return null;
  if (isScroller(term)) return term;
  let node: HTMLElement | null = term.parentElement;
  while (node) {
    if (isScroller(node)) return node;
    node = node.parentElement;
  }
  return term;
};

export function LogPanel({ logs, commandLine, onClear }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<LogMode>('raw');

  const termRef = useRef<HTMLDivElement>(null);
  // 用户是否停在底部：用 ref 镜像，避免 effect 里读到过期闭包。
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // 当前真正承载滚动的容器（可能是 .terminal 自身，也可能是外层 .column.main/日志列）。
  const boundScrollerRef = useRef<HTMLElement | null>(null);
  const onScrollRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const scroller = findScroller(termRef.current);
    if (!scroller) return;
    // 滚动容器可能从 terminal 切到外层列（内容增长时），切换时重新绑定监听。
    if (boundScrollerRef.current !== scroller) {
      if (boundScrollerRef.current && onScrollRef.current) {
        boundScrollerRef.current.removeEventListener('scroll', onScrollRef.current);
      }
      const onScroll = () => {
        const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        const atBottomNow = distance <= 24;
        atBottomRef.current = atBottomNow;
        setShowJump(!atBottomNow);
      };
      onScrollRef.current = onScroll;
      scroller.addEventListener('scroll', onScroll, { passive: true });
      boundScrollerRef.current = scroller;
    }
    // 仅当用户停在底部才自动置底，避免打断向上查阅历史。
    if (atBottomRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
      setShowJump(false);
    }
  }, [logs, commandLine]);

  // 卸载时解绑，避免监听泄漏。
  useEffect(() => {
    return () => {
      if (boundScrollerRef.current && onScrollRef.current) {
        boundScrollerRef.current.removeEventListener('scroll', onScrollRef.current);
      }
    };
  }, []);

  const jumpToBottom = () => {
    const scroller = findScroller(termRef.current);
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  // 简要：只显示结构化级别（info/warn/error），排除原生透传行(raw)与命令行(cmd)。
  // 原生：命令行(cmd)由 commandLine 置顶固定显示；下方滚动区透传 llama-server 的原样输出(raw)。
  const visible =
    mode === 'raw'
      ? logs.filter((line) => line.level === 'raw')
      : logs.filter((line) => line.level !== 'raw' && line.level !== 'cmd');

  return (
    <div className="panel">
      <div className="section-header">
        <h2>{t('log.title')}</h2>
        <div className="log-toolbar">
          <div className="seg" role="tablist" aria-label={t('log.modeAria')}>
            <button
              type="button"
              className={mode === 'brief' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMode('brief')}
            >
              {t('log.brief')}
            </button>
            <button
              type="button"
              className={mode === 'raw' ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMode('raw')}
            >
              {t('log.raw')}
            </button>
          </div>
          <Button variant="secondary" onClick={onClear}>
            {t('log.clear')}
          </Button>
        </div>
      </div>
      <div className="terminal" ref={termRef}>
        {mode === 'raw' && commandLine && (
          <div className="term-pinned">
            <div className="term-line cmd">
              <span className="term-text">{commandLine}</span>
            </div>
          </div>
        )}
        {visible.length === 0 && (mode !== 'raw' || !commandLine) && (
          <div className="terminal-empty">{t('log.empty')}</div>
        )}
        {visible.map((line, index) => (
          <div className={`term-line ${line.level}`} key={`${line.ts}-${index}`}>
            <span className="term-ts">{line.ts}</span>
            {mode === 'raw' ? (
              <span className="term-text">{line.text}</span>
            ) : (
              <>
                <span className="term-level">[{line.level}]</span>
                <span className="term-text">{line.text}</span>
              </>
            )}
          </div>
        ))}
        {showJump && (
          <button type="button" className="term-jump" onClick={jumpToBottom}>
            {t('log.backToBottom')}
          </button>
        )}
      </div>
    </div>
  );
}
