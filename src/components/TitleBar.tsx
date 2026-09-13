import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useI18n } from '../i18n';

/** 最大化时拖拽位移阈值（px）：单击不动不还原，超过才开始拖 */
const DRAG_THRESHOLD_PX = 6;

/**
 * 自定义标题栏：与主界面同一套暖纸 token。
 * 不用 data-tauri-drag-region：其 mousedown 即 startDragging，
 * 在最大化窗口上会被系统当成拖拽而立刻还原（单击空白变小）。
 * 一律先武装位移，超过阈值才 startDragging：
 * - 最大化：单击不动不还原
 * - 未聚焦时从其它窗口点进来：该次 mousedown 只做激活，位移为 0，不拖走窗口
 * 用 Pointer Capture：贴近条下沿按下后划出标题栏仍能完成拖拽（不用 mouseleave 解除武装）。
 * 双击空白自行 toggleMaximize（避免与原生区域叠两次）。
 * 关闭仍走后端 CloseRequested（托盘/退出分流不变）。
 */
export function TitleBar() {
  const { t } = useI18n();
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);
  const dragArmed = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    win
      .onResized(async () => {
        try {
          const m = await win.isMaximized();
          if (!disposed) setMaximized(m);
        } catch {
          // 窗口已销毁时忽略
        }
      })
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      });
    win
      .isMaximized()
      .then((m) => {
        if (!disposed) setMaximized(m);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [win]);

  const isControl = (target: EventTarget | null): boolean =>
    target instanceof Element && !!target.closest('.titlebar-btn');

  const onDragPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // PointerEvent.detail 在 pointerdown 上常为 0（不是 Mouse 的 1），不能用 detail 过滤
    if (e.button !== 0) return;
    if (isControl(e.target)) return;
    dragArmed.current = { x: e.screenX, y: e.screenY };
    // 捕获后 pointermove/up 仍指向标题栏，划出 36px 条也不会中断拖拽判定
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 捕获失败则退回元素内事件，仍可用
    }
  };

  const onDragPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const armed = dragArmed.current;
    if (!armed) return;
    // 按键已松开时忽略，避免捕获异常导致“无按键仍在武装”
    if ((e.buttons & 1) === 0) {
      dragArmed.current = null;
      return;
    }
    if (
      Math.abs(e.screenX - armed.x) < DRAG_THRESHOLD_PX &&
      Math.abs(e.screenY - armed.y) < DRAG_THRESHOLD_PX
    ) {
      return;
    }
    dragArmed.current = null;
    void win.startDragging();
  };

  const onDragPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragArmed.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // 未捕获时忽略
    }
  };

  const onDragDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (isControl(e.target)) return;
    void win.toggleMaximize();
  };

  return (
    <div
      className="titlebar"
      onPointerDown={onDragPointerDown}
      onPointerMove={onDragPointerMove}
      onPointerUp={onDragPointerUp}
      onPointerCancel={onDragPointerUp}
      onDoubleClick={onDragDoubleClick}
    >
      <div className="titlebar-brand">
        <span className="titlebar-mark" aria-hidden="true">
          OML
        </span>
        <span className="titlebar-title">Oh My Llama</span>
      </div>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          aria-label={t('titlebar.minimize')}
          title={t('titlebar.minimize')}
          onClick={() => void win.minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1 5h8" stroke="currentColor" strokeWidth="1.2" fill="none" />
          </svg>
        </button>
        <button
          type="button"
          className="titlebar-btn"
          aria-label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
          title={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="2.5"
                y="0.5"
                width="7"
                height="7"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="none"
              />
              <rect
                x="0.5"
                y="2.5"
                width="7"
                height="7"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="none"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="1"
                y="1"
                width="8"
                height="8"
                stroke="currentColor"
                strokeWidth="1.1"
                fill="none"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-btn-close"
          aria-label={t('titlebar.close')}
          title={t('titlebar.close')}
          onClick={() => void win.close()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
