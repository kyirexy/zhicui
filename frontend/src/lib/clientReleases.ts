export type ClientPlatform = 'android' | 'windows';
export type ClientReleaseChannel = 'beta' | 'stable';

export interface ClientRelease {
  platform: ClientPlatform;
  channel: ClientReleaseChannel;
  version: string;
  downloadUrl: string;
  sizeBytes: number;
  publishedAt: string;
  architecture?: string;
  build?: number;
  codeSigned?: boolean;
  releaseStatus?: string;
}

export interface ClientReleaseCatalog {
  android: ClientRelease;
  windows: ClientRelease;
}

export function countedClientDownloadUrl(platform: ClientPlatform): string {
  return `/api/client-downloads/${platform}`;
}

const CHANNEL_MANIFEST_ROOT = '/download/releases';
const LEGACY_ANDROID_MANIFEST_URL = '/download/latest.json';
const LEGACY_WINDOWS_MANIFEST_URL = '/download/desktop-latest.json';

export const CLIENT_RELEASE_FALLBACKS: ClientReleaseCatalog = {
  android: {
    platform: 'android',
    channel: 'beta',
    version: '1.2.7',
    build: 19,
    downloadUrl: 'https://luxai.cn/download/zhicui.apk',
    sizeBytes: 9_878_245,
    publishedAt: '2026-08-28T04:32:18.9888176Z',
    releaseStatus: 'beta_download',
  },
  windows: {
    platform: 'windows',
    channel: 'beta',
    version: '1.0.9',
    architecture: 'x64',
    downloadUrl: 'https://luxai.cn/download/windows/Zhicui-Setup-1.0.9-x64.exe',
    sizeBytes: 93_530_247,
    publishedAt: '2026-08-28T02:37:35.3912274Z',
    codeSigned: false,
    releaseStatus: 'beta_download',
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 180 ? normalized : null;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function safeDownloadUrl(value: unknown, fallback: string): string {
  const candidate = readRequiredString(value);
  if (!candidate) return fallback;

  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    return candidate;
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' ? parsed.toString() : fallback;
  } catch {
    return fallback;
  }
}

function parseAndroidRelease(value: unknown): ClientRelease {
  const fallback = CLIENT_RELEASE_FALLBACKS.android;
  if (!isRecord(value)) return { ...fallback };

  const version = readRequiredString(value.version);
  const sizeBytes = readPositiveNumber(value.size_bytes);
  const publishedAt = readRequiredString(value.published_at);
  if (!version || !sizeBytes || !publishedAt) return { ...fallback };

  const build = readPositiveNumber(value.build);
  return {
    platform: 'android',
    channel: value.channel === 'stable' ? 'stable' : 'beta',
    version,
    build: build ? Math.trunc(build) : fallback.build,
    downloadUrl: safeDownloadUrl(value.download_url, fallback.downloadUrl),
    sizeBytes,
    publishedAt,
    releaseStatus: value.channel === 'stable' ? 'stable_download' : 'beta_download',
  };
}

function parseWindowsRelease(value: unknown): ClientRelease {
  const fallback = CLIENT_RELEASE_FALLBACKS.windows;
  if (!isRecord(value)) return { ...fallback };

  const version = readRequiredString(value.version);
  const sizeBytes = readPositiveNumber(value.size_bytes);
  const publishedAt = readRequiredString(value.published_at);
  if (!version || !sizeBytes || !publishedAt) return { ...fallback };

  const channel: ClientReleaseChannel = value.channel === 'stable' ? 'stable' : 'beta';
  return {
    platform: 'windows',
    channel,
    version,
    architecture: readRequiredString(value.architecture) || fallback.architecture,
    downloadUrl: safeDownloadUrl(
      value.download_url ?? value.url,
      fallback.downloadUrl,
    ),
    sizeBytes,
    publishedAt,
    codeSigned: typeof value.code_signed === 'boolean'
      ? value.code_signed
      : fallback.codeSigned,
    releaseStatus: readRequiredString(value.release_status)
      || (channel === 'stable' ? 'stable_download' : 'beta_download'),
  };
}

async function fetchManifest(path: string, signal?: AbortSignal): Promise<unknown> {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}ts=${Date.now()}`, {
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new Error(`Release manifest request failed: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function loadClientReleaseCatalog(
  signal?: AbortSignal,
  channel: ClientReleaseChannel = 'beta',
): Promise<ClientReleaseCatalog> {
  const loadChannel = async (platform: ClientPlatform, legacyPath: string) => {
    try {
      const value = await fetchManifest(
        `${CHANNEL_MANIFEST_ROOT}/${platform}/${channel}.json`,
        signal,
      );
      if (isRecord(value) && value.availability === 'available') return value;
      throw new Error(`${platform} ${channel} channel unavailable`);
    } catch (error) {
      if (channel !== 'beta') throw error;
      return fetchManifest(legacyPath, signal);
    }
  };
  const [androidResult, windowsResult] = await Promise.allSettled([
    loadChannel('android', LEGACY_ANDROID_MANIFEST_URL),
    loadChannel('windows', LEGACY_WINDOWS_MANIFEST_URL),
  ]);

  if (
    channel === 'stable'
    && (androidResult.status === 'rejected' || windowsResult.status === 'rejected')
  ) {
    throw new Error('正式版发行尚未开放，拒绝回退到公测安装包');
  }

  return {
    android: androidResult.status === 'fulfilled'
      ? parseAndroidRelease(androidResult.value)
      : { ...CLIENT_RELEASE_FALLBACKS.android },
    windows: windowsResult.status === 'fulfilled'
      ? parseWindowsRelease(windowsResult.value)
      : { ...CLIENT_RELEASE_FALLBACKS.windows },
  };
}

export function detectPreferredClient(
  userAgent: string,
  platform = '',
): ClientPlatform | null {
  const fingerprint = `${userAgent} ${platform}`.toLowerCase();
  if (fingerprint.includes('android')) return 'android';
  if (
    fingerprint.includes('windows')
    || fingerprint.includes('win32')
    || fingerprint.includes('win64')
  ) {
    return 'windows';
  }
  return null;
}

export function formatReleaseSize(sizeBytes: number): string {
  const megabytes = sizeBytes / (1024 * 1024);
  return `${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 1,
    minimumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes)} MB`;
}

export function toAbsoluteDownloadUrl(url: string, origin: string): string {
  try {
    return new URL(url, origin).toString();
  } catch {
    return CLIENT_RELEASE_FALLBACKS.android.downloadUrl;
  }
}
