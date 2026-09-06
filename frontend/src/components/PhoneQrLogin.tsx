'use client';

import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import MobileDesktopLoginScanner from './MobileDesktopLoginScanner';
import { createPhoneClaimSecret, phoneLoginRequest, phoneLoginStatusText, type PhoneLoginReference, type PhoneLoginState, type PhoneLoginToken } from '@/lib/phoneLogin';
import type { DesktopLoginAuthSession } from '@/lib/desktopLogin';
import styles from './PhoneQrLogin.module.css';

export default function PhoneQrLogin({ onSession }: { onSession: (session: DesktopLoginAuthSession) => void }) {
  const [pending, setPending] = useState<(PhoneLoginState & { claimSecret: string }) | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const onSessionRef = useRef(onSession);
  useEffect(() => { onSessionRef.current = onSession; }, [onSession]);
  useEffect(() => () => { generation.current += 1; }, []);

  const scan = async (reference: PhoneLoginReference) => {
    const attempt = ++generation.current;
    const claimSecret = createPhoneClaimSecret();
    setError('');
    const session = await phoneLoginRequest(`/${reference.sessionId}/claim`, {
      scan_secret: reference.scanSecret, claim_secret: claimSecret,
      client_type: Capacitor.getPlatform() === 'ios' ? 'ios' : 'android',
    });
    if (attempt !== generation.current) return;
    if (session.status !== 'scanned') throw new Error(phoneLoginStatusText(session.status));
    setPending({ ...session, claimSecret });
  };

  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      if (Date.now() >= Date.parse(pending.expires_at)) {
        setError('二维码已过期，请重新扫码'); setPending(null); return;
      }
      try {
        const result = await phoneLoginRequest<PhoneLoginToken>(`/${pending.session_id}/token`, {
          claim_secret: pending.claimSecret,
        }, false, controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        setError('');
        if (result.status === 'success') {
          setPending(null); onSessionRef.current(result); return;
        }
        if (!['scanned', 'approved', 'slow_down'].includes(result.status)) {
          setError(phoneLoginStatusText(result.status)); setPending(null); return;
        }
      } catch {
        if (controller.signal.aborted) return;
        setError('连接中断，正在重试…');
        if (++failures >= 3) { setError('连接失败，请重新扫码'); setPending(null); return; }
      }
      timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending]);

  return <>
    {!pending ? <MobileDesktopLoginScanner
      isAuthenticated={false}
      onPreview={async () => { throw new Error('请扫描电脑设置中“登录手机”的二维码'); }}
      onDecision={async () => undefined}
      onAuthenticationRequired={() => undefined}
      onPhoneLoginScan={scan}
      label="扫码登录手机"
      variant="primary"
    /> : <div className={styles.waiting}>
      <strong>请在电脑上确认</strong>
      <span className={styles.code}>{pending.verification_code}</span>
      <p>确认码一致后，手机会自动登录。</p>
      <div className={styles.actions}><button onClick={() => { generation.current += 1; setPending(null); setError(''); }}>返回账号登录</button></div>
    </div>}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </>;
}
