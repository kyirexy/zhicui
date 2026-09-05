'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { API_BASE } from '@/lib/api';
import { Capacitor } from '@capacitor/core';
import { shouldDiscardDevelopmentSession } from '@/lib/clientAuthPolicy';

export interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  email_verified: boolean;
  agent_profile_key?: string;
  created_at: string;
}

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
  logout: () => {},
  clearError: () => {},
});

const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_AUTH_AUTO = IS_DEV && process.env.NEXT_PUBLIC_DEV_AUTH_AUTO === 'true';
const TOKEN_STORAGE_KEY = 'zhicui_token';
const AUTH_REQUEST_TIMEOUT_MS = 10_000;
const AUTH_RESTORE_TIMEOUT_MS = 6_000;
const DEV_SESSION_TIMEOUT_MS = 5_000;
const DEV_SESSION_RETRY_DELAYS_MS = [0, 300, 800] as const;

function currentClientType(): 'web' | 'windows' | 'android' | 'ios' {
  if (typeof window === 'undefined') return 'web';
  if (window.zhicuiDesktop) return 'windows';
  const platform = Capacitor.getPlatform();
  return Capacitor.isNativePlatform() && (platform === 'ios' || platform === 'android')
    ? platform : 'web';
}

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

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // The in-memory session still works when browser storage is unavailable.
  }
}

function removeStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage may be disabled; state cleanup below remains authoritative.
  }
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

  const applySession = useCallback((session: AuthSession) => {
    writeStoredToken(session.token);
    setToken(session.token);
    setUser(session.user);
    setError(null);
  }, []);

  const acceptSession = useCallback((session: AuthSession) => {
    applySession(session);
    return session.user;
  }, [applySession]);

  const enterDevelopmentSession = useCallback(async () => {
    if (!IS_DEV) {
      setError('开发会话仅在本地开发模式可用');
      return null;
    }

    setError(null);
    setEnteringDevelopmentSession(true);
    try {
      const response = await authRequest<AuthSession>('/api/auth/dev-session', {
        method: 'POST',
      }, DEV_SESSION_TIMEOUT_MS);
      if (response.success && response.data) {
        applySession(response.data);
        return response.data.user;
      }
      setError(response.error || '开发会话连接失败，请确认本地后端已启动');
      return null;
    } finally {
      setEnteringDevelopmentSession(false);
    }
  }, [applySession]);

  // Restore the saved session first. A development build may request a fresh,
  // backend-issued local session if the saved token is missing or invalid.
  // A short bounded retry window covers the common "frontend started first"
  // race without creating an endless request loop.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const restore = async () => {
      const saved = readStoredToken();
      if (saved) {
        const restored = await authRequest<AuthUser>('/api/auth/me', {
          headers: { Authorization: `Bearer ${saved}` },
          signal: controller.signal,
        }, AUTH_RESTORE_TIMEOUT_MS);
        if (cancelled) return;
        if (restored.success && restored.data) {
          if (shouldDiscardDevelopmentSession(restored.data, {
            desktop: typeof window !== 'undefined' && Boolean(window.zhicuiDesktop),
            development: IS_DEV,
            automaticDevAuth: DEV_AUTH_AUTO,
          })) {
            removeStoredToken();
            setToken(null);
            setUser(null);
            setError(null);
            return;
          }
          applySession({ token: saved, user: restored.data });
          return;
        }

        const sessionRejected = restored.status === 401 || restored.status === 403;
        if (sessionRejected) {
          removeStoredToken();
          setToken(null);
          setUser(null);
          setError('登录已过期，请重新登录');
        } else {
          // A timeout or temporary server failure is not proof that the saved
          // session is invalid. Keep the token so a retry can recover it.
          setToken(saved);
          setUser(null);
          setError(restored.error || '暂时无法确认登录状态，请稍后重试');
        }
      }

      if (DEV_AUTH_AUTO) {
        setEnteringDevelopmentSession(true);
        let lastDevelopmentError = '';
        for (const delay of DEV_SESSION_RETRY_DELAYS_MS) {
          if (delay > 0 && !(await wait(delay, controller.signal))) return;
          if (cancelled) return;

          const development = await authRequest<AuthSession>('/api/auth/dev-session', {
            method: 'POST',
            signal: controller.signal,
          }, DEV_SESSION_TIMEOUT_MS);
          if (cancelled) return;
          if (development.success && development.data) {
            applySession(development.data);
            return;
          }
          lastDevelopmentError = development.error || '';
        }

        if (!cancelled) {
          setError(
            lastDevelopmentError
              || '开发会话连接失败，请确认本地后端已启动后重试',
          );
        }
      }
    };

    void restore()
      .catch((restoreError) => {
        if (!cancelled) {
          setError(
            restoreError instanceof Error
              ? restoreError.message
              : '登录状态恢复失败，请重试',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setEnteringDevelopmentSession(false);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [applySession]);

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
    setError(null);
    const response = await authRequest<AuthSession>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
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
        client_type: currentClientType(),
      }),
    });
    if (response.success && response.data) {
      applySession(response.data);
      return response.data.user;
    }
    setError(response.error || '注册失败');
    return null;
  }, [applySession]);

  const logout = useCallback(() => {
    removeStoredToken();
    setToken(null);
    setUser(null);
    setError(null);
  }, []);

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
    logout,
    clearError,
  }), [
    acceptSession,
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
