/** 本地缓存只用于恢复界面；身份与权限始终由服务端验证 JWT。 */
export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  avatar_id?: string | null;
  is_active: boolean;
  is_admin: boolean;
  email_verified: boolean;
  agent_profile_key?: string;
  created_at: string;
}

export const TOKEN_STORAGE_KEY = 'zhicui_token';
export const USER_STORAGE_KEY = 'zhicui_auth_user:v1';
export const SESSION_REJECTED_EVENT = 'zhicui:session-rejected';
type SessionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): SessionStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

function tokenClaims(token: string): { sub: string; exp: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const value = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(value.padEnd(Math.ceil(value.length / 4) * 4, '=')));
    return typeof claims?.sub === 'string' && typeof claims?.exp === 'number'
      && Number.isFinite(claims.exp) ? { sub: claims.sub, exp: claims.exp } : null;
  } catch { return null; }
}

export function sessionExpiresAt(token: string): number {
  return (tokenClaims(token)?.exp ?? 0) * 1000;
}

export function isSessionExpired(token: string, now = Date.now()): boolean {
  return sessionExpiresAt(token) <= now;
}

export function readStoredToken(storage = browserStorage()): string | null {
  try { return storage?.getItem(TOKEN_STORAGE_KEY) || null; }
  catch { return null; }
}

export function readCachedUser(token: string, storage = browserStorage()): AuthUser | null {
  if (isSessionExpired(token)) return null;
  try {
    const value = JSON.parse(storage?.getItem(USER_STORAGE_KEY) || 'null');
    const user = value?.user;
    if (value?.version !== 1 || user?.id !== tokenClaims(token)?.sub
      || typeof user?.email !== 'string' || !user.is_active) return null;
    // 不从离线缓存恢复管理员权限或本机 Agent 绑定，等 /me 在线确认。
    return { ...user, is_admin: false, agent_profile_key: undefined };
  } catch { return null; }
}

export function writeStoredSession(token: string, user: AuthUser, storage = browserStorage()): void {
  try { storage?.setItem(TOKEN_STORAGE_KEY, token); } catch { /* 存储受限时保留内存会话。 */ }
  writeCachedUser(user, storage);
}

export function writeCachedUser(user: AuthUser, storage = browserStorage()): void {
  try {
    storage?.setItem(USER_STORAGE_KEY, JSON.stringify({
      version: 1,
      user: {
        id: user.id, email: user.email, username: user.username,
        avatar_id: user.avatar_id, is_active: user.is_active,
        email_verified: user.email_verified, created_at: user.created_at,
      },
    }));
  } catch { /* 不保存密码、完整响应或第二份 token。 */ }
}

export function clearStoredSession(storage = browserStorage()): void {
  for (const key of [TOKEN_STORAGE_KEY, USER_STORAGE_KEY]) {
    try { storage?.removeItem(key); } catch { /* 内存会话仍会立即清理。 */ }
  }
}

/** 每次登录、退出或接受扫码结果都使旧异步任务失效。 */
export function createSessionEpoch() {
  let current = 0;
  return {
    begin: () => ++current,
    current: () => current,
    isCurrent: (epoch: number) => epoch === current,
  };
}

export function isCurrentSessionRejected(status: number, requested: string | null, current: string | null): boolean {
  // 403 通常只是没有管理/操作权限，不等于登录失效。
  return status === 401 && Boolean(requested) && requested === current;
}

export function storedSessionChange(current: string | null, saved: string | null): 'none' | 'clear' | 'reload' {
  if (current === saved) return 'none';
  return saved ? 'reload' : 'clear';
}

export function canUpdateCurrentUser(
  expectedToken: string,
  currentToken: string | null,
  currentUserId: string | undefined,
  updatedUserId: string,
): boolean {
  return Boolean(expectedToken) && expectedToken === currentToken
    && Boolean(currentUserId) && currentUserId === updatedUserId;
}

/** 只处理本应用显式携带的 JWT；旧账号的迟到 401 不影响新会话。 */
export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const authorization = headers.get('Authorization');
  const requested = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  const response = await fetch(input, init);
  if (typeof window !== 'undefined'
    && isCurrentSessionRejected(response.status, requested, readStoredToken())) {
    clearStoredSession();
    window.dispatchEvent(new CustomEvent(SESSION_REJECTED_EVENT, { detail: { token: requested } }));
  }
  return response;
}
