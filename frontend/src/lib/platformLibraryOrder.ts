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
  const rank = (item: PlatformLibraryItem): number | null => {
    const reliable = item.source_order_reliabilities?.[mode]
      ?? (item.source_mode === mode ? item.source_order_reliable : undefined);
    if (reliable === false) return null;
    const value = item.source_ranks?.[mode]
      ?? (item.source_mode === mode ? item.source_rank : undefined);
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : null;
  };
  // 先展示有可靠排名的资料，再在同一来源内按快照与排名排序。
  // 无可靠排名的资料保持服务端次序，不能仅凭更新的采集时间顶到前面。
  return [...items].sort((left, right) => {
    const leftRank = rank(left);
    const rightRank = rank(right);
    if (leftRank === null) return rightRank === null ? 0 : 1;
    if (rightRank === null) return -1;
    return syncedAt(right) - syncedAt(left) || leftRank - rightRank;
  });
}

export function selectPlatformLibrarySource(
  items: PlatformLibraryItem[],
  mode: PlatformLibrarySourceFilter,
): PlatformLibraryItem[] {
  return sortPlatformLibrarySource(items.filter((item) => matchesPlatformLibrarySource(item, mode)), mode);
}
