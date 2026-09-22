import type { CreatorSource } from '@/lib/types';

/**
 * Pick one stable, real creator for the home preview.
 *
 * The old home view rendered the author field from whichever three videos
 * happened to arrive first. That makes the section look like a random list of
 * people rather than a creator workspace. Keep the choice deterministic and
 * data backed: prefer an active source with the richest catalog, then the most
 * recently successful sync, and finally the display name as a tie breaker.
 */
export function selectFeaturedCreator(sources: CreatorSource[]): CreatorSource | null {
  const candidates = sources
    .filter((source) => source.status === 'active' && Boolean(source.display_name?.trim()))
    .slice()
    .sort((a, b) => {
      const totalA = a.catalog_counts?.total ?? a.catalog_count ?? 0;
      const totalB = b.catalog_counts?.total ?? b.catalog_count ?? 0;
      if (totalA !== totalB) return totalB - totalA;

      const syncedA = Date.parse(a.last_success_at || a.last_synced_at || a.updated_at || a.created_at);
      const syncedB = Date.parse(b.last_success_at || b.last_synced_at || b.updated_at || b.created_at);
      if (Number.isFinite(syncedA) && Number.isFinite(syncedB) && syncedA !== syncedB) {
        return syncedB - syncedA;
      }
      if (Number.isFinite(syncedB) !== Number.isFinite(syncedA)) return Number.isFinite(syncedB) ? 1 : -1;
      return a.display_name.localeCompare(b.display_name, 'zh-CN');
    });

  return candidates[0] || null;
}

export function featuredCreatorCount(source: CreatorSource): number {
  return source.catalog_counts?.total
    ?? source.catalog_count
    ?? source.available_count
    ?? source.transcript_count
    ?? 0;
}

export function featuredCreatorReadyCount(source: CreatorSource): number {
  return source.available_count
    ?? source.catalog_counts?.imported
    ?? source.transcript_count
    ?? 0;
}
