import type { PlatformAccountItem } from '@/lib/desktopRuntime';
import type { DouyinLocalSyncItem } from '@/lib/types';

export const MIN_LOCAL_DOUYIN_DESKTOP_VERSION = '1.0.7';

export function supportsLocalDouyinRuntime(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = String(version || '')
    .split('.')
    .slice(0, 3)
    .map((value) => Number.parseInt(value, 10) || 0);
  return major > 1 || (major === 1 && (minor > 0 || patch >= 7));
}

export function requiresLocalDouyinDesktopUpdate(version: string): boolean {
  return Boolean(String(version || '').trim()) && !supportsLocalDouyinRuntime(version);
}

export function toLocalDouyinSyncItems(
  items: PlatformAccountItem[],
): DouyinLocalSyncItem[] {
  return items.slice(0, 100).map((item) => ({
    video_id: item.videoId,
    source_url: item.sourceUrl,
    title: item.title,
    caption: item.caption,
    author_name: item.authorName,
    cover_url: item.coverUrl,
    published_at: item.publishedAt,
    duration_seconds: item.durationSeconds,
    source_rank: item.sourceRank,
  }));
}
