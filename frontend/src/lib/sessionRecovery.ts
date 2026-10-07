import { Capacitor } from '@capacitor/core';
import { readStoredToken, sessionExpiresAt, writeStoredSession, sessionStorageEpoch, type AuthUser } from './authSession';

export const SESSION_UPDATED_EVENT = 'zhicui:session-updated';
export interface RecoveredSession { token: string; user: AuthUser }
export class SessionRecoveryError extends Error {
  constructor(message: string, readonly rejected = false) { super(message); }
}
const api = () => process.env.NEXT_PUBLIC_API_URL || '';
let pending: Promise<RecoveredSession | null> | null = null;
const requestKey = 'zhicui:session-refresh-request:v2';
const logoutKey = 'zhicui:session-logged-out:v2';
export function markExplicitLogin(): void { window.localStorage.removeItem(logoutKey); }

async function post(path: string, token?: string | null): Promise<RecoveredSession> {
  let requestId = window.localStorage.getItem(requestKey);
  if (!requestId) {
    requestId = crypto.randomUUID();
    window.localStorage.setItem(requestKey, requestId);
  }
  const response = await fetch(`${api()}${path}`, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-Zhicui-Session-Version': '2',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ request_id: requestId }), signal: AbortSignal.timeout(12_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success || !payload.data?.token) {
    throw new SessionRecoveryError(payload?.detail?.message || payload?.error || '登录连接暂时不可用', response.status === 401);
  }
  window.localStorage.removeItem(requestKey);
  return payload.data;
}

/** 同一页面共用 Promise，同源标签页共用 Web Lock；网络错误不清凭据。 */
export function recoverSession(force = false): Promise<RecoveredSession | null> {
  if (pending) return pending;
  const operation = async (): Promise<RecoveredSession | null> => {
    if (window.localStorage.getItem(logoutKey)) {
      void revokeSession(null).catch(() => undefined);
      throw new SessionRecoveryError('已退出登录', true);
    }
    const expected = readStoredToken();
    const epoch = sessionStorageEpoch();
    let result: RecoveredSession | null = null;
    const bridge = window.zhicuiDesktop;
    if (bridge?.restoreAuthSession) {
      try {
        result = await bridge.restoreAuthSession(force) as RecoveredSession | null;
        if (!result && expected && sessionExpiresAt(expected) > Date.now()) {
          result = await bridge.adoptAuthSession!(expected) as RecoveredSession;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : '客户端连接暂时不可用';
        throw new SessionRecoveryError(message, /SESSION_(EXPIRED|REVOKED|INVALID|REFRESH_REUSED)|ACCOUNT_DISABLED/.test(message));
      }
      if (!result) throw new SessionRecoveryError('请确认一次知萃登录，之后会自动恢复', true);
    } else if (Capacitor.isNativePlatform()) {
      // 旧 Android/iOS WebView 不共享同站 Cookie，保持原有 JWT 兼容路径。
      if (!expected) throw new SessionRecoveryError('请先登录知萃', true);
      const response = await fetch(`${api()}/api/auth/me`, { headers: { Authorization: `Bearer ${expected}` }, signal: AbortSignal.timeout(12_000) });
      if (response.status === 401) throw new SessionRecoveryError('知萃登录需要重新验证', true);
      const value = await response.json();
      if (!response.ok || !value.success) throw new SessionRecoveryError('暂时无法确认登录状态');
      result = { token: expected, user: value.data };
    } else {
      if (!force && !window.localStorage.getItem(requestKey) && expected && sessionExpiresAt(expected) > Date.now() + 60_000) {
        const claims = JSON.parse(atob(expected.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (!claims.sid) result = await post('/api/auth/session/migrate', expected);
        else {
          const response = await fetch(`${api()}/api/auth/me`, { headers: { Authorization: `Bearer ${expected}` }, signal: AbortSignal.timeout(12_000) });
          if (response.status !== 401) {
            const value = await response.json();
            if (!response.ok || !value.success) throw new SessionRecoveryError('暂时无法确认登录状态');
            result = { token: expected, user: value.data };
          }
        }
      }
      if (!result) {
        try { result = await post('/api/auth/refresh'); }
        catch (error) {
          if (!(error instanceof SessionRecoveryError) || !error.rejected || !expected || sessionExpiresAt(expected) <= Date.now()) throw error;
          result = await post('/api/auth/session/migrate', expected);
        }
      }
    }
    if (sessionStorageEpoch() !== epoch || readStoredToken() !== expected) throw new SessionRecoveryError('登录状态已改变，已忽略旧恢复结果');
    writeStoredSession(result.token, result.user);
    window.dispatchEvent(new CustomEvent(SESSION_UPDATED_EVENT, { detail: result }));
    return result;
  };
  pending = (async () => typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request('zhicui-session-refresh', operation) : await operation())().finally(() => { pending = null; });
  return pending;
}

export async function persistDesktopSession(token: string): Promise<void> {
  markExplicitLogin();
  if (!window.zhicuiDesktop?.adoptAuthSession) {
    await recoverSession();
    return;
  }
  const expected = readStoredToken();
  const epoch = sessionStorageEpoch();
  const value = await window.zhicuiDesktop.adoptAuthSession(token) as RecoveredSession;
  if (epoch !== sessionStorageEpoch() || expected !== readStoredToken()) return;
  writeStoredSession(value.token, value.user);
  window.dispatchEvent(new CustomEvent(SESSION_UPDATED_EVENT, { detail: value }));
}

export async function revokeSession(token: string | null): Promise<void> {
  // 离线退出后不能因 HttpOnly Cookie 尚未撤销而自动复活。
  window.localStorage.setItem(logoutKey, '1');
  if (window.zhicuiDesktop?.logoutAuthSession) {
    await window.zhicuiDesktop.logoutAuthSession();
    return;
  }
  await fetch(`${api()}/api/auth/logout`, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ request_id: crypto.randomUUID() }), signal: AbortSignal.timeout(10_000) });
}
