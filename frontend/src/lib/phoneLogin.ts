import type { DesktopLoginAuthSession } from './desktopLogin';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
export interface PhoneLoginReference { sessionId: string; scanSecret: string }
export interface PhoneLoginState {
  session_id: string;
  status: 'pending' | 'scanned' | 'approved' | 'consumed' | 'cancelled' | 'expired' | 'slow_down' | 'account_unavailable';
  expires_at: string;
  verification_code: string | null;
  client_type: 'android' | 'ios' | null;
  qr_url?: string;
}
export type PhoneLoginToken = PhoneLoginState | ({ status: 'success' } & DesktopLoginAuthSession);

export function parsePhoneLoginQr(raw: string): PhoneLoginReference | null {
  try {
    const url = new URL(raw.trim());
    if (url.origin !== 'https://luxai.cn' || url.pathname !== '/login' || url.search || url.username || url.password) return null;
    const match = /^#phone-login=(pls-[a-f0-9]{32})\.([A-Za-z0-9_-]{43})$/.exec(url.hash);
    return match ? { sessionId: match[1], scanSecret: match[2] } : null;
  } catch { return null; }
}

export function createPhoneClaimSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function phoneLoginRequest<T = PhoneLoginState>(
  suffix: string, body: Record<string, unknown> = {}, authenticated = false, signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authenticated) {
    const token = window.localStorage.getItem('zhicui_token');
    if (!token) throw new Error('请先在电脑上登录');
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}/api/auth/phone-login/sessions${suffix}`, {
    method: 'POST', body: JSON.stringify(body), headers, cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) throw new Error(
    typeof payload?.error === 'string' ? payload.error : '连接失败，请稍后重试',
  );
  return payload.data as T;
}

export function phoneLoginStatusText(status: PhoneLoginState['status']): string {
  switch (status) {
    case 'pending': return '用手机登录页的扫码功能扫描';
    case 'scanned': return '请在电脑上确认登录';
    case 'approved': return '已确认，等待手机登录';
    case 'consumed': return '手机已登录';
    case 'cancelled': return '已取消，请重新扫码';
    case 'expired': return '二维码已过期，请重新生成';
    case 'account_unavailable': return '账号当前不可用';
    default: return '正在等待确认';
  }
}
