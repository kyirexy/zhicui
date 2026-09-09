export const LIBRARY_UPDATED_EVENT = 'zhicui:library-updated';
const HOME_CACHE_PREFIX = 'zhicui:workspace-home:';
const LIST_CACHE_PREFIXES = ['zhicui-library-list-', 'zhicui-platform-library-list-'];
let revision = 0;
const reportedMutations = new Set<string>();

/** 请求发出时捕获版本；同步落库后，旧响应不能重新写回已经失效的缓存。 */
export function getLibraryRevision(): number { return revision; }

export function isLibraryRevisionCurrent(expected: number): boolean {
  return expected === revision;
}

/** 同步落库后作废资料快照，通知首页、资料库和 Agent 重新读取。 */
export function notifyLibraryUpdated(mutationKey?: string): void {
  if (typeof window === 'undefined') return;
  if (mutationKey && reportedMutations.has(mutationKey)) return;
  if (mutationKey) {
    reportedMutations.add(mutationKey);
    if (reportedMutations.size > 256) reportedMutations.delete(reportedMutations.values().next().value!);
  }
  revision += 1;
  try {
    const keys = Object.keys(window.sessionStorage);
    keys.filter((key) => key.startsWith(HOME_CACHE_PREFIX)
      || LIST_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))).forEach((key) => {
      window.sessionStorage.removeItem(key);
    });
  } catch {
    // 存储不可用时仍发通知，刷新不依赖缓存可用。
  }
  window.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
}

/** 首页、资料库与 Agent 共享刷新入口；后台页面回到前台时补读最新已存资料。 */
export function subscribeLibraryUpdates(refresh: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (document.visibilityState === 'hidden') return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  };
  window.addEventListener(LIBRARY_UPDATED_EVENT, schedule);
  window.addEventListener('focus', schedule);
  window.addEventListener('pageshow', schedule);
  document.addEventListener('visibilitychange', schedule);
  return () => {
    clearTimeout(timer);
    window.removeEventListener(LIBRARY_UPDATED_EVENT, schedule);
    window.removeEventListener('focus', schedule);
    window.removeEventListener('pageshow', schedule);
    document.removeEventListener('visibilitychange', schedule);
  };
}
