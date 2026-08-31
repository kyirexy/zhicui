import type { DouyinLibraryItem } from './types';

export function hasReadyTranscript(item: DouyinLibraryItem): boolean {
  return Boolean(item.extracted_note_id) && item.transcript_chars > 0;
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
