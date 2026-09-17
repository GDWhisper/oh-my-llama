import { listen } from '@tauri-apps/api/event';

// listen 封装：注册成功后若组件已卸载（disposed）则立即取消监听。
// 背景：React StrictMode 开发模式会 mount→unmount→再 mount。effect 的 async IIFE 里
// `await listen(...)` 可能在 cleanup 执行之后才 resolve——cleanup 时 unlisten 尚未赋值、
// 监听注册成功后若无人复查 disposed，残留 listener 会一直存活，导致同一条事件被处理
// 两次（症状：日志面板每行双份、时间戳相同）。此封装把「注册后复查 disposed」收敛到一处。
// 放在 lib 而非某个 hook 内：日志、窗口可见性等多个订阅方共用同一实现，避免各写一份
// 竞态防护后互相漂移。
export async function listenGuarded<T>(
  event: string,
  handler: (payload: T) => void,
  isDisposed: () => boolean,
): Promise<(() => void) | undefined> {
  const unlisten = await listen(event, (ev) => handler(ev.payload as T));
  if (isDisposed()) {
    unlisten();
    return undefined;
  }
  return unlisten;
}
