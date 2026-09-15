export type LibrarySyncPlatform = 'douyin' | 'bilibili';
export type LibrarySyncMode = 'collect' | 'like' | 'post';
export interface LibrarySyncSelection {
  userId: string;
  platform: LibrarySyncPlatform;
  mode: LibrarySyncMode;
}
export type LibrarySyncSelections = Partial<Record<LibrarySyncPlatform, LibrarySyncMode>>;

const SYNC_SELECTION_EVENT = 'zhicui:library-sync-selection';
const STORAGE_PREFIX = 'zhicui:library-sync-selection:v1:';
const memory = new Map<string, LibrarySyncSelections>();

function validMode(platform: LibrarySyncPlatform, mode: unknown): mode is LibrarySyncMode {
  return mode === 'collect' || mode === 'like' || (platform === 'douyin' && mode === 'post');
}

function validUser(userId: unknown): userId is string {
  return typeof userId === 'string' && userId.length > 0 && userId.length <= 180;
}

export function readLibrarySyncSelections(userId: string | undefined): LibrarySyncSelections {
  if (!validUser(userId) || typeof window === 'undefined') return {};
  const cached = memory.get(userId);
  if (cached) return { ...cached };
  try {
    const raw = JSON.parse(window.sessionStorage.getItem(STORAGE_PREFIX + encodeURIComponent(userId)) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: LibrarySyncSelections = {};
    for (const platform of ['douyin', 'bilibili'] as const) {
      if (validMode(platform, raw[platform])) result[platform] = raw[platform];
    }
    return result;
  } catch { return {}; }
}

/** 只保存显示偏好，不启动采集、不使文稿队列或已有资料失效。 */
export function publishLibrarySyncSelection(userId: string | undefined, platform: string, mode: string): void {
  if (typeof window === 'undefined' || !validUser(userId)
    || (platform !== 'douyin' && platform !== 'bilibili') || !validMode(platform, mode)) return;
  const next = { ...readLibrarySyncSelections(userId), [platform]: mode };
  memory.set(userId, next);
  if (memory.size > 32) memory.delete(memory.keys().next().value!);
  try { window.sessionStorage.setItem(STORAGE_PREFIX + encodeURIComponent(userId), JSON.stringify(next)); }
  catch { /* 存储不可用时仍在本页面会话内恢复本次选择。 */ }
  window.dispatchEvent(new CustomEvent<LibrarySyncSelection>(SYNC_SELECTION_EVENT, {
    detail: { userId, platform, mode },
  }));
}

export function subscribeLibrarySyncSelections(
  userId: string | undefined, listener: (selection: LibrarySyncSelection) => void,
): () => void {
  if (typeof window === 'undefined' || !validUser(userId)) return () => {};
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== 'object') return;
    const value = detail as Record<string, unknown>;
    if (value.userId !== userId || (value.platform !== 'douyin' && value.platform !== 'bilibili')
      || !validMode(value.platform, value.mode)) return;
    listener({ userId, platform: value.platform, mode: value.mode });
  };
  window.addEventListener(SYNC_SELECTION_EVENT, handle);
  return () => window.removeEventListener(SYNC_SELECTION_EVENT, handle);
}

export function librarySyncSelectionPath(currentUrl: string, selection: LibrarySyncSelection): string {
  const url = new URL(currentUrl);
  url.searchParams.set('platform', selection.platform);
  url.searchParams.set('mode', selection.mode);
  return `${url.pathname}${url.search}${url.hash}`;
}
