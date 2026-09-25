/** 桌面旧缓存接口只接收本站签名能力地址，普通播放地址必须走资料下载。 */
export function desktopMediaCapability(
  value: string, awemeId: string, kind: 'media' | 'cover', appOrigin: string,
): string | undefined {
  try {
    const url = new URL(value, appOrigin);
    if (url.origin !== new URL(appOrigin).origin || url.username || url.password || url.hash) return;
    if (url.pathname !== `/api/library/douyin/${kind}/${awemeId}`) return;
    if (!['binding', 'expires', 'signature'].every(key => url.searchParams.get(key))) return;
    return url.href;
  } catch { return; }
}

export function desktopMediaDownloadError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/媒体地址|媒体地|视频地址|封面地址|授权参数/.test(message)) {
    return '下载地址已失效，请刷新视频资料后重新下载';
  }
  if (/401|403|登录|验证|授权/.test(message)) return '请重新验证平台账号后下载';
  if (/ENOSPC|空间不足/.test(message)) return '磁盘空间不足，请清理后重试';
  return '视频暂时无法下载，请稍后重试';
}
