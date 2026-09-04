'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  buildDesktopLoginApprovalUrl,
  cancelDesktopLoginSession,
  createDesktopLoginSession,
  pollDesktopLoginSession,
  type DesktopLoginAuthSession,
  type DesktopLoginCreateData,
} from '@/lib/desktopLogin';
import styles from './DesktopQrLoginCard.module.css';

const MIN_POLL_DELAY_MS = 2_000;
const MAX_TRANSIENT_FAILURES = 3;

type CardPhase =
  | 'creating'
  | 'waiting'
  | 'approved'
  | 'reconnecting'
  | 'cancelling'
  | 'success'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'error';

export interface DesktopQrLoginCardProps {
  onSession: (session: DesktopLoginAuthSession) => void | Promise<void>;
  onBrowserLogin?: () => void | Promise<void>;
  browserLoginBusy?: boolean;
  className?: string;
}

interface CreationRequest {
  generation: number;
  promise: ReturnType<typeof createDesktopLoginSession>;
}

function pollDelay(seconds?: number): number {
  if (!Number.isFinite(seconds)) return MIN_POLL_DELAY_MS;
  return Math.max(MIN_POLL_DELAY_MS, Math.ceil(Number(seconds) * 1000));
}

function remainingLabel(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function phaseCopy(phase: CardPhase): { title: string; detail: string } {
  switch (phase) {
    case 'creating':
      return { title: '正在生成登录码', detail: '马上就好' };
    case 'approved':
      return { title: '手机已确认', detail: '正在登录客户端' };
    case 'reconnecting':
      return { title: '正在重新连接', detail: '请保持二维码页面打开' };
    case 'cancelling':
      return { title: '正在取消', detail: '请稍候' };
    case 'success':
      return { title: '登录成功', detail: '正在进入知萃' };
    case 'denied':
      return { title: '手机已取消登录', detail: '可以刷新后重新扫描' };
    case 'cancelled':
      return { title: '本次登录已取消', detail: '需要时可重新生成' };
    case 'expired':
      return { title: '二维码已过期', detail: '刷新后即可继续' };
    case 'error':
      return { title: '暂时无法扫码登录', detail: '请刷新或改用浏览器登录' };
    default:
      return { title: '等待手机确认', detail: '打开知萃 App 扫一扫' };
  }
}

function isTerminalPhase(phase: CardPhase): boolean {
  return ['success', 'denied', 'cancelled', 'expired', 'error'].includes(phase);
}

export default function DesktopQrLoginCard({
  onSession,
  onBrowserLogin,
  browserLoginBusy = false,
  className = '',
}: DesktopQrLoginCardProps) {
  const [generation, setGeneration] = useState(0);
  const [phase, setPhase] = useState<CardPhase>('creating');
  const [session, setSession] = useState<DesktopLoginCreateData | null>(null);
  const [qrValue, setQrValue] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [polling, setPolling] = useState(false);
  const [pollRequestInFlight, setPollRequestInFlight] = useState(false);
  const creationRequestRef = useRef<CreationRequest | null>(null);
  const completedSessionRef = useRef<string | null>(null);
  const onSessionRef = useRef(onSession);
  const pollRequestInFlightRef = useRef(false);
  const sessionActionInFlightRef = useRef(false);

  useEffect(() => {
    onSessionRef.current = onSession;
  }, [onSession]);

  useEffect(() => {
    let active = true;
    setSession(null);
    setQrValue('');
    setSecondsLeft(0);
    setErrorMessage('');
    setPolling(false);
    setPollRequestInFlight(false);
    setPhase('creating');

    if (creationRequestRef.current?.generation !== generation) {
      creationRequestRef.current = {
        generation,
        promise: createDesktopLoginSession(),
      };
    }
    const request = creationRequestRef.current.promise;
    void request.then((result) => {
      if (!active) return;
      if (!result.success) {
        setErrorMessage(result.error);
        setPhase('error');
        return;
      }
      try {
        const value = buildDesktopLoginApprovalUrl(result.data);
        setSession(result.data);
        setQrValue(value);
        setSecondsLeft(Math.max(0, Math.ceil(
          (Date.parse(result.data.expires_at) - Date.now()) / 1000,
        )));
        setPhase('waiting');
        setPolling(true);
      } catch (creationError) {
        setErrorMessage(
          creationError instanceof Error
            ? creationError.message
            : '登录码生成失败，请重试',
        );
        setPhase('error');
      }
    });

    return () => {
      active = false;
    };
  }, [generation]);

  useEffect(() => {
    if (!session || !polling) return;
    let stopped = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | null = null;
    let transientFailures = 0;

    const stopWithPhase = (nextPhase: CardPhase, message = '') => {
      setPolling(false);
      setPhase(nextPhase);
      if (message) setErrorMessage(message);
    };

    const schedule = (delay: number) => {
      timeoutId = globalThis.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      requestController = new AbortController();
      pollRequestInFlightRef.current = true;
      setPollRequestInFlight(true);
      const result = await pollDesktopLoginSession(
        session.session_id,
        session.poll_secret,
        requestController.signal,
      );
      pollRequestInFlightRef.current = false;
      if (stopped) return;
      setPollRequestInFlight(false);

      if (!result.success) {
        transientFailures += 1;
        if (!result.status && transientFailures <= MAX_TRANSIENT_FAILURES) {
          setPhase('reconnecting');
          schedule(pollDelay(session.poll_interval_seconds) * transientFailures);
          return;
        }
        stopWithPhase('error', result.error);
        return;
      }

      transientFailures = 0;
      const data = result.data;
      if (data.status === 'success') {
        if (completedSessionRef.current === session.session_id) return;
        completedSessionRef.current = session.session_id;
        setPolling(false);
        setPhase('success');
        try {
          await onSessionRef.current({ token: data.token, user: data.user });
        } catch {
          if (!stopped) {
            setErrorMessage('登录信息接收失败，请重新扫码');
            setPhase('error');
          }
        }
        return;
      }

      if (data.status === 'pending' || data.status === 'slow_down') {
        setPhase('waiting');
        schedule(pollDelay(data.retry_after_seconds ?? data.poll_interval_seconds));
        return;
      }
      if (data.status === 'approved') {
        setPhase('approved');
        schedule(pollDelay(data.poll_interval_seconds));
        return;
      }
      if (data.status === 'denied') stopWithPhase('denied');
      else if (data.status === 'cancelled') stopWithPhase('cancelled');
      else if (data.status === 'expired') stopWithPhase('expired');
      else if (data.status === 'account_unavailable') {
        stopWithPhase('error', '手机上的账号当前不可用，请改用账号密码登录');
      }
      else stopWithPhase('error', '这个登录码已经使用，请重新生成');
    };

    schedule(pollDelay(session.poll_interval_seconds));
    return () => {
      stopped = true;
      if (timeoutId) globalThis.clearTimeout(timeoutId);
      requestController?.abort();
      pollRequestInFlightRef.current = false;
      setPollRequestInFlight(false);
    };
  }, [polling, session]);

  useEffect(() => {
    if (!session || isTerminalPhase(phase)) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil(
        (Date.parse(session.expires_at) - Date.now()) / 1000,
      ));
      setSecondsLeft(remaining);
      if (remaining === 0 && !pollRequestInFlightRef.current) {
        setPolling(false);
        setPhase('expired');
      }
    };
    update();
    const intervalId = globalThis.setInterval(update, 1000);
    return () => globalThis.clearInterval(intervalId);
  }, [phase, session]);

  const handleRefresh = useCallback(async () => {
    if (
      pollRequestInFlightRef.current
      || sessionActionInFlightRef.current
      || phase === 'approved'
      || phase === 'success'
    ) return;
    sessionActionInFlightRef.current = true;
    const previous = session;
    setPolling(false);
    try {
      if (previous && !['success', 'denied', 'cancelled', 'expired'].includes(phase)) {
        setPhase('cancelling');
        const result = await cancelDesktopLoginSession(
          previous.session_id,
          previous.poll_secret,
        );
        if (!result.success) {
          setErrorMessage(result.error);
          setPhase('error');
          return;
        }
        if (result.data.status === 'approved') {
          setPhase('approved');
          setPolling(true);
          return;
        }
        if (result.data.status === 'consumed') {
          setErrorMessage('扫码登录已完成，请等待客户端进入');
          setPhase('error');
          return;
        }
      }
      setSession(null);
      setQrValue('');
      setErrorMessage('');
      setPhase('creating');
      completedSessionRef.current = null;
      creationRequestRef.current = null;
      setGeneration((value) => value + 1);
    } finally {
      sessionActionInFlightRef.current = false;
    }
  }, [phase, session]);

  const handleCancel = useCallback(async () => {
    if (
      !session
      || isTerminalPhase(phase)
      || pollRequestInFlightRef.current
      || sessionActionInFlightRef.current
    ) return;
    sessionActionInFlightRef.current = true;
    setPolling(false);
    setPhase('cancelling');
    try {
      const result = await cancelDesktopLoginSession(
        session.session_id,
        session.poll_secret,
      );
      if (!result.success) {
        setErrorMessage(result.error);
        setPhase('error');
        return;
      }
      if (result.data.status === 'approved') {
        setPhase('approved');
        setPolling(true);
        return;
      }
      if (result.data.status === 'consumed') {
        setErrorMessage('登录凭证已经领取，请重新打开客户端确认登录状态');
        setPhase('error');
        return;
      }
      setPhase(result.data.status);
    } finally {
      sessionActionInFlightRef.current = false;
    }
  }, [phase, session]);

  const handleBrowserLogin = useCallback(async () => {
    if (
      !onBrowserLogin
      || browserLoginBusy
      || pollRequestInFlightRef.current
      || sessionActionInFlightRef.current
      || phase === 'creating'
      || phase === 'cancelling'
      || phase === 'approved'
      || phase === 'success'
    ) return;
    sessionActionInFlightRef.current = true;
    try {
      if (session && !['success', 'denied', 'cancelled', 'expired'].includes(phase)) {
        setPolling(false);
        setPhase('cancelling');
        const result = await cancelDesktopLoginSession(
          session.session_id,
          session.poll_secret,
        );
        if (!result.success) {
          setErrorMessage('无法安全结束扫码登录，请稍后重试');
          setPhase('error');
          return;
        }
        if (result.data.status === 'approved') {
          setPhase('approved');
          setPolling(true);
          return;
        }
        if (result.data.status === 'consumed') {
          setErrorMessage('扫码登录已完成，请等待客户端进入');
          setPhase('error');
          return;
        }
        setPhase(result.data.status);
      }
      await onBrowserLogin();
    } catch (browserError) {
      setErrorMessage(
        browserError instanceof Error
          ? browserError.message
          : '无法打开浏览器，请稍后重试',
      );
      setPhase('error');
    } finally {
      sessionActionInFlightRef.current = false;
    }
  }, [
    browserLoginBusy,
    onBrowserLogin,
    phase,
    session,
  ]);

  const copy = phaseCopy(phase);
  const canShowQr = Boolean(qrValue && session && !['cancelled', 'expired', 'error'].includes(phase));
  const rootClassName = `${styles.card}${className ? ` ${className}` : ''}`;

  return (
    <section className={rootClassName} aria-labelledby="desktop-qr-login-title">
      <header className={styles.header}>
        <span className={styles.headerIcon} aria-hidden="true">
          <Smartphone size={19} strokeWidth={1.8} />
        </span>
        <div>
          <h2 id="desktop-qr-login-title">手机扫码登录</h2>
          <p>使用知萃 App 扫描</p>
        </div>
      </header>

      <div className={styles.qrStage}>
        <div className={styles.qrFrame} aria-busy={phase === 'creating'}>
          {canShowQr ? (
            <QRCodeSVG
              value={qrValue}
              size={188}
              level="M"
              marginSize={3}
              bgColor="#ffffff"
              fgColor="#172033"
              title="知萃电脑登录二维码"
              className={styles.qrCode}
            />
          ) : phase === 'success' ? (
            <CheckCircle2 className={styles.successIcon} size={48} aria-hidden="true" />
          ) : (
            <LoaderCircle
              className={phase === 'creating' || phase === 'cancelling' ? styles.spinner : styles.mutedIcon}
              size={40}
              aria-hidden="true"
            />
          )}
        </div>

        <div className={styles.status} role="status" aria-live="polite">
          <strong>{copy.title}</strong>
          <span>{errorMessage || copy.detail}</span>
        </div>

        {session ? (
          <div className={styles.verification}>
            <span>校验码</span>
            <strong aria-label={`校验码 ${session.verification_code.split('').join(' ')}`}>
              {session.verification_code}
            </strong>
            <span>{remainingLabel(secondsLeft)}</span>
          </div>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={handleRefresh}
          disabled={
            phase === 'creating'
            || phase === 'cancelling'
            || phase === 'approved'
            || phase === 'success'
            || pollRequestInFlight
          }
        >
          <RefreshCw size={15} aria-hidden="true" />
          {isTerminalPhase(phase) ? '重新生成' : '刷新二维码'}
        </button>

        {onBrowserLogin ? (
          <button
            type="button"
            className={styles.secondaryAction}
            onClick={() => void handleBrowserLogin()}
            disabled={
              browserLoginBusy
              || pollRequestInFlight
              || phase === 'creating'
              || phase === 'cancelling'
              || phase === 'approved'
              || phase === 'success'
            }
          >
            {browserLoginBusy ? (
              <LoaderCircle className={styles.buttonSpinner} size={15} aria-hidden="true" />
            ) : (
              <ExternalLink size={15} aria-hidden="true" />
            )}
            浏览器登录
          </button>
        ) : null}
      </div>

      {session && !isTerminalPhase(phase) ? (
        <button
          type="button"
          className={styles.cancelAction}
          onClick={handleCancel}
          disabled={pollRequestInFlight || phase === 'cancelling'}
        >
          <X size={13} aria-hidden="true" />
          取消本次登录
        </button>
      ) : null}
    </section>
  );
}
