import { useCallback, useRef, useState } from 'react';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';

// 更新状态机（方案 A：手动检查、下载可见且可取消）。
// - idle       初始/已关闭
// - checkering 正在向更新服务器查询
// - available  发现新版本（update 可能为 null：被取消后保留版本信息、可再次下载）
// - downloading 下载中（received/total 字节，供进度条）
// - ready     下载完成，等待用户显式「重启安装」（绝不静默安装）
// - no-update 已是最新
// - error     检查/下载/安装失败
export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
      kind: 'available';
      update: Update | null;
      version: string;
      current: string;
      body?: string;
    }
  | { kind: 'downloading'; received: number; total?: number }
  | { kind: 'ready' }
  | { kind: 'no-update' }
  | { kind: 'error'; message: string };

// 保存最近一次发现的版本元信息：取消下载后仍能渲染「发现新版本」对话框，
// 用户再次点击「下载并安装」时会重新 check() 取回可用的 Update 资源。
interface FoundMeta {
  version: string;
  current: string;
  body?: string;
}

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'idle' });
  const updateRef = useRef<Update | null>(null);
  const foundRef = useRef<FoundMeta | null>(null);
  // 取消标记：download() 的 Promise 在 close() 后会 reject，
  // 借此区分「用户主动取消」与「真实错误」，避免误报。
  const cancelledRef = useRef(false);

  const check = useCallback(async () => {
    cancelledRef.current = false;
    setStatus({ kind: 'checking' });
    try {
      const u = await checkUpdate();
      if (!u) {
        setStatus({ kind: 'no-update' });
        return;
      }
      updateRef.current = u;
      const meta: FoundMeta = {
        version: u.version,
        current: u.currentVersion,
        body: u.body,
      };
      foundRef.current = meta;
      setStatus({ kind: 'available', update: u, ...meta });
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  const download = useCallback(async () => {
    let u = updateRef.current;
    if (!u) {
      u = await checkUpdate();
      if (!u) return;
      updateRef.current = u;
      const meta: FoundMeta = {
        version: u.version,
        current: u.currentVersion,
        body: u.body,
      };
      foundRef.current = meta;
      setStatus({ kind: 'available', update: u, ...meta });
    }
    cancelledRef.current = false;
    setStatus({ kind: 'downloading', received: 0, total: undefined });
    try {
      await u.download((event) => {
        setStatus((s) => {
          if (s.kind !== 'downloading') return s;
          if (event.event === 'Started') {
            return { ...s, total: event.data.contentLength };
          }
          if (event.event === 'Progress') {
            return { ...s, received: s.received + event.data.chunkLength };
          }
          return s;
        });
      });
      setStatus({ kind: 'ready' });
    } catch (err) {
      // 用户取消：close() 触发 reject，状态已由 cancel() 复位，此处静默吞掉。
      if (cancelledRef.current) return;
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // 取消下载：best-effort 中断底层 Rust 下载任务（close 释放 Update 资源），
  // 并复位到「发现新版本」对话框（保留版本元信息，可再次下载）。
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    updateRef.current?.close().catch(() => {});
    const meta = foundRef.current;
    setStatus(meta ? { kind: 'available', update: null, ...meta } : { kind: 'idle' });
  }, []);

  const install = useCallback(async () => {
    try {
      await updateRef.current?.install();
      // 安装成功会由 Tauri 重启进程，无需复位状态。
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // 关闭对话框：释放资源并回到 idle。
  const dismiss = useCallback(() => {
    updateRef.current?.close().catch(() => {});
    updateRef.current = null;
    foundRef.current = null;
    cancelledRef.current = false;
    setStatus({ kind: 'idle' });
  }, []);

  return { status, check, download, cancel, install, dismiss };
}

export type UpdaterApi = ReturnType<typeof useUpdater>;
