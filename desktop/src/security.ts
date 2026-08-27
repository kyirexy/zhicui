import type { IpcMainInvokeEvent } from 'electron';
import type {
  DesktopLoginRequest,
  DesktopMediaSaveRequest,
  PlatformAccountCollectRequest,
  PlatformAccountProvider,
  PlatformAccountRequest,
  PlatformAccountSourceMode,
} from './contract';

const PRODUCTION_ORIGIN = 'https://luxai.cn';
const DEVELOPMENT_ORIGIN = 'http://localhost:3000';
const DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3003',
  'http://127.0.0.1:3003',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);
const CALLBACK_PATH = '/api/library/douyin/local-handoff/complete';
const HANDOFF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,4096}\.[a-f0-9]{64}$/;
const AWEME_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROFILE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PLATFORM_ACCOUNT_PROVIDERS = new Set<PlatformAccountProvider>([
  'douyin',
  'bilibili',
  'xiaohongshu',
]);
const PLATFORM_ACCOUNT_MODES = new Set<PlatformAccountSourceMode>([
  'like',
  'collect',
  'post',
]);

export function configuredAppUrl(): URL {
  const raw = process.env.ZHICUI_DESKTOP_URL?.trim()
    || (process.defaultApp ? DEVELOPMENT_ORIGIN : PRODUCTION_ORIGIN);
  const parsed = new URL(raw);
  if (!isTrustedOrigin(parsed.origin)) {
    throw new Error('桌面端地址不在可信来源列表中');
  }
  return parsed;
}

export function isTrustedOrigin(origin: string): boolean {
  return origin === PRODUCTION_ORIGIN || DEVELOPMENT_ORIGINS.has(origin);
}

export function isTrustedAppUrl(rawUrl: string): boolean {
  try {
    return isTrustedOrigin(new URL(rawUrl).origin);
  } catch {
    return false;
  }
}

export function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || '';
  if (!isTrustedAppUrl(senderUrl)) {
    throw new Error('当前页面无权调用桌面能力');
  }
}

export function validateLoginRequest(
  value: DesktopLoginRequest,
): DesktopLoginRequest {
  const token = String(value?.token || '').trim();
  if (!HANDOFF_TOKEN_PATTERN.test(token)) {
    throw new Error('登录授权已失效，请返回知萃重新发起');
  }
  let callback: URL;
  try {
    callback = new URL(String(value?.callbackUrl || '').trim());
  } catch {
    throw new Error('登录回传地址无效');
  }
  if (
    !isTrustedOrigin(callback.origin)
    || callback.pathname !== CALLBACK_PATH
    || callback.username
    || callback.password
    || callback.search
    || callback.hash
  ) {
    throw new Error('登录回传地址不受信任');
  }
  return {
    token,
    callbackUrl: callback.toString(),
  };
}

export function safeExternalUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return ['https:', 'mailto:'].includes(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function validateAwemeId(value: unknown): string {
  const awemeId = String(value || '').trim();
  if (!AWEME_ID_PATTERN.test(awemeId)) {
    throw new Error('视频标识无效');
  }
  return awemeId;
}

export function validatePlatformAccountRequest(
  value: PlatformAccountRequest,
): PlatformAccountRequest {
  const platform = String(value?.platform || '') as PlatformAccountProvider;
  const profileKey = String(value?.profileKey || '').trim();
  if (!PLATFORM_ACCOUNT_PROVIDERS.has(platform)) {
    throw new Error('当前平台不支持账号同步');
  }
  if (!PROFILE_KEY_PATTERN.test(profileKey)) {
    throw new Error('本机账号会话标识无效');
  }
  return { platform, profileKey };
}

export function validatePlatformAccountCollectRequest(
  value: PlatformAccountCollectRequest,
): PlatformAccountCollectRequest {
  const request = validatePlatformAccountRequest(value);
  const mode = String(value?.mode || '') as PlatformAccountSourceMode;
  const limit = Number(value?.limit);
  if (!PLATFORM_ACCOUNT_MODES.has(mode)) {
    throw new Error('账号同步来源无效');
  }
  if (request.platform !== 'douyin' && mode === 'post') {
    throw new Error('当前平台不支持同步自己的作品');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('账号同步数量必须在 1–100 条之间');
  }
  return { ...request, mode, limit };
}

function validateSignedMediaUrl(
  rawUrl: unknown,
  awemeId: string,
  kind: 'media' | 'cover',
): string {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || '').trim(), configuredAppUrl());
  } catch {
    throw new Error(kind === 'media' ? '视频地址无效' : '封面地址无效');
  }
  if (
    !isTrustedOrigin(parsed.origin)
    || parsed.username
    || parsed.password
    || parsed.hash
  ) {
    throw new Error('媒体地址不在可信来源内');
  }

  const match = parsed.pathname.match(
    new RegExp(`^/api/library/douyin/${kind}/([A-Za-z0-9_-]{1,128})$`),
  );
  if (!match || match[1] !== awemeId) {
    throw new Error('媒体地址与当前视频不匹配');
  }
  if (
    !parsed.searchParams.get('binding')
    || !parsed.searchParams.get('expires')
    || !parsed.searchParams.get('signature')
  ) {
    throw new Error('媒体授权参数不完整，请刷新视频后重试');
  }
  return parsed.toString();
}

export function validateMediaSaveRequest(
  value: DesktopMediaSaveRequest,
): DesktopMediaSaveRequest {
  const awemeId = validateAwemeId(value?.awemeId);
  const title = String(value?.title || '知萃视频')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 160) || '知萃视频';
  const mediaUrl = validateSignedMediaUrl(value?.mediaUrl, awemeId, 'media');
  const rawCoverUrl = String(value?.coverUrl || '').trim();
  return {
    awemeId,
    title,
    mediaUrl,
    coverUrl: rawCoverUrl
      ? validateSignedMediaUrl(rawCoverUrl, awemeId, 'cover')
      : undefined,
  };
}
