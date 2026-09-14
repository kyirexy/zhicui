export type ClientPlatform = 'android' | 'windows';
export type ClientReleaseChannel = 'beta' | 'stable';

export interface ClientRelease {
  platform: ClientPlatform;
  channel: ClientReleaseChannel;
  // 未取得可信清单时保留下载入口，不编造“最新版本”或文件大小。
  version: string | null;
  downloadUrl: string;
  sizeBytes: number | null;
  publishedAt: string | null;
  architecture?: string;
  build?: number;
  codeSigned?: boolean;
  releaseStatus?: string;
}

export interface ClientReleaseCatalog {
  android: ClientRelease;
  windows: ClientRelease;
}

const OFFICIAL_ORIGIN = 'https://luxai.cn';
const CHANNEL_MANIFEST_ROOT = '/download/releases';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function countedClientDownloadUrl(platform: ClientPlatform): string {
  return `/api/client-downloads/${platform}`;
}

function unknownRelease(platform: ClientPlatform): ClientRelease {
  return { platform, channel: 'beta', version: null, sizeBytes: null, publishedAt: null,
    downloadUrl: OFFICIAL_ORIGIN + countedClientDownloadUrl(platform) };
}

export const CLIENT_RELEASE_FALLBACKS: ClientReleaseCatalog = {
  android: unknownRelease('android'),
  windows: unknownRelease('windows'),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 清单、渠道和不可变产物名必须完全对应；不能用旧安装包补一个看似有效的新版本。
export function parseClientRelease(
  value: unknown, platform: ClientPlatform, channel: ClientReleaseChannel,
): ClientRelease | null {
  if (!isRecord(value) || value.schema_version !== 2 || value.platform !== platform
    || value.channel !== channel || value.availability !== 'available') return null;
  const version = typeof value.version === 'string' ? value.version : '';
  if (version.length > 80 || !VERSION.test(version)
    || !Number.isSafeInteger(value.size_bytes) || Number(value.size_bytes) <= 0
    || typeof value.published_at !== 'string' || value.published_at.length > 80
    || !Number.isFinite(Date.parse(value.published_at))
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)
    || typeof value.download_url !== 'string' || value.download_url.length > 260) return null;

  let expectedPath: string;
  if (platform === 'windows') {
    if (value.architecture !== 'x64' || typeof value.code_signed !== 'boolean'
      || (channel === 'stable' && !value.code_signed)) return null;
    expectedPath = `/download/windows/Zhicui-Setup-${version}-x64.exe`;
  } else {
    if (!Number.isSafeInteger(value.build) || Number(value.build) <= 0) return null;
    if (channel === 'stable' && (value.artifact_kind !== 'release'
      || value.debuggable !== false || !isRecord(value.signing) || value.signing.verified !== true)) return null;
    expectedPath = `/download/android/Zhicui-${version}-${value.build}.apk`;
  }
  try {
    const url = new URL(value.download_url);
    if (url.origin !== OFFICIAL_ORIGIN || url.username || url.password || url.search || url.hash
      || url.pathname !== expectedPath || value.download_url !== OFFICIAL_ORIGIN + expectedPath) return null;
  } catch { return null; }

  return { platform, channel, version, sizeBytes: Number(value.size_bytes), publishedAt: value.published_at,
    downloadUrl: value.download_url,
    ...(platform === 'windows' ? { architecture: 'x64', codeSigned: value.code_signed as boolean }
      : { build: Number(value.build) }),
    releaseStatus: channel === 'stable' ? 'stable_download' : 'beta_download' };
}

async function fetchManifest(path: string, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(12_000);
  const response = await fetch(`${path}?ts=${Date.now()}`, {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error('暂时无法确认客户端版本');
  return response.json() as Promise<unknown>;
}

export async function loadClientReleaseCatalog(
  signal?: AbortSignal,
  channel: ClientReleaseChannel = 'beta',
): Promise<ClientReleaseCatalog> {
  const loadChannel = async (platform: ClientPlatform) => {
    const value = await fetchManifest(`${CHANNEL_MANIFEST_ROOT}/${platform}/${channel}.json`, signal);
    const release = parseClientRelease(value, platform, channel);
    if (!release) throw new Error('客户端发行清单暂不可用');
    return release;
  };
  const [androidResult, windowsResult] = await Promise.allSettled([
    loadChannel('android'), loadChannel('windows'),
  ]);
  if (channel === 'stable' && (androidResult.status === 'rejected' || windowsResult.status === 'rejected')) {
    throw new Error('正式版发行尚未开放，拒绝回退到公测安装包');
  }
  // 不读取可能陈旧的 legacy 清单；失败时仅保留服务器实时解析的官方计数入口。
  return {
    android: androidResult.status === 'fulfilled' ? androidResult.value : unknownRelease('android'),
    windows: windowsResult.status === 'fulfilled' ? windowsResult.value : unknownRelease('windows'),
  };
}

export function detectPreferredClient(
  userAgent: string,
  platform = '',
): ClientPlatform | null {
  const fingerprint = `${userAgent} ${platform}`.toLowerCase();
  if (fingerprint.includes('android')) return 'android';
  if (fingerprint.includes('windows') || fingerprint.includes('win32') || fingerprint.includes('win64')) return 'windows';
  return null;
}

export function formatReleaseSize(sizeBytes: number | null): string {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return '';
  const megabytes = sizeBytes / (1024 * 1024);
  return `${new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 1, minimumFractionDigits: megabytes < 10 ? 1 : 0,
  }).format(megabytes)} MB`;
}

export function toAbsoluteDownloadUrl(url: string, _origin?: string): string {
  // 二维码只指向官方计数入口，预览环境、外部 origin 和无效地址都不能成为安装来源。
  try {
    const parsed = new URL(url, OFFICIAL_ORIGIN);
    if (parsed.origin === OFFICIAL_ORIGIN && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && /^\/api\/client-downloads\/(android|windows)$/.test(parsed.pathname)) return parsed.href;
  } catch { /* 退回官方入口，由服务器选择最新产物。 */ }
  return OFFICIAL_ORIGIN + countedClientDownloadUrl('android');
}
