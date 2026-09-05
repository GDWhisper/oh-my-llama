import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LogLine } from '../hooks/useServer';
import { useI18n } from '../i18n';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../types';
import { Button } from './Button';

type LogMode = 'brief' | 'raw';

interface Props {
  logs: LogLine[];
  onClear: () => void;
}

// 距底多少像素以内仍视为“停在底部”。留一点冗余以容忍流式输出时一两行的抖动。
const BOTTOM_THRESHOLD = 32;

// 渲染窗口大小：满载 5000 行 × 每行 4 节点 ≈ 2 万 DOM 节点，每次批量 flush 都对全表做
// reconciliation 开销大。默认只渲染尾部 N 行（流式场景用户只关心最新输出），
// 向上翻历史时点顶部「加载更早日志」按批扩窗——不引入虚拟滚动依赖。
const INITIAL_VISIBLE_LOGS = 800;
const LOAD_OLDER_STEP = 800;

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
  // 是否显示时间戳：默认显示（与旧 settings.json 缺字段时的观感保持一致），
  // 挂载时从后端 AppSettings 校准一次；None → true。toggle 走乐观更新 + 后端落盘校验。
  const [showTimes, setShowTimes] = useState(true);

  // 挂载时读一次设置，校准时间显隐。读不到或字段为 null 均按"显示"处理（向后兼容）。
  useEffect(() => {
    let alive = true;
    invoke<AppSettings>('read_settings')
      .then((s) => {
        if (!alive) return;
        setShowTimes(s.show_log_times ?? true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 切换时间显示：乐观更新本地态让按钮即时反馈；后端 set_log_show_times 落盘（与
  // set_close_pref 同款读-改-写命令），失败则回滚到旧值并 console.error。
  const toggleTimes = useCallback(() => {
    setShowTimes((prev) => {
      const next = !prev;
      invoke<AppSettings>('set_log_show_times', { show: next })
        .then((s) => setShowTimes(s.show_log_times ?? true))
        .catch((err) => {
          console.error(err);
          setShowTimes(prev);
        });
      return next;
    });
  }, []);

  const termRef = useRef<HTMLDivElement>(null);
  // 是否处于“锁定底部”跟随状态：用 ref 镜像，避免 effect 里读到过期闭包。
  const stickRef = useRef(true);
  // 用户是否正在按住拖动滚动条：拖动期间暂停自动置底，避免与用户操作打架。
  const holdingRef = useRef(false);
  const [showJump, setShowJump] = useState(false);
  // 渲染窗口：只渲染可见过滤结果的尾部 N 行，向上翻历史时逐步扩窗。
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_LOGS);
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
    // 优先复用已绑定的滚动容器：findScroller 沿父链逐个 getComputedStyle 属强制样式计算，
    // 每次 flush 都重找不值得；仅当缓存失效（如滚动容器随内容增长发生切换）时重新查找。
    const cached = boundScrollerRef.current;
    const scroller = cached && isScroller(cached) ? cached : findScroller(termRef.current);
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

  // 原生模式 = 完整日志：命令行(cmd)、子进程原样输出(raw)、应用结构化消息(info/warn/error)
  // 全部展示（用户要求原生日志可见所有命令与输出）。
  // 简要模式 = 仅应用结构化消息，排除原生透传(raw)与命令行(cmd)，保持简洁。
  const visible =
    mode === 'raw' ? logs : logs.filter((line) => line.level !== 'raw' && line.level !== 'cmd');
  // 渲染窗口：只渲染尾部 visibleCount 行；仍有更早日志时顶部给出扩窗按钮。
  const hasOlder = visible.length > visibleCount;
  const windowed = hasOlder ? visible.slice(-visibleCount) : visible;
  const loadOlder = () => setVisibleCount((count) => count + LOAD_OLDER_STEP);

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
          {/* 时间显隐开关：图标态（时钟 SVG）配 active/默认色与左侧 seg 同族；
              关闭时不渲染 .term-ts，那部分列宽由 .term-text { flex: 1 1 0 } 自动撑满。
              aria-pressed 让屏幕阅读器播报当前状态。 */}
          <button
            type="button"
            className={showTimes ? 'log-time-toggle active' : 'log-time-toggle'}
            onClick={toggleTimes}
            aria-pressed={showTimes}
            title={showTimes ? t('log.hideTime') : t('log.showTime')}
            aria-label={showTimes ? t('log.hideTime') : t('log.showTime')}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M8 4.5V8l2.5 1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
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
          {hasOlder && (
            <button type="button" className="term-older" onClick={loadOlder}>
              {t('log.loadOlder')}
            </button>
          )}
          {windowed.map((line) => (
            <div className={`term-line ${line.level}`} key={line.id}>
              {showTimes && <span className="term-ts">{line.ts}</span>}
              <span className="term-level">[{line.level}]</span>
              <span className="term-text">{line.text}</span>
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
