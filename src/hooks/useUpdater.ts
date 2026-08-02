import { useCallback, useRef, useState } from 'react';
import { check as checkUpdate, type Update } from '@tauri-apps/plugin-updater';

// 更新状态机（方案 A：手动检查、下载可见且可取消）。
// - idle       初始/已关闭
// - checkering 正在向更新服务器查询
// - available  发现新版本（update 可能为 null：被取消后保留版本信息、可再次下载）。
//              auto=true 表示由「自动检查」发现：不打扰（仅右上提示+徽标），不弹主弹窗。
// - downloading 下载中（received/total 字节，供进度条）
// - ready     下载完成，等待用户显式「重启安装」（绝不静默安装）
// - no-update 已是最新（仅手动检查时展示）
// - error     检查/下载/安装失败（仅手动检查时展示；自动检查失败则静默）
export type UpdaterStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | {
      kind: 'available';
      update: Update | null;
      version: string;
      current: string;
      body?: string;
      // 是否由「自动检查（启动时）」发现：自动发现不打扰主弹窗，改走右上提示+徽标。
      auto?: boolean;
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

// 已知有可用更新（驱动版本号旁的 NEW 徽标）：自动或手动检查发现的都会记下，
// 直到用户关闭更新弹窗/忽略才清除。与瞬时提示（toast）解耦——徽标可长期存在。
export interface PendingUpdate {
  version: string;
  current: string;
  body?: string;
}

// 右上角自动检查提示（仅在「自动检查」发现新版本时出现，可关闭、可「查看」进入弹窗）。
export interface UpdateToast {
  version: string;
  current: string;
}

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>({ kind: 'idle' });
  const [pendingUpdate, setPendingUpdate] = useState<PendingUpdate | null>(null);
  const [toast, setToast] = useState<UpdateToast | null>(null);
  const updateRef = useRef<Update | null>(null);
  const foundRef = useRef<FoundMeta | null>(null);
  // 已知待处理更新（徽标/提示已存在）：自动检查据此跳过重复查询，避免反复弹提示。
  const pendingRef = useRef<PendingUpdate | null>(null);
  // 取消标记：download() 的 Promise 在 close() 后会 reject，
  // 借此区分「用户主动取消」与「真实错误」，避免误报。
  const cancelledRef = useRef(false);

  // pendingUpdate 与 pendingRef 同步：状态机对外用 state，自动检查跳过逻辑用 ref（即时读取）。
  const setPending = useCallback((p: PendingUpdate | null) => {
    pendingRef.current = p;
    setPendingUpdate(p);
  }, []);

  // 检查更新。auto=true 表示由「自动检查（启动/周期）」触发：
  //  - 已知有待处理更新（pendingRef 存在）→ 直接跳过，避免重复弹提示；
  //  - 发现新版本 → 不打扰主弹窗，仅置右上 toast + 版本徽标；
  //  - 无更新/失败 → 完全静默，绝不弹窗。
  const check = useCallback(
    async (auto = false) => {
      cancelledRef.current = false;
      // 自动检查：已有待处理更新则跳过（周期轮询不会重复打扰）。
      if (auto && pendingRef.current) return;
      setToast(null);
      setStatus({ kind: 'checking' });
      try {
        const u = await checkUpdate();
        if (!u) {
          // 无更新：手动检查展示「已是最新」，自动检查静默。
          setStatus(auto ? { kind: 'idle' } : { kind: 'no-update' });
          return;
        }
        const meta: FoundMeta = {
          version: u.version,
          current: u.currentVersion,
          body: u.body,
        };
        updateRef.current = u;
        foundRef.current = meta;
        setPending(meta);
        if (auto) {
          // 自动检查：仅提示 + 徽标，不弹主弹窗（auto=true 让 UpdateDialog 隐藏自身）。
          setStatus({ kind: 'available', update: u, ...meta, auto: true });
          setToast({ version: u.version, current: u.currentVersion });
        } else {
          setStatus({ kind: 'available', update: u, ...meta, auto: false });
        }
      } catch (err) {
        if (auto) {
          // 自动检查失败：静默，不打扰用户（不弹错误框）。
          setStatus({ kind: 'idle' });
          return;
        }
        setStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [setPending],
  );

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
      setPending(meta);
      setStatus({ kind: 'available', update: u, ...meta, auto: false });
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
  }, [setPending]);

  // 取消下载：best-effort 中断底层 Rust 下载任务（close 释放 Update 资源），
  // 并复位到「发现新版本」对话框（保留版本元信息，可再次下载）。
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    updateRef.current?.close().catch(() => {});
    const meta = foundRef.current;
    setStatus(meta ? { kind: 'available', update: null, ...meta, auto: false } : { kind: 'idle' });
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

  // 关闭对话框：释放资源并回到 idle，同时清除徽标与提示。
  const dismiss = useCallback(() => {
    updateRef.current?.close().catch(() => {});
    updateRef.current = null;
    foundRef.current = null;
    cancelledRef.current = false;
    setStatus({ kind: 'idle' });
    setPending(null);
    setToast(null);
  }, [setPending]);

  // 关闭右上角自动检查提示：仅隐藏提示，保留版本徽标（用户仍可稍后在设置里查看）。
  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  // 从「徽标 / 提示」进入交互式更新弹窗：把自动发现的状态升级为手动式（auto=false），
  // 主弹窗随即显示；不清除徽标（弹窗关闭时才清除）。
  const openUpdate = useCallback(() => {
    setToast(null);
    setStatus((s) => (s.kind === 'available' ? { ...s, auto: false } : s));
  }, []);

  return {
    status,
    pendingUpdate,
    toast,
    check,
    download,
    cancel,
    install,
    dismiss,
    dismissToast,
    openUpdate,
  };
}

export type UpdaterApi = ReturnType<typeof useUpdater>;
