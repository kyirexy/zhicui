'use client';

import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Smartphone } from 'lucide-react';
import { phoneLoginRequest, phoneLoginStatusText, type PhoneLoginState } from '@/lib/phoneLogin';
import { useAuth } from '@/lib/hooks/AuthContext';
import styles from './PhoneQrLogin.module.css';

export default function DesktopPhoneLoginCard() {
  const { user } = useAuth();
  const [session, setSession] = useState<PhoneLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const sessionRef = useRef<PhoneLoginState | null>(null);
  const sessionId = session?.session_id;
  const status = session?.status;

  useEffect(() => {
    return () => {
      generation.current += 1;
      const current = sessionRef.current;
      if (current && ['pending', 'scanned', 'approved'].includes(current.status)) {
        void phoneLoginRequest(`/${current.session_id}/decision`, { decision: 'cancel' }, true).catch(() => undefined);
      }
    };
  }, [user?.id]);

  useEffect(() => {
    if (!sessionId || !status || !['pending', 'scanned', 'approved'].includes(status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const next = await phoneLoginRequest(`/${sessionId}/status`, {}, true, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        setError('');
        sessionRef.current = next;
        setSession((previous) => previous?.session_id === sessionId ? { ...previous, ...next } : previous);
        if (!['pending', 'scanned', 'approved'].includes(next.status)) return;
      } catch {
        if (controller.signal.aborted) return;
        setError('连接暂时中断，请检查网络');
        if (++failures >= 3) return;
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, status]);

  const create = async () => {
    if (busy) return;
    const currentGeneration = ++generation.current;
    setBusy(true); setError(''); setSession(null);
    try {
      const created = await phoneLoginRequest('', {}, true);
      if (currentGeneration !== generation.current) {
        void phoneLoginRequest(`/${created.session_id}/decision`, { decision: 'cancel' }, true).catch(() => undefined);
        return;
      }
      sessionRef.current = created; setSession(created);
    } catch (cause) {
      if (currentGeneration === generation.current) setError(cause instanceof Error ? cause.message : '二维码创建失败');
    } finally { if (currentGeneration === generation.current) setBusy(false); }
  };

  const decide = async (decision: 'approve' | 'cancel') => {
    if (!session || busy) return;
    const currentGeneration = generation.current;
    setBusy(true); setError('');
    try {
      const next = await phoneLoginRequest(`/${session.session_id}/decision`, {
        decision, verification_code: session.verification_code || '',
      }, true);
      if (currentGeneration !== generation.current) return;
      sessionRef.current = next; setSession(next);
    } catch (cause) {
      if (currentGeneration === generation.current) setError(cause instanceof Error ? cause.message : '操作失败');
    } finally { if (currentGeneration === generation.current) setBusy(false); }
  };

  return <section className={styles.card} aria-label="登录手机">
    <div className={styles.heading}><Smartphone size={20} aria-hidden="true" />登录手机</div>
    <p>手机扫码，使用当前账号{user?.username ? ` ${user.username}` : ''}登录。</p>
    {session?.status === 'pending' && session.qr_url ? <div className={styles.qr}>
      <QRCodeSVG value={session.qr_url} size={192} marginSize={2} title="手机登录二维码" />
    </div> : null}
    {session ? <p role="status">{phoneLoginStatusText(session.status)}</p> : null}
    {session?.status === 'scanned' ? <>
      <strong className={styles.code}>{session.verification_code}</strong>
      <p>确认与你手机显示的四位数字一致，再允许登录。</p>
    </> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <div className={styles.actions}>
      {session?.status === 'scanned' ? <button className={styles.primary} disabled={busy} onClick={() => void decide('approve')}>确认登录这台手机</button> : null}
      {session && ['pending', 'scanned', 'approved'].includes(session.status)
        ? <button disabled={busy} onClick={() => void decide('cancel')}>取消</button>
        : <button className={styles.primary} disabled={busy} onClick={() => void create()}>{busy ? '正在生成…' : session ? '重新生成二维码' : '显示登录二维码'}</button>}
    </div>
  </section>;
}
