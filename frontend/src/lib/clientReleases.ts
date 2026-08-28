export type ClientPlatform = 'android' | 'windows';

export interface ClientRelease {
  platform: ClientPlatform;
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

const ANDROID_MANIFEST_URL = '/download/latest.json';
const WINDOWS_MANIFEST_URL = '/download/desktop-latest.json';

export const CLIENT_RELEASE_FALLBACKS: ClientReleaseCatalog = {
  android: {
    platform: 'android',
    version: '1.2.7',
    build: 19,
    downloadUrl: 'https://luxai.cn/download/zhicui.apk',
    sizeBytes: 9_859_270,
    publishedAt: '2026-08-28T04:30:00.000Z',
    releaseStatus: 'public_download',
  },
  windows: {
    platform: 'windows',
    version: '1.0.5',
    architecture: 'x64',
    downloadUrl: 'https://luxai.cn/download/windows/Zhicui-Setup-latest-x64.exe',
    sizeBytes: 93_527_494,
    publishedAt: '2026-08-26T03:52:26.6691323Z',
    codeSigned: false,
    releaseStatus: 'public_download',
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
    version,
    build: build ? Math.trunc(build) : fallback.build,
    downloadUrl: safeDownloadUrl(value.download_url, fallback.downloadUrl),
    sizeBytes,
    publishedAt,
    releaseStatus: 'public_download',
  };
}

function parseWindowsRelease(value: unknown): ClientRelease {
  const fallback = CLIENT_RELEASE_FALLBACKS.windows;
  if (!isRecord(value)) return { ...fallback };

  const version = readRequiredString(value.version);
  const sizeBytes = readPositiveNumber(value.size_bytes);
  const publishedAt = readRequiredString(value.published_at);
  if (!version || !sizeBytes || !publishedAt) return { ...fallback };

  return {
    platform: 'windows',
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
    releaseStatus: readRequiredString(value.release_status) || fallback.releaseStatus,
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
): Promise<ClientReleaseCatalog> {
  const [androidResult, windowsResult] = await Promise.allSettled([
    fetchManifest(ANDROID_MANIFEST_URL, signal),
    fetchManifest(WINDOWS_MANIFEST_URL, signal),
  ]);

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
