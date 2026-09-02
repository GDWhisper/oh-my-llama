// 项目仓库地址：关于面板与更新弹窗共用，避免两处硬编码漂移。
export const REPO_URL = 'https://github.com/GDWhisper/oh-my-llama';

// 指定版本的 GitHub Release 页面。版本号可能带或不带 v 前缀，统一归一。
export function releaseUrl(version: string): string {
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `${REPO_URL}/releases/tag/${tag}`;
}
