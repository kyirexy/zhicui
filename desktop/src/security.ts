import type { IpcMainInvokeEvent } from 'electron';
import type { DesktopLoginRequest } from './contract';

const PRODUCTION_ORIGIN = 'https://luxai.cn';
const DEVELOPMENT_ORIGIN = 'http://localhost:3003';
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
