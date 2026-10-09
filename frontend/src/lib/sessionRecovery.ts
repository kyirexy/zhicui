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
interface DesktopLogoutIntent {
  version: 1;
  kind: 'desktop';
  requestId: string;
  sessionId: string | null;
  state: 'pending' | 'confirmed';
}

function tokenSessionId(token: string | null): string | null {
  try {
    const encoded = token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    return typeof claims.sid === 'string' && claims.sid ? claims.sid : null;
  } catch { return null; }
}

function desktopLogoutIntent(raw: string | null): DesktopLogoutIntent | null {
  try {
    const value = JSON.parse(raw || 'null');
    return value?.version === 1 && value.kind === 'desktop' && typeof value.requestId === 'string'
      && (value.sessionId === null || typeof value.sessionId === 'string')
      && (value.state === 'pending' || value.state === 'confirmed') ? value : null;
  } catch { return null; }
}

function confirmDesktopLogout(raw: string, intent: DesktopLogoutIntent): void {
  if (window.localStorage.getItem(logoutKey) === raw) {
    window.localStorage.setItem(logoutKey, JSON.stringify({ ...intent, state: 'confirmed' }));
  }
}

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
    const bridge = window.zhicuiDesktop;
    const logout = window.localStorage.getItem(logoutKey);
    // Web Cookie 的离线退出仍由页面阻止；桌面退出事实由主进程保管。
    if (logout && !bridge?.restoreAuthSession) {
      void revokeSession(null).catch(() => undefined);
      throw new SessionRecoveryError('已退出登录', true);
    }
    const expected = readStoredToken();
    const epoch = sessionStorageEpoch();
    let result: RecoveredSession | null = null;
    if (bridge?.restoreAuthSession) {
      try {
        result = await bridge.restoreAuthSession(force) as RecoveredSession | null;
        // 恢复期间的新登录/退出不能被旧快照覆盖，更不能发出旧退出请求。
        if (sessionStorageEpoch() !== epoch || readStoredToken() !== expected
          || window.localStorage.getItem(logoutKey) !== logout) {
          throw new SessionRecoveryError('登录状态已改变，已忽略旧恢复结果');
        }
        if (logout) {
          const intent = desktopLogoutIntent(logout);
          const sameSession = Boolean(intent?.sessionId) && intent!.sessionId === tokenSessionId(result?.token || null);
          // IPC 未确认的主动退出只重试原会话；主进程再校验 sid，防止交接竞态。
          if (result && intent && (sameSession || (!intent.sessionId && intent.state === 'pending'))) {
            if (sameSession && intent.state === 'pending' && bridge.logoutAuthSession) {
              if (bridge.supportsConditionalAuthLogout !== true) {
                throw new SessionRecoveryError('退出确认尚未完成，请更新知萃客户端后恢复连接', true);
              }
              await bridge.logoutAuthSession(intent.sessionId!);
              confirmDesktopLogout(logout, intent);
            }
            throw new SessionRecoveryError('已退出登录', true);
          }
          // 旧版“1”没有会话归属，不能据此撤销主进程的新会话。
          // 主进程确实无会话时也不重新迁移页面留下的旧 token。
          if (!result) throw new SessionRecoveryError('已退出登录', true);
          if (window.localStorage.getItem(logoutKey) === logout) markExplicitLogin();
        }
        if (!result && !logout && expected && sessionExpiresAt(expected) > Date.now()) {
          result = await bridge.adoptAuthSession!(expected) as RecoveredSession;
        }
      } catch (error) {
        if (error instanceof SessionRecoveryError) throw error;
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
        // 已发出的迁移可能只丢了回包；过期JWT仍可用原request_id领取已有回执。
        const hadPendingRequest = Boolean(window.localStorage.getItem(requestKey));
        try { result = await post('/api/auth/refresh'); }
        catch (error) {
          if (!(error instanceof SessionRecoveryError) || !error.rejected || !expected
            || (sessionExpiresAt(expected) <= Date.now() && !hadPendingRequest)) throw error;
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
  if (window.zhicuiDesktop?.logoutAuthSession) {
    // 只保存会话标识，不保存 JWT；IPC 失败后仍能针对原会话补偿退出。
    const intent: DesktopLogoutIntent = { version: 1, kind: 'desktop', requestId: crypto.randomUUID(),
      sessionId: tokenSessionId(token), state: 'pending' };
    const raw = JSON.stringify(intent);
    window.localStorage.setItem(logoutKey, raw);
    await window.zhicuiDesktop.logoutAuthSession();
    confirmDesktopLogout(raw, intent);
    return;
  }
  // 离线退出后不能因 HttpOnly Cookie 尚未撤销而自动复活。
  window.localStorage.setItem(logoutKey, '1');
  await fetch(`${api()}/api/auth/logout`, { method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ request_id: crypto.randomUUID() }), signal: AbortSignal.timeout(10_000) });
}
