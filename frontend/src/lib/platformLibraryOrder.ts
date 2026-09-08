import type { DouyinSourceMode, PlatformLibraryItem } from './types';
import { sourceSnapshotTime } from './platformSyncSnapshot.ts';

export type PlatformLibrarySourceFilter = DouyinSourceMode | 'import';

export function matchesPlatformLibrarySource(
  item: PlatformLibraryItem,
  mode: PlatformLibrarySourceFilter,
): boolean {
  // 普通导入不能伪装成“我的作品”；同一视频可以同时属于收藏和喜欢。
  return item.source_mode === mode || Boolean(item.source_modes?.includes(mode as DouyinSourceMode));
}

export function sortPlatformLibrarySource(
  items: PlatformLibraryItem[],
  mode: PlatformLibrarySourceFilter,
): PlatformLibraryItem[] {
  const syncedAt = (item: PlatformLibraryItem): number => sourceSnapshotTime(
    item.source_synced_ats?.[mode]
      ?? (item.source_mode === mode ? item.source_synced_at : undefined),
  );
  const rank = (item: PlatformLibraryItem): number => {
    const reliable = item.source_order_reliabilities?.[mode]
      ?? (item.source_mode === mode ? item.source_order_reliable : undefined);
    if (reliable === false) return Number.MAX_SAFE_INTEGER;
    const value = item.source_ranks?.[mode]
      ?? (item.source_mode === mode ? item.source_rank : undefined);
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : Number.MAX_SAFE_INTEGER;
  };
  // 新快照前缀始终在旧快照尾部之前；排名只在同一来源、同一快照内比较。
  // 缺少快照/排名时保持服务端顺序，不拿发布时间或文案完成时间冒充收藏顺序。
  return [...items].sort((left, right) => syncedAt(right) - syncedAt(left) || rank(left) - rank(right));
}

export function selectPlatformLibrarySource(
  items: PlatformLibraryItem[],
  mode: PlatformLibrarySourceFilter,
): PlatformLibraryItem[] {
  return sortPlatformLibrarySource(items.filter((item) => matchesPlatformLibrarySource(item, mode)), mode);
}
