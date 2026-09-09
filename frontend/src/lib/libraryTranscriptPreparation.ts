import type { DouyinLibraryItem } from './types';
import { sourceSnapshotTime } from './platformSyncSnapshot.ts';

export function hasReadyTranscript(item: DouyinLibraryItem): boolean {
  return Boolean(item.extracted_note_id) && item.transcript_chars > 0;
}

export function selectSyncedSourceScope(
  items: DouyinLibraryItem[] | null | undefined,
  requestedCount: number,
): DouyinLibraryItem[] {
  const limit = Math.max(0, Math.trunc(requestedCount));
  if (limit === 0) return [];

  // 页面可以按发布时间展示，但同步范围始终以抖音来源顺序为准。
  // 否则刚收藏的旧视频会因为发布时间较早而落在自动补文案范围之外。
  return [...(items || [])]
    .sort((left, right) => {
      const snapshotOrder = sourceSnapshotTime(right.source_synced_at) - sourceSnapshotTime(left.source_synced_at);
      if (snapshotOrder) return snapshotOrder;
      const leftRank = typeof left.source_rank === 'number'
        ? left.source_rank
        : Number.MAX_SAFE_INTEGER;
      const rightRank = typeof right.source_rank === 'number'
        ? right.source_rank
        : Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank;
    })
    .slice(0, limit);
}

export function selectTranscriptPreparationTargets(
  lists: Array<DouyinLibraryItem[] | null | undefined>,
  maxItems = 100,
): DouyinLibraryItem[] {
  const limit = Math.max(0, Math.trunc(maxItems));
  if (limit === 0) return [];

  const selected: DouyinLibraryItem[] = [];
  const seen = new Set<string>();
  const readyIds = new Set(lists.flatMap((list) => (list || [])
    .filter(hasReadyTranscript).map((item) => item.aweme_id)));
  for (const list of lists) {
    for (const item of list || []) {
      const id = String(item.aweme_id || '').trim();
      if (
        !id
        || seen.has(id)
        || !item.can_extract
        || readyIds.has(id)
      ) {
        continue;
      }
      seen.add(id);
      selected.push(item);
      if (selected.length >= limit) return selected;
    }
  }
  return selected;
}

/** 普通同步只处理服务端明确登记为新增的ID，缺少新增范围时不能用分类列表差集猜测。 */
export function selectAutomaticTranscriptPreparationTargets(
  results: Array<{ items: DouyinLibraryItem[] | null; createdVideoIds?: string[] }>,
  maxItems = 100,
): DouyinLibraryItem[] {
  const readyIds = new Set(results.flatMap(({ items }) => (items || [])
    .filter(hasReadyTranscript).map((item) => item.aweme_id)));
  const lists = results.map(({ items, createdVideoIds }) => {
    const created = new Set(createdVideoIds || []);
    return selectSyncedSourceScope(
      (items || []).filter((item) => created.has(item.aweme_id) && !readyIds.has(item.aweme_id)),
      created.size,
    );
  });
  return selectTranscriptPreparationTargets(lists, maxItems);
}
