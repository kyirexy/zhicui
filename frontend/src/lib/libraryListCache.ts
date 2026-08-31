import type {
  DouyinLibraryListResult,
  DouyinLibrarySort,
  DouyinSourceMode,
  PlatformLibraryItem,
} from './types';

// v3 invalidates pre-transcript-repair snapshots whose cards could remain
// visually stuck on “待整理” after the database had already been repaired.
const CACHE_PREFIX = 'zhicui-library-list-v3';
const PLATFORM_CACHE_PREFIX = 'zhicui-platform-library-list-v1';
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

interface LibraryListCachePayload {
  savedAt: number;
  result: DouyinLibraryListResult;
}

function cacheKey(
  userId: string,
  sourceMode: DouyinSourceMode,
  sort: DouyinLibrarySort,
): string {
  return `${CACHE_PREFIX}:${encodeURIComponent(userId)}:${sourceMode}:${sort}`;
}

function isLibraryListResult(value: unknown): value is DouyinLibraryListResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DouyinLibraryListResult>;
  return Array.isArray(result.items)
    && typeof result.total === 'number'
    && typeof result.source_total === 'number'
    && Boolean(result.hidden)
    && typeof result.permanent_hidden_total === 'number';
}

export function readLibraryListCache(
  userId: string | null | undefined,
  sourceMode: DouyinSourceMode,
  sort: DouyinLibrarySort,
  now = Date.now(),
): DouyinLibraryListResult | null {
  if (!userId || typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(cacheKey(userId, sourceMode, sort));
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<LibraryListCachePayload>;
    if (
      typeof payload.savedAt !== 'number'
      || now - payload.savedAt > CACHE_MAX_AGE_MS
      || !isLibraryListResult(payload.result)
    ) {
      window.sessionStorage.removeItem(cacheKey(userId, sourceMode, sort));
      return null;
    }
    return payload.result;
  } catch {
    return null;
  }
}

export function writeLibraryListCache(
  userId: string | null | undefined,
  sourceMode: DouyinSourceMode,
  sort: DouyinLibrarySort,
  result: DouyinLibraryListResult,
  now = Date.now(),
): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    const payload: LibraryListCachePayload = { savedAt: now, result };
    window.sessionStorage.setItem(
      cacheKey(userId, sourceMode, sort),
      JSON.stringify(payload),
    );
  } catch {
    // 隐私或受限环境可能禁用存储；网络仍是事实来源，缓存失败不能阻塞页面。
  }
}

export function clearLibraryListCache(
  userId: string | null | undefined,
): void {
  if (!userId || typeof window === 'undefined') return;
  const prefix = `${CACHE_PREFIX}:${encodeURIComponent(userId)}:`;
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(prefix)) window.sessionStorage.removeItem(key);
    }
  } catch {
    // 缓存不可用时无需阻塞任务终态刷新。
  }
}

export function readPlatformLibraryCache(
  userId: string | null | undefined,
  now = Date.now(),
): PlatformLibraryItem[] | null {
  if (!userId || typeof window === 'undefined') return null;
  const key = `${PLATFORM_CACHE_PREFIX}:${encodeURIComponent(userId)}`;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const payload = JSON.parse(raw) as {
      savedAt?: number;
      items?: PlatformLibraryItem[];
    };
    if (
      typeof payload.savedAt !== 'number'
      || now - payload.savedAt > CACHE_MAX_AGE_MS
      || !Array.isArray(payload.items)
    ) {
      window.sessionStorage.removeItem(key);
      return null;
    }
    return payload.items;
  } catch {
    return null;
  }
}

export function writePlatformLibraryCache(
  userId: string | null | undefined,
  items: PlatformLibraryItem[],
  now = Date.now(),
): void {
  if (!userId || typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(
      `${PLATFORM_CACHE_PREFIX}:${encodeURIComponent(userId)}`,
      JSON.stringify({ savedAt: now, items }),
    );
  } catch {
    // 会话缓存仅用于提速，失败时直接回退到网络请求。
  }
}
