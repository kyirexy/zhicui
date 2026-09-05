// 只用于官网下载推荐；客户端权限必须使用 Capacitor 的原生身份判断。
export function detectMobileDownloadPlatform(
  userAgent: string,
  platform = '',
  maxTouchPoints = 0,
): 'android' | 'ios' | null {
  if (/iPhone|iPad|iPod/i.test(userAgent)
    || (/Mac/i.test(platform) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return null;
}
