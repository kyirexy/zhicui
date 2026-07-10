'use client';

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';

interface AuthUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<AuthUser | null>;
  register: (email: string, password: string, username: string) => Promise<AuthUser | null>;
  logout: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  loading: true,
  error: null,
  login: async () => null,
  register: async () => null,
  logout: () => {},
  clearError: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session on mount
  useEffect(() => {
    const saved = localStorage.getItem('zhicui_token');
    if (saved) {
      setToken(saved);
      fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${saved}` },
      })
        .then(r => r.json())
        .then(d => {
          if (d.success) setUser(d.data);
          else {
            localStorage.removeItem('zhicui_token');
            setToken(null);
          }
        })
        .catch(() => {
          localStorage.removeItem('zhicui_token');
          setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const d = await res.json();
    if (d.success) {
      localStorage.setItem('zhicui_token', d.data.token);
      setToken(d.data.token);
      setUser(d.data.user);
      return d.data.user;
    }
    setError(d.error || d.detail || '登录失败');
    return null;
  }, []);

  const register = useCallback(async (email: string, password: string, username: string) => {
    setError(null);
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username }),
    });
    const d = await res.json();
    if (d.success) {
      localStorage.setItem('zhicui_token', d.data.token);
      setToken(d.data.token);
      setUser(d.data.user);
      return d.data.user;
    }
    setError(d.error || d.detail || '注册失败');
    return null;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('zhicui_token');
    setToken(null);
    setUser(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider value={{ user, token, loading, error, login, register, logout, clearError }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
