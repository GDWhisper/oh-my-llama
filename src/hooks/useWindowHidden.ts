import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listenGuarded } from '../lib/listenGuarded';

/**
 * 窗口是否处于「用户看不见」的状态（关闭到托盘 / 启动即隐藏到托盘 / 最小化 / 切走）。
 *
 * 两类真源合并 + 一次初始对齐，缺一不可：
 * - 后端 `window://visible`：`window.hide()` 之后 WebView2 **不会**把页面置为
 *   `document.visibilityState === "hidden"`（2026-09-17 在已安装的 v0.2.4 上实测：
 *   托盘常驻时前端仍按 1.5s 满频刷新系统指标，两处「隐藏降频 8s」分支从未生效，
 *   空闲仍占 ~7% 单核）。故托盘隐藏只能由后端作为真源广播。
 * - 挂载时实查 `get_main_window_visible`：启动即「隐藏到托盘」时，hide() 的广播
 *   早于本监听建立、必然丢失，只有主动问一次才有初始状态；已收到过事件则以事件
 *   为准，防迟到的查询结果把新状态回拨。
 * - `document.visibilityState`：覆盖最小化、切到其它虚拟桌面等后端不发事件的路径。
 *
 * 供 `MetricsPanel`（不可见即停表）与 `useServer`（不可见才降频）共用，避免各判一份
 * 而互相漂移。
 */
export function useWindowHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // 两个真源各自记录，任一为「不可见」即判定不可见——避免后到的一方把状态覆盖掉。
    let docHidden = document.visibilityState === 'hidden';
    let backendHidden = false;
    // 是否收到过后端事件：收到过就丢弃挂载实查的旧结果（查询期间窗口可能已被还原）。
    let eventSeen = false;
    const apply = () => setHidden(docHidden || backendHidden);

    const onVisibility = () => {
      docHidden = document.visibilityState === 'hidden';
      apply();
    };
    document.addEventListener('visibilitychange', onVisibility);

    listenGuarded<boolean>(
      'window://visible',
      (visible) => {
        eventSeen = true;
        backendHidden = !visible;
        apply();
      },
      () => disposed,
    ).then((un) => {
      unlisten = un;
    });

    // 启动即隐藏到托盘：hide() 的广播发生在前端监听建立之前，必然收不到；
    // 挂载时主动对齐一次后端实况（失败不处理：按「可见」保守对待，维持正常刷新）。
    invoke<boolean>('get_main_window_visible')
      .then((visible) => {
        if (!disposed && !eventSeen) {
          backendHidden = !visible;
          apply();
        }
      })
      .catch(() => {});

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      unlisten?.();
    };
  }, []);

  return hidden;
}
