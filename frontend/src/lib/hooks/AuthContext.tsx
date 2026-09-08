'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { API_BASE } from '@/lib/api';
import { currentClientType } from '@/lib/clientIdentity';
import { shouldDiscardDevelopmentSession } from '@/lib/clientAuthPolicy';
import { clearPendingDesktopLoginApproval } from '@/lib/desktopLogin';
import {
  canUpdateCurrentUser,
  clearStoredSession,
  createSessionEpoch,
  isSessionExpired,
  readCachedUser,
  readStoredToken,
  SESSION_REJECTED_EVENT,
  sessionExpiresAt,
  storedSessionChange,
  TOKEN_STORAGE_KEY,
  writeCachedUser,
  writeStoredSession,
  type AuthUser,
} from '@/lib/authSession';
export type { AuthUser } from '@/lib/authSession';

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  enteringDevelopmentSession: boolean;
  error: string | null;
  enterDevelopmentSession: () => Promise<AuthUser | null>;
  login: (email: string, password: string) => Promise<AuthUser | null>;
  register: (
    email: string,
    password: string,
    username: string,
    consent: { termsVersion: string; privacyVersion: string },
  ) => Promise<AuthUser | null>;
  acceptSession: (session: AuthSession) => AuthUser;
  updateCurrentUser: (expectedToken: string, updatedUser: AuthUser) => boolean;
  logout: () => void;
  clearError: () => void;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

interface AuthResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  detail?: unknown;
  status?: number;
}

const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  loading: true,
  enteringDevelopmentSession: false,
  error: null,
  enterDevelopmentSession: async () => null,
  login: async () => null,
  register: async () => null,
  acceptSession: (session) => session.user,
  updateCurrentUser: () => false,
  logout: () => {},
  clearError: () => {},
});

const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_AUTH_AUTO = IS_DEV && process.env.NEXT_PUBLIC_DEV_AUTH_AUTO === 'true';
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_RESTORE_TIMEOUT_MS = 6_000;
const DEV_SESSION_TIMEOUT_MS = 5_000;
const DEV_SESSION_RETRY_DELAYS_MS = [0, 300, 800] as const;

function wait(delay: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    let timeoutId = 0;
    const handleAbort = () => {
      window.clearTimeout(timeoutId);
      resolve(false);
    };
    timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve(true);
    }, delay);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function resolveAuthError<T>(
  payload: AuthResponse<T> | null,
  status: number,
): string {
  if (payload?.error) return payload.error;
  if (typeof payload?.detail === 'string') return payload.detail;
  if (Array.isArray(payload?.detail)) {
    const messages = payload.detail
      .map((item) => (
        item && typeof item === 'object' && 'msg' in item
          ? String(item.msg)
          : ''
      ))
      .filter(Boolean);
    if (messages.length > 0) return messages.join('；');
  }
  return `请求失败（${status}）`;
}

async function authRequest<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs = AUTH_REQUEST_TIMEOUT_MS,
): Promise<AuthResponse<T>> {
  const controller = new AbortController();
  const upstreamSignal = options.signal;
  let timedOut = false;
  const forwardAbort = () => controller.abort();

  if (upstreamSignal?.aborted) {
    controller.abort();
  } else {
    upstreamSignal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as AuthResponse<T> | null;

    if (!response.ok || !payload?.success) {
      return {
        success: false,
        error: resolveAuthError(payload, response.status),
        status: response.status,
      };
    }
    return payload;
  } catch (requestError) {
    if (timedOut) {
      return {
        success: false,
        error: '连接超时，请检查网络或服务状态后重试',
      };
    }
    if (upstreamSignal?.aborted) {
      return {
        success: false,
        error: '请求已取消',
      };
    }
    return {
      success: false,
      error: requestError instanceof Error ? requestError.message : '网络连接失败',
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
    upstreamSignal?.removeEventListener('abort', forwardAbort);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [enteringDevelopmentSession, setEnteringDevelopmentSession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionEpoch = useRef(createSessionEpoch());
  const currentToken = useRef<string | null>(null);
  const restoringToken = useRef<string | null>(null);

  const clearSession = useCallback((message: string | null = null) => {
    sessionEpoch.current.begin();
    currentToken.current = null;
    clearStoredSession();
    clearPendingDesktopLoginApproval();
    setToken(null);
    setUser(null);
    setError(message);
    setLoading(false);
    setEnteringDevelopmentSession(false);
  }, []);

  const applySession = useCallback((session: AuthSession) => {
    sessionEpoch.current.begin();
    currentToken.current = session.token;
    writeStoredSession(session.token, session.user);
    setToken(session.token);
    setUser(session.user);
    setError(null);
    setLoading(false);
    setEnteringDevelopmentSession(false);
  }, []);

  const acceptSession = useCallback((session: AuthSession) => {
    applySession(session);
    return session.user;
  }, [applySession]);

  // 资料响应只能更新仍然登录的同一账号，不能创建或恢复会话。
  const updateCurrentUser = useCallback((expectedToken: string, updatedUser: AuthUser) => {
    if (!canUpdateCurrentUser(expectedToken, currentToken.current, user?.id, updatedUser.id)) return false;
    writeCachedUser(updatedUser);
    setUser(updatedUser);
    return true;
  }, [user?.id]);

  // 回到应用时重新读取账号资料，使其他设备更换的头像同步到当前端。
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (document.visibilityState === 'hidden' || pending || restoringToken.current === token) return;
      if (currentToken.current !== token) return;
      if (isSessionExpired(token)) {
        clearSession('登录已过期，请重新登录');
        return;
      }
      const epoch = sessionEpoch.current.current();
      pending = true;
      try {
        const response = await authRequest<AuthUser>('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        if (controller.signal.aborted || !sessionEpoch.current.isCurrent(epoch)) return;
        if (response.success && response.data) {
          if (shouldDiscardDevelopmentSession(response.data, {
            desktop: Boolean(window.zhicuiDesktop), development: IS_DEV, automaticDevAuth: DEV_AUTH_AUTO,
          })) { clearSession(); return; }
          writeStoredSession(token, response.data);
          setUser(response.data);
          setError(null);
        } else if (response.status === 401) {
          clearSession('登录已过期，请重新登录');
        }
      } finally { pending = false; }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    let expirationTimer: ReturnType<typeof setTimeout>;
    const checkExpiry = () => {
      if (currentToken.current !== token) return;
      const remaining = sessionExpiresAt(token) - Date.now();
      if (remaining <= 0) { clearSession('登录已过期，请重新登录'); return; }
      expirationTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    };
    checkExpiry();
    return () => {
      controller.abort();
      clearTimeout(expirationTimer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [clearSession, token]);

  useEffect(() => {
    const rejected = (event: Event) => {
      if ((event as CustomEvent<{ token: string }>).detail?.token === currentToken.current) {
        clearSession('登录已过期，请重新登录');
      }
    };
    const stored = (event: StorageEvent) => {
      if (event.key !== TOKEN_STORAGE_KEY && event.key !== null) return;
      const change = storedSessionChange(currentToken.current, readStoredToken());
      if (change === 'clear') clearSession();
      if (change === 'reload') {
        // 别的标签切换账号后，不能让 A 的界面继续使用 B 的请求凭据。
        // 保留新 token，重新走同一启动恢复流程；同 token 不重复刷新。
        sessionEpoch.current.begin();
        currentToken.current = null;
        setUser(null);
        setToken(null);
        setLoading(true);
        window.location.reload();
      }
    };
    window.addEventListener(SESSION_REJECTED_EVENT, rejected);
    window.addEventListener('storage', stored);
    return () => {
      window.removeEventListener(SESSION_REJECTED_EVENT, rejected);
      window.removeEventListener('storage', stored);
    };
  }, [clearSession]);

  const enterDevelopmentSession = useCallback(async () => {
    if (!IS_DEV) {
      setError('开发会话仅在本地开发模式可用');
      return null;
    }

    setError(null);
    const epoch = sessionEpoch.current.begin();
    setLoading(false);
    setEnteringDevelopmentSession(true);
    try {
      const response = await authRequest<AuthSession>('/api/auth/dev-session', {
        method: 'POST',
      }, DEV_SESSION_TIMEOUT_MS);
      if (!sessionEpoch.current.isCurrent(epoch)) return null;
      if (response.success && response.data) {
        applySession(response.data);
        return response.data.user;
      }
      setError(response.error || '开发会话连接失败，请确认本地后端已启动');
      return null;
    } finally {
      if (sessionEpoch.current.isCurrent(epoch)) setEnteringDevelopmentSession(false);
    }
  }, [applySession]);

  // Restore the saved session first. A development build may request a fresh,
  // backend-issued local session if the saved token is missing or invalid.
  // A short bounded retry window covers the common "frontend started first"
  // race without creating an endless request loop.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const epoch = sessionEpoch.current.current();
    const isCurrent = () => !cancelled && sessionEpoch.current.isCurrent(epoch);

    const restore = async () => {
      const saved = readStoredToken();
      if (saved) {
        if (isSessionExpired(saved)) {
          clearSession('登录已过期，请重新登录');
          return;
        }
        restoringToken.current = saved;
        currentToken.current = saved;
        const cachedCandidate = readCachedUser(saved);
        const cached = cachedCandidate && !shouldDiscardDevelopmentSession(cachedCandidate, {
          desktop: Boolean(window.zhicuiDesktop), development: IS_DEV, automaticDevAuth: DEV_AUTH_AUTO,
        }) ? cachedCandidate : null;
        if (cached) {
          setToken(saved);
          setUser(cached);
          setLoading(false);
        }
        const restored = await authRequest<AuthUser>('/api/auth/me', {
          headers: { Authorization: `Bearer ${saved}` },
          signal: controller.signal,
        }, AUTH_RESTORE_TIMEOUT_MS);
        if (!isCurrent()) return;
        if (restored.success && restored.data) {
          if (shouldDiscardDevelopmentSession(restored.data, {
            desktop: typeof window !== 'undefined' && Boolean(window.zhicuiDesktop),
            development: IS_DEV,
            automaticDevAuth: DEV_AUTH_AUTO,
          })) {
            clearSession();
            return;
          }
          applySession({ token: saved, user: restored.data });
          return;
        }

        const sessionRejected = restored.status === 401;
        if (sessionRejected) {
          clearSession('登录已过期，请重新登录');
          return;
        } else {
          // A timeout or temporary server failure is not proof that the saved
          // session is invalid. Keep the token so a retry can recover it.
          setToken(saved);
          setUser(cached);
          setError(restored.error || '暂时无法确认登录状态，请稍后重试');
          return;
        }
      }

      if (DEV_AUTH_AUTO) {
        setEnteringDevelopmentSession(true);
        let lastDevelopmentError = '';
        for (const delay of DEV_SESSION_RETRY_DELAYS_MS) {
          if (delay > 0 && !(await wait(delay, controller.signal))) return;
          if (!isCurrent()) return;

          const development = await authRequest<AuthSession>('/api/auth/dev-session', {
            method: 'POST',
            signal: controller.signal,
          }, DEV_SESSION_TIMEOUT_MS);
          if (!isCurrent()) return;
          if (development.success && development.data) {
            applySession(development.data);
            return;
          }
          lastDevelopmentError = development.error || '';
        }

        if (isCurrent()) {
          setError(
            lastDevelopmentError
              || '开发会话连接失败，请确认本地后端已启动后重试',
          );
        }
      }
    };

    void restore()
      .catch((restoreError) => {
        if (isCurrent()) {
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : '登录状态恢复失败，请重试',
          );
        }
      })
      .finally(() => {
        restoringToken.current = null;
        if (isCurrent()) {
          setEnteringDevelopmentSession(false);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [applySession, clearSession]);

  // 桌面端联动登录：主进程在网页登录完成后把 JWT 会话回填给渲染进程。
  useEffect(() => {
    const bridge = typeof window !== 'undefined'
      ? window.zhicuiDesktop
      : undefined;
    if (!bridge || typeof bridge.onZhicuiSession !== 'function') return;
    const unsubscribe = bridge.onZhicuiSession((session) => {
      if (!session?.token) return;
      applySession({
        token: session.token,
        user: {
          id: session.user?.id || '',
          email: session.user?.email || '',
          username: session.user?.username ?? null,
          is_active: session.user?.is_active ?? true,
          is_admin: session.user?.is_admin ?? false,
          agent_profile_key: session.user?.agent_profile_key || undefined,
          email_verified: false,
          created_at: '',
        },
      });
    });
    return unsubscribe;
  }, [applySession]);

  // 将本机 Agent 桥固定绑定到桌面端当前登录的知萃账号。主进程会在
  // 账号切换或退出时旋转桥接凭证，因此本机调用方不能自行选择另一
  // 个 profileKey 去读取或清理其他知萃账号的平台会话。
  useEffect(() => {
    const bridge = typeof window !== 'undefined'
      ? window.zhicuiDesktop
      : undefined;
    if (!bridge || typeof bridge.bindAgentUser !== 'function') return;
    void bridge.bindAgentUser(user?.agent_profile_key || null).catch(() => {
      // 桥接不可用不影响 Web 会话；Agent doctor 会给出结构化诊断。
    });
  }, [user?.agent_profile_key]);

  const login = useCallback(async (email: string, password: string) => {
    const epoch = sessionEpoch.current.begin();
    setLoading(false);
    setError(null);
    const response = await authRequest<AuthSession>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!sessionEpoch.current.isCurrent(epoch)) return null;
    if (response.success && response.data) {
      applySession(response.data);
      return response.data.user;
    }
    setError(response.error || '登录失败');
    return null;
  }, [applySession]);

  const register = useCallback(async (
    email: string,
    password: string,
    username: string,
    consent: { termsVersion: string; privacyVersion: string },
  ) => {
    const epoch = sessionEpoch.current.begin();
    setLoading(false);
    setError(null);
    const response = await authRequest<AuthSession>('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        username,
        accepted_terms: true,
        accepted_privacy: true,
        terms_version: consent.termsVersion,
        privacy_version: consent.privacyVersion,
        client_type: await currentClientType(),
      }),
    });
    if (!sessionEpoch.current.isCurrent(epoch)) return null;
    if (response.success && response.data) {
      applySession(response.data);
      return response.data.user;
    }
    setError(response.error || '注册失败');
    return null;
  }, [applySession]);

  const logout = useCallback(() => {
    clearSession();
  }, [clearSession]);

  const clearError = useCallback(() => setError(null), []);
  const contextValue = useMemo<AuthState>(() => ({
    user,
    token,
    loading,
    enteringDevelopmentSession,
    error,
    enterDevelopmentSession,
    login,
    register,
    acceptSession,
    updateCurrentUser,
    logout,
    clearError,
  }), [
    acceptSession,
    updateCurrentUser,
    clearError,
    enterDevelopmentSession,
    enteringDevelopmentSession,
    error,
    loading,
    login,
    logout,
    register,
    token,
    user,
  ]);

  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
