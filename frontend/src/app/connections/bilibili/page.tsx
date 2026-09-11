'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import AuthGuard from '@/components/AuthGuard';
import { useAuth } from '@/lib/hooks/AuthContext';
import { API_BASE } from '@/lib/api';

type Binding = {
  status: string; connected: boolean; display_name?: string; platform_user_id?: string;
  session_id?: string; qr_url?: string; scan_confirmed?: boolean; expires_at?: string;
};

function Connection({ token, username }: { token: string; username: string }) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const epoch = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const requestedSession = useRef('');

  const request = useCallback(async (method: string, suffix = '', body?: object) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${API_BASE}/api/platform-connections/bilibili${suffix}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: controller.signal, cache: 'no-store',
      });
      const value = await response.json();
      if (!response.ok || !value.success) throw new Error(value.error || '连接暂时不可用，请稍后重试');
      return value.data as Binding;
    } finally {
      window.clearTimeout(timeout);
      controllers.current.delete(controller);
    }
  }, [token]);

  useEffect(() => {
    const current = ++epoch.current;
    const activeControllers = controllers.current;
    requestedSession.current = new URLSearchParams(window.location.search).get('session') || '';
    void request('GET').then((value) => {
      if (current !== epoch.current) return;
      setBinding(value);
      if (requestedSession.current && value.session_id !== requestedSession.current) {
        setMismatch(true);
        setError('此授权入口不属于当前账号，或已失效。请登录与 CLI 相同的知萃账号，或从 CLI 重新发起绑定。');
      }
    }).catch((reason: Error) => { if (current === epoch.current) setError(reason.message); });
    return () => { epoch.current += 1; activeControllers.forEach((controller) => controller.abort()); };
  }, [request]);

  useEffect(() => {
    if (!binding?.qr_url || binding.status !== 'pending' || !binding.session_id || error) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = epoch.current;
    const sessionId = binding.session_id;
    const poll = async () => {
      try {
        const value = await request('POST', '/login/poll', { session_id: sessionId });
        if (cancelled || current !== epoch.current) return;
        setBinding((previous) => value.status === 'pending' ? { ...previous, ...value } : value);
        if (value.status === 'pending') timer = setTimeout(poll, 3000);
      } catch (reason) {
        if (!cancelled && current === epoch.current) setError(reason instanceof Error ? reason.message : '查询授权进度失败');
      }
    };
    timer = setTimeout(poll, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [binding?.qr_url, binding?.session_id, binding?.status, error, request]);

  const act = async (disconnect = false) => {
    if (disconnect && !window.confirm('断开当前知萃账号的 B站绑定？已保存资料会保留。')) return;
    const current = ++epoch.current;
    controllers.current.forEach((controller) => controller.abort());
    setBusy(true); setError('');
    setBinding((previous) => previous ? { ...previous, qr_url: undefined } : null);
    try {
      const value = await request(disconnect ? 'DELETE' : 'POST', disconnect ? '' : '/login');
      if (current === epoch.current) setBinding(value);
    } catch (reason) {
      if (current === epoch.current) setError(reason instanceof Error ? reason.message : '平台连接失败');
    } finally {
      if (current === epoch.current) setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-lg px-5 py-12">
      <h1 className="text-2xl font-semibold text-foreground">绑定 B站账号</h1>
      <p className="mt-3 text-sm leading-6 text-foreground-secondary">当前知萃账号：{username}。请用 B站 App 扫码并确认，将自己的账号连接到知萃。</p>
      <section className="glass-card mt-6 rounded-2xl p-6">
        {binding?.connected ? <div role="status"><p className="font-medium">已绑定 {binding.display_name || 'B站用户'}</p><p className="mt-2 text-sm text-foreground-secondary">现在可以返回 CLI 发起同步。平台验证或登录失效时，需要重新连接。</p></div> : <>
          <p role="status">{busy ? '正在处理…' : binding?.status === 'expired' ? '二维码或授权已过期，请重新连接' : binding?.scan_confirmed ? '已扫码，请在 B站 App 确认' : binding?.qr_url ? '使用 B站 App 扫描二维码' : '尚未绑定 B站账号'}</p>
          {binding?.qr_url && binding.status === 'pending' && <div className="mx-auto mt-5 w-fit rounded-xl bg-white p-4"><QRCodeSVG value={binding.qr_url} size={216} level="M" title="B站官方授权二维码" /></div>}
        </>}
        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
        {!mismatch && <div className="mt-6 flex flex-wrap gap-3">
          {!binding?.connected && <button className="btn-primary min-h-[44px] px-5" disabled={busy} onClick={() => void act()}>{binding?.qr_url ? '重新查询授权' : '获取官方二维码'}</button>}
          {(binding?.connected || binding?.status === 'pending') && <button className="min-h-[44px] rounded-xl border border-card-border px-5 text-sm" disabled={busy} onClick={() => void act(true)}>{binding.connected ? '断开绑定' : '取消授权'}</button>}
        </div>}
      </section>
      <p className="mt-5 text-xs leading-6 text-foreground-secondary">授权仅供当前知萃账号使用，可随时断开。知萃不会索取你的 B站密码；断开不会删除已保存的资料。</p>
    </main>
  );
}

export default function BilibiliConnectionPage() {
  const { token, user } = useAuth();
  return <AuthGuard>{token && user && <Connection key={user.id} token={token} username={user.username || user.email} />}</AuthGuard>;
}
