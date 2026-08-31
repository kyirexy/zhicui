import type { DouyinLibraryItem } from './types';

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
  for (const list of lists) {
    for (const item of list || []) {
      const id = String(item.aweme_id || '').trim();
      if (
        !id
        || seen.has(id)
        || !item.can_extract
        || hasReadyTranscript(item)
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
