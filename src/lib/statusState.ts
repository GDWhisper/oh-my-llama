import type { ServerStatus } from '../types';

// 头部徽章与控制区的展示态判定（输入只取与判定相关的两个字段，便于复用与推导）。
// 后端 get_status 对「配置端口上有服务应答 /health」一律置 running=true，归属差异只体现在
// managed 上（lib.rs：本应用在管 → managed=true；外部启动的 llama-server 或恰巧占用端口的
// 其他 HTTP 服务 → managed=false）。展示层必须区分这两种「running」，否则外部占用者会被
// 误标成自己的服务「运行中」——且其 Stop 按钮恰是禁用的，状态与操作自相矛盾。
export type StatusState = 'running' | 'external' | 'unresponsive' | 'loading' | 'stopped';

// 五态语义：
//  - running    ：本应用拉起的服务已就绪可服务。
//  - external   ：端口上有服务应答但不归本应用管（外部 llama-server 或无关服务占用端口）。
//  - unresponsive：受管进程曾就绪但持续探测不到（unresponsive 由前端 UNRESPONSIVE_MS 判定）。
//  - loading    ：受管进程存活、模型仍在加载（端口尚未就绪）。
//  - stopped    ：端口无服务、本应用也无在管进程。
export function serverStatusState(
  status: Pick<ServerStatus, 'running' | 'managed'> | null | undefined,
  unresponsive: boolean,
): StatusState {
  if (status?.running) {
    return status.managed ? 'running' : 'external';
  }
  if (unresponsive) {
    return 'unresponsive';
  }
  return status?.managed ? 'loading' : 'stopped';
}
