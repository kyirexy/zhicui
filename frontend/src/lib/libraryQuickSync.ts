import type { DouyinSourceMode } from './types';

export const QUICK_SYNC_MODES_KEY = 'zhicui-library-sync-modes-v1';
export const QUICK_SYNC_COUNT_KEY = 'zhicui-library-sync-count-v1';
export const QUICK_SYNC_CONFIGURED_KEY = 'zhicui-library-quick-sync-configured-v1';
export const QUICK_SYNC_CHANGED_EVENT = 'zhicui:quick-sync-changed';

export const QUICK_SYNC_MAX_COUNT = 100;
export const QUICK_SYNC_DEFAULT_COUNT = 50;
export const QUICK_SYNC_DEFAULT_MODES: DouyinSourceMode[] = ['collect'];
export const QUICK_SYNC_MODE_ORDER: DouyinSourceMode[] = ['like', 'collect', 'post'];

export interface LibraryQuickSyncPreferences {
  configured: boolean;
  modes: DouyinSourceMode[];
  count: number;
}

function isSourceMode(value: unknown): value is DouyinSourceMode {
  return value === 'like' || value === 'collect' || value === 'post';
}

export function normalizeQuickSyncModes(value: unknown): DouyinSourceMode[] {
  if (!Array.isArray(value)) return [...QUICK_SYNC_DEFAULT_MODES];
  const selected = new Set(value.filter(isSourceMode));
  const modes = QUICK_SYNC_MODE_ORDER.filter((mode) => selected.has(mode));
  return modes.length > 0 ? modes : [...QUICK_SYNC_DEFAULT_MODES];
}

export function toggleQuickSyncMode(
  currentModes: DouyinSourceMode[],
  mode: DouyinSourceMode,
): DouyinSourceMode[] {
  const selected = new Set(currentModes.filter(isSourceMode));
  if (selected.has(mode)) {
    if (selected.size === 1) {
      return QUICK_SYNC_MODE_ORDER.filter((value) => selected.has(value));
    }
    selected.delete(mode);
  } else {
    selected.add(mode);
  }
  return QUICK_SYNC_MODE_ORDER.filter((value) => selected.has(value));
}

export interface DouyinSourceReadiness {
  reported: boolean;
  like_ready: boolean;
  collection_ready: boolean;
}

export function isQuickSyncModeReady(
  mode: DouyinSourceMode,
  readiness?: DouyinSourceReadiness,
): boolean {
  if (!readiness?.reported) return true;
  if (mode === 'collect') return readiness.collection_ready;
  return readiness.like_ready;
}

export function normalizeQuickSyncCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return QUICK_SYNC_DEFAULT_COUNT;
  return Math.max(1, Math.min(QUICK_SYNC_MAX_COUNT, Math.trunc(parsed)));
}

export function readLibraryQuickSyncPreferences(): LibraryQuickSyncPreferences {
  if (typeof window === 'undefined') {
    return {
      configured: false,
      modes: [...QUICK_SYNC_DEFAULT_MODES],
      count: QUICK_SYNC_DEFAULT_COUNT,
    };
  }

  try {
    const rawModes = window.localStorage.getItem(QUICK_SYNC_MODES_KEY);
    const rawCount = window.localStorage.getItem(QUICK_SYNC_COUNT_KEY);
    const configured = window.localStorage.getItem(QUICK_SYNC_CONFIGURED_KEY) === '1';
    const parsedModes = rawModes ? JSON.parse(rawModes) : null;
    const hasValidModes = Array.isArray(parsedModes) && parsedModes.some(isSourceMode);
    const parsedCount = rawCount === null ? Number.NaN : Number(rawCount);
    const hasValidCount = Number.isInteger(parsedCount)
      && parsedCount >= 1
      && parsedCount <= QUICK_SYNC_MAX_COUNT;

    return {
      configured: configured && hasValidModes && hasValidCount,
      modes: normalizeQuickSyncModes(parsedModes),
      count: normalizeQuickSyncCount(parsedCount),
    };
  } catch {
    return {
      configured: false,
      modes: [...QUICK_SYNC_DEFAULT_MODES],
      count: QUICK_SYNC_DEFAULT_COUNT,
    };
  }
}

function notifyQuickSyncChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(QUICK_SYNC_CHANGED_EVENT));
  }
}

export function saveLibraryQuickSyncPreferences(
  modes: DouyinSourceMode[],
  count: number,
): LibraryQuickSyncPreferences {
  const preferences: LibraryQuickSyncPreferences = {
    configured: true,
    modes: normalizeQuickSyncModes(modes),
    count: normalizeQuickSyncCount(count),
  };
  if (typeof window === 'undefined') return preferences;

  try {
    window.localStorage.setItem(QUICK_SYNC_MODES_KEY, JSON.stringify(preferences.modes));
    window.localStorage.setItem(QUICK_SYNC_COUNT_KEY, String(preferences.count));
    window.localStorage.setItem(QUICK_SYNC_CONFIGURED_KEY, '1');
    notifyQuickSyncChanged();
  } catch {
    // 本地偏好写入失败不应阻止用户完成本次同步。
  }
  return preferences;
}

export function requireQuickSyncConfirmation(): LibraryQuickSyncPreferences {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(QUICK_SYNC_CONFIGURED_KEY);
      notifyQuickSyncChanged();
    } catch {
      // 存储不可用时，下次读取自然回退为首次配置。
    }
  }
  return { ...readLibraryQuickSyncPreferences(), configured: false };
}
