import type { PlatformAccountItem } from '@/lib/desktopRuntime';
import type { DouyinLocalSyncItem } from '@/lib/types';

export const MIN_LOCAL_DOUYIN_DESKTOP_VERSION = '1.0.9';

const EPHEMERAL_MEDIA_TTL_MS = 15 * 60 * 1000;
const TRUSTED_DOUYIN_MEDIA_DOMAINS = [
  'douyinvod.com',
  'bytecdn.cn',
  'bytecdn.com',
  'snssdk.com',
  'ibytedtos.com',
  'douyin.com',
  'iesdouyin.com',
  'pstatp.com',
  'zjcdn.com',
  'volccdn.com',
] as const;
const ephemeralMedia = new Map<string, { mediaUrl: string; capturedAt: number }>();

export function isTrustedEphemeralDouyinMediaUrl(value: string): boolean {
  try {
    const parsed = new URL(String(value || '').trim());
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && (!parsed.port || parsed.port === '443')
      && TRUSTED_DOUYIN_MEDIA_DOMAINS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
      );
  } catch {
    return false;
  }
}

export function supportsLocalDouyinRuntime(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = String(version || '')
    .split('.')
    .slice(0, 3)
    .map((value) => Number.parseInt(value, 10) || 0);
  return major > 1 || (major === 1 && (minor > 0 || patch >= 9));
}

export function requiresLocalDouyinDesktopUpdate(version: string): boolean {
  return Boolean(String(version || '').trim()) && !supportsLocalDouyinRuntime(version);
}

export function toLocalDouyinSyncItems(
  items: PlatformAccountItem[],
): DouyinLocalSyncItem[] {
  return items.slice(0, 100).map((item) => {
    const mediaUrl = String(item.ephemeralMediaUrl || '').trim();
    if (isTrustedEphemeralDouyinMediaUrl(mediaUrl)) {
      ephemeralMedia.set(item.videoId, { mediaUrl, capturedAt: Date.now() });
    } else {
      ephemeralMedia.delete(item.videoId);
    }
    return {
      video_id: item.videoId,
      source_url: item.sourceUrl,
      title: item.title,
      caption: item.caption,
      author_name: item.authorName,
      cover_url: item.coverUrl,
      published_at: item.publishedAt,
      duration_seconds: item.durationSeconds,
      source_rank: item.sourceRank,
    };
  });
}

export function getEphemeralDouyinMediaSources(
  videoIds: string[],
): Array<{ aweme_id: string; media_url: string }> {
  const now = Date.now();
  const sources: Array<{ aweme_id: string; media_url: string }> = [];
  for (const videoId of videoIds) {
    const cached = ephemeralMedia.get(videoId);
    if (!cached) continue;
    if (now - cached.capturedAt > EPHEMERAL_MEDIA_TTL_MS) {
      ephemeralMedia.delete(videoId);
      continue;
    }
    sources.push({ aweme_id: videoId, media_url: cached.mediaUrl });
  }
  return sources;
}
