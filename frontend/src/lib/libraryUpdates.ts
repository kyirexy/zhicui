export const LIBRARY_UPDATED_EVENT = 'zhicui:library-updated';
const HOME_CACHE_PREFIX = 'zhicui:workspace-home:';

/** 同步登记或导入落库后清理首页快照，已打开的首页立即重新读取。 */
export function notifyLibraryUpdated(): void {
  if (typeof window === 'undefined') return;
  try {
    const keys = Object.keys(window.sessionStorage);
    keys.filter((key) => key.startsWith(HOME_CACHE_PREFIX)).forEach((key) => {
      window.sessionStorage.removeItem(key);
    });
  } catch {
    // 存储不可用时仍发通知，刷新不依赖缓存可用。
  }
  window.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
}
