import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ServerLogLine } from '../types';
import { useI18n } from '../i18n';
import { Button } from './Button';

type LogMode = 'brief' | 'raw';

interface Props {
  logs: ServerLogLine[];
  onClear: () => void;
}

// 距底多少像素以内仍视为“停在底部”。留一点冗余以容忍流式输出时一两行的抖动。
const BOTTOM_THRESHOLD = 32;

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

export function LogPanel({ logs, onClear }: Props) {
  const { t } = useI18n();
  const [mode, setMode] = useState<LogMode>('raw');

  const termRef = useRef<HTMLDivElement>(null);
  // 是否处于“锁定底部”跟随状态：用 ref 镜像，避免 effect 里读到过期闭包。
  const stickRef = useRef(true);
  // 用户是否正在按住拖动滚动条：拖动期间暂停自动置底，避免与用户操作打架。
  const holdingRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  // 当前真正承载滚动的容器（可能是 .terminal 自身，也可能是外层 .column.main/日志列）。
  const boundScrollerRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // 把某容器滚到底（程序化置底）。stick 为真时由布局副作用调用，跟随最新输出。
  const pinToBottom = (scroller: HTMLElement) => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  // 为“当前滚动容器”绑定监听。scroll 用于回到底部后重新锁定；wheel 用于用户向上滚时
  // 立即解除锁定（否则下一条日志会把用户又拽回底部）；pointer 用于识别拖拽滚动条的手动操作。
  const bindScroller = (scroller: HTMLElement) => {
    const onScroll = () => {
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const atBottom = distance <= BOTTOM_THRESHOLD;
      stickRef.current = atBottom;
      setShowJump(!atBottom);
    };
    const onWheel = (event: WheelEvent) => {
      // 向上滚（deltaY<0）是明确的“离开底部去查阅历史”意图：立即解锁，抢在下一次置底之前。
      if (event.deltaY < 0) {
        stickRef.current = false;
        setShowJump(true);
      }
    };
    const onPointerDown = () => {
      holdingRef.current = true;
    };
    const onPointerUp = () => {
      holdingRef.current = false;
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('pointerdown', onPointerDown, { passive: true });
    // 指针可能在容器外释放（拖拽滚动条时），监听挂到 window 才不漏掉抬起。
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
    cleanupRef.current = () => {
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  };

  // 用 useLayoutEffect：在浏览器绘制前同步置底，使随后派发的 scroll 事件读到一致的最新
  // scrollTop/scrollHeight，消除“流式快速追加时被误判为用户上滚而解锁”的竞态。
  // mode 纳入依赖：切换 简要/原生 内容大变时，若仍处锁定态则重新贴底。
  useLayoutEffect(() => {
    const scroller = findScroller(termRef.current);
    if (!scroller) return;
    // 滚动容器可能从 terminal 切到外层列（内容增长时），切换时重新绑定监听。
    if (boundScrollerRef.current !== scroller) {
      cleanupRef.current?.();
      bindScroller(scroller);
      boundScrollerRef.current = scroller;
    }
    // 仅当用户停在底部、且没有正在拖拽时才自动置底，避免打断向上查阅历史。
    if (stickRef.current && !holdingRef.current) {
      pinToBottom(scroller);
      setShowJump(false);
    }
  }, [logs, mode]);

  // 卸载时解绑，避免监听泄漏。
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const jumpToBottom = () => {
    const scroller = findScroller(termRef.current);
    if (!scroller) return;
    stickRef.current = true;
    pinToBottom(scroller);
    setShowJump(false);
  };

  // 简要：只显示结构化级别（info/warn/error），排除原生透传行(raw)与命令行(cmd)。
  // 原生：下方滚动区透传 llama-server 的原样输出(raw)；启动命令行改由「原始参数」卡片展示。
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
      {/* 不滚动的视口包裹层：承载 terminal（滚动区）与悬浮的“回到底部”按钮。
          按钮放在这一层而非 terminal 内部，才能始终固定在右下角、不随内容滚走。 */}
      <div className="terminal-viewport">
        <div className="terminal" ref={termRef}>
          {visible.length === 0 && <div className="terminal-empty">{t('log.empty')}</div>}
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
        </div>
        {showJump && (
          <button type="button" className="term-jump" onClick={jumpToBottom}>
            {t('log.backToBottom')}
          </button>
        )}
      </div>
    </div>
  );
}
