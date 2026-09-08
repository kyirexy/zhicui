'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Code2,
  Eye,
  EyeOff,
  LoaderCircle,
  Lock,
  Mail,
  MonitorUp,
  ShieldCheck,
  User,
} from 'lucide-react';
import DesktopQrLoginCard from '@/components/DesktopQrLoginCard';
import PhoneQrLogin from '@/components/PhoneQrLogin';
import MobileDesktopLoginScanner, {
  type MobileDesktopLoginPreview,
} from '@/components/MobileDesktopLoginScanner';
import { useAuth } from '@/lib/hooks/AuthContext';
import { API_BASE } from '@/lib/api';
import type { DesktopZhicuiLoginStatus } from '@/lib/desktopRuntime';
import {
  clearPendingDesktopLoginApproval,
  decideDesktopLoginSession,
  parseDesktopLoginQr,
  previewDesktopLoginSession,
  readPendingDesktopLoginApproval,
  savePendingDesktopLoginApproval,
  type DesktopLoginApprovalReference,
} from '@/lib/desktopLogin';
import { isNativeMobileApp } from '@/lib/douyinNative';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legalDocuments';
import styles from './Login.module.css';

const IS_DEV = process.env.NODE_ENV === 'development';
const DEV_AUTH_AUTO = IS_DEV && process.env.NEXT_PUBLIC_DEV_AUTH_AUTO === 'true';
const DESKTOP_SESSION_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

function getSafeRedirect(fallback: string): string {
  const candidate = new URLSearchParams(window.location.search).get('redirect');
  if (candidate?.startsWith('/') && !candidate.startsWith('//')) return candidate;
  return fallback;
}

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem('zhicui_token');
  } catch {
    return null;
  }
}

export default function LoginPage() {
  const {
    user,
    loading,
    enteringDevelopmentSession,
    enterDevelopmentSession,
    login,
    register,
    acceptSession,
    error,
    clearError,
  } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [showStandardAuth, setShowStandardAuth] = useState(!DEV_AUTH_AUTO);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [nativeMobile, setNativeMobile] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [pendingDesktopApproval, setPendingDesktopApproval] = useState<
    DesktopLoginApprovalReference | null
  >(null);

  // 桌面端 ↔ Web 联动登录
  const [desktopSession, setDesktopSession] = useState<string | null>(null);
  const [claimState, setClaimState] = useState<
    'idle' | 'claiming' | 'claimed' | 'failed'
  >('idle');
  const claimRequest = useRef<AbortController | null>(null);
  const [desktopStatus, setDesktopStatus] = useState<DesktopZhicuiLoginStatus | null>(null);
  const [desktopStarting, setDesktopStarting] = useState(false);
  const isDesktopRuntime =
    typeof window !== 'undefined' && Boolean(window.zhicuiDesktop);

  useEffect(() => {
    const mobile = isNativeMobileApp();
    setNativeMobile(mobile);
    if (mobile) {
      const incoming = parseDesktopLoginQr(window.location.href);
      const pending = incoming || readPendingDesktopLoginApproval();
      if (incoming) {
        savePendingDesktopLoginApproval(incoming);
        window.history.replaceState(
          window.history.state,
          '',
          `${window.location.pathname}${window.location.search}`,
        );
      }
      setPendingDesktopApproval(pending);
    }
    setRuntimeReady(true);
  }, []);

  // 从 URL 识别「桌面联动登录」：/login?desktop=1&session=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const session = params.get('session');
    if (
      params.get('desktop') === '1'
      && session
      && DESKTOP_SESSION_PATTERN.test(session)
    ) {
      setDesktopSession(session);
    }
  }, []);

  // 客户端内订阅网页登录的进度事件（打开浏览器/等待/成功…）
  useEffect(() => {
    if (!isDesktopRuntime) return;
    const bridge = window.zhicuiDesktop;
    if (!bridge || typeof bridge.onZhicuiLoginStatus !== 'function') return;
    return bridge.onZhicuiLoginStatus(setDesktopStatus);
  }, [isDesktopRuntime]);

  const claimDesktopSession = useCallback(async (tokenValue: string) => {
    if (!desktopSession) return;
    claimRequest.current?.abort();
    const controller = new AbortController();
    claimRequest.current = controller;
    setClaimState('claiming');
    setFieldError('');
    try {
      const response = await fetch(
        `${API_BASE}/api/auth/desktop-handoff/claim`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tokenValue}`,
          },
          body: JSON.stringify({ session_id: desktopSession }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
        },
      );
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        error?: string;
        detail?: string;
      } | null;
      if (controller.signal.aborted) return;
      if (response.ok && payload?.success) {
        setClaimState('claimed');
        return;
      }
      setClaimState('failed');
      setFieldError(
        payload?.error
        || payload?.detail
        || (response.status >= 500
          ? '登录服务暂时异常，请返回客户端重新发起'
          : '登录交接失败，请返回客户端重新发起'),
      );
    } catch {
      if (controller.signal.aborted) return;
      setClaimState('failed');
      setFieldError('登录交接失败，请检查网络后重试');
    } finally {
      if (claimRequest.current === controller) claimRequest.current = null;
    }
  }, [desktopSession]);

  useEffect(() => () => { claimRequest.current?.abort(); }, [desktopSession, user?.id]);

  // 登录成功且带票据时，把身份交接给客户端（票据一次性）
  useEffect(() => {
    if (!desktopSession || !user || claimState !== 'idle') return;
    const stored = readStoredToken();
    if (stored) void claimDesktopSession(stored);
    else {
      setClaimState('failed');
      setFieldError('无法读取登录状态，请返回客户端重新发起登录');
    }
  }, [desktopSession, user, claimState, claimDesktopSession]);

  // 有交接票据时始终留页：等待、失败重试和成功都不能被普通登录跳转打断。
  useEffect(() => {
    if (!runtimeReady || loading || !user) return;
    if (nativeMobile && pendingDesktopApproval) return;
    if (desktopSession) return;
    router.replace(getSafeRedirect('/'));
  }, [
    desktopSession,
    loading,
    nativeMobile,
    pendingDesktopApproval,
    router,
    runtimeReady,
    user,
  ]);

  const previewDesktopApproval = useCallback(async (
    reference: DesktopLoginApprovalReference,
  ): Promise<MobileDesktopLoginPreview> => {
    const result = await previewDesktopLoginSession(reference);
    if (!result.success) throw new Error(result.error);
    return {
      sessionId: result.data.session_id,
      clientName: result.data.client_name,
      verificationCode: result.data.verification_code,
      expiresAt: result.data.expires_at,
      status: result.data.status,
    };
  }, []);

  const decideDesktopApproval = useCallback(async (
    reference: DesktopLoginApprovalReference,
    decision: 'approve' | 'deny',
  ) => {
    const result = await decideDesktopLoginSession(reference, decision);
    if (!result.success) throw new Error(result.error);
  }, []);

  const finishDesktopApproval = useCallback(() => {
    clearPendingDesktopLoginApproval();
    setPendingDesktopApproval(null);
    if (user) router.replace(getSafeRedirect('/'));
  }, [router, user]);

  const validate = () => {
    if (!email.trim()) return '请输入邮箱或用户名';
    if (mode === 'register' && !email.includes('@')) return '请输入有效的邮箱地址';
    if (!password) return '请输入密码';
    if (mode === 'register' && password.length < 6) return '密码至少需要 6 位字符';
    if (mode === 'register' && username.trim().length < 2) return '请输入用户名（至少 2 个字符）';
    if (mode === 'register' && !legalAccepted) return '请先阅读并同意《用户协议》和《隐私政策》';
    return '';
  };

  const handleDevelopmentEntry = async () => {
    clearError();
    await enterDevelopmentSession();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    clearError();
    const validationError = validate();
    if (validationError) {
      setFieldError(validationError);
      return;
    }
    setFieldError('');

    setSubmitting(true);
    if (mode === 'login') {
      await login(email, password);
    } else {
      await register(email, password, username, {
        termsVersion: CURRENT_LEGAL_VERSIONS.terms,
        privacyVersion: CURRENT_LEGAL_VERSIONS.privacy,
      });
    }
    setSubmitting(false);
  };

  const handleBeginDesktopLogin = async () => {
    const bridge = window.zhicuiDesktop;
    if (!bridge || typeof bridge.beginZhicuiWebLogin !== 'function') return;
    clearError();
    setFieldError('');
    setDesktopStarting(true);
    try {
      await bridge.beginZhicuiWebLogin();
    } finally {
      setDesktopStarting(false);
    }
  };

  // 网页账号已登录后，在同一状态页完成电脑交接，失败时保留重试入口。
  if (desktopSession && user && !loading) {
    const claimed = claimState === 'claimed';
    const failed = claimState === 'failed';
    return (
      <div className="relative flex min-h-[70vh] items-center justify-center px-5 py-10">
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-56 w-96 -translate-x-1/2 rounded-full bg-accent-brand/[0.07] blur-3xl"
          aria-hidden="true"
        />
        <div className="relative w-full max-w-[24rem]">
          <div className="relative overflow-hidden rounded-[1.75rem] border border-card-border bg-card-bg/90 p-8 text-center shadow-[0_24px_80px_-40px_rgba(16,24,40,0.4)] backdrop-blur-xl">
            <div
              className="pointer-events-none absolute -top-16 left-1/2 h-36 w-72 -translate-x-1/2 rounded-full bg-accent-brand/[0.09] blur-2xl"
              aria-hidden="true"
            />
            <div className="relative" aria-live="polite" aria-busy={!claimed && !failed}>
              <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-brand/[0.1] text-accent-brand">
                {claimed ? <CheckCircle2 size={28} aria-hidden="true" /> : failed ? (
                  <MonitorUp size={28} aria-hidden="true" />
                ) : <LoaderCircle size={28} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
              </span>
              <h1 className="mt-5 text-balance text-xl font-bold tracking-tight text-foreground">
                {claimed ? '登录成功' : failed ? '电脑登录未完成' : '正在登录电脑'}
              </h1>
              <p className="mx-auto mt-2 max-w-[18rem] text-pretty text-sm leading-6 text-foreground-muted" role={failed ? 'alert' : undefined}>
                {claimed ? '网页登录已完成，现在可以回到知萃客户端继续使用了。'
                  : failed ? fieldError || '登录交接失败，请重试或返回客户端重新发起。'
                    : '正在将登录状态交接给客户端，请稍候。'}
              </p>
              {failed ? <button
                type="button"
                className={`${styles.submit} mt-5 w-full`}
                onClick={() => {
                  const stored = readStoredToken();
                  if (stored) void claimDesktopSession(stored);
                  else setFieldError('无法读取登录状态，请返回客户端重新发起登录');
                }}
              >重试登录电脑</button> : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (loading || (user && !(nativeMobile && pendingDesktopApproval))) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-5">
        <div className="dev-session-entry" role="status" aria-live="polite">
          <Image src="/logo.png" alt="知萃" width={48} height={48} className="size-12 object-contain" priority />
          <div>
            <h1 className="text-balance">{IS_DEV ? '正在进入开发环境' : '正在恢复登录状态'}</h1>
            <p className="text-pretty">
              {DEV_AUTH_AUTO ? '正在连接本地开发账号，无需填写账号和密码。' : '正在确认你的账号信息。'}
            </p>
          </div>
          <LoaderCircle
            size={18}
            aria-hidden="true"
            className="shrink-0 animate-spin text-accent-brand motion-reduce:animate-none"
          />
        </div>
      </div>
    );
  }

  const desktopStage = desktopStatus?.stage;

  // ================= 桌面客户端：手机扫码为主，浏览器登录为兜底 =================
  if (isDesktopRuntime) {
    const busy = desktopStage === 'starting'
      || desktopStage === 'browser-open'
      || desktopStage === 'waiting';
    return (
      <div className="relative flex min-h-[calc(100dvh-7rem)] items-center justify-center overflow-hidden px-5 py-10">
        <div
          className="pointer-events-none absolute -top-32 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-accent-brand/[0.08] blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-40 -right-24 h-80 w-80 rounded-full bg-accent-brand/[0.05] blur-3xl"
          aria-hidden="true"
        />

        <div className="relative w-full max-w-[24rem]">
          <div className="relative overflow-hidden rounded-[1.75rem] border border-card-border bg-card-bg/90 p-7 shadow-[0_24px_80px_-40px_rgba(16,24,40,0.4)] backdrop-blur-xl md:p-8">
            <div
              className="pointer-events-none absolute -top-16 left-1/2 h-36 w-72 -translate-x-1/2 rounded-full bg-accent-brand/[0.09] blur-2xl"
              aria-hidden="true"
            />

            <div className="relative text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-[1.35rem] bg-accent-brand/[0.08] ring-1 ring-accent-brand/15">
                <Image
                  src="/logo.png"
                  alt="知萃"
                  width={40}
                  height={40}
                  className="h-10 w-10 object-contain"
                  priority
                />
              </div>
              <h1 className="mt-5 text-balance text-[1.35rem] font-bold tracking-tight text-foreground">
                登录知萃
              </h1>
              <p className="mx-auto mt-2 max-w-[20rem] text-pretty text-sm leading-6 text-foreground-muted">
                用手机知萃扫码，确认后电脑自动登录
              </p>
            </div>

            <DesktopQrLoginCard
              className="relative mt-7"
              onSession={(session) => {
                acceptSession(session);
              }}
              onBrowserLogin={handleBeginDesktopLogin}
              browserLoginBusy={busy || desktopStarting}
            />

            {desktopStage === 'error' && desktopStatus?.message ? (
              <p className="relative mt-4 rounded-xl border border-accent-rose/20 bg-accent-rose/[0.05] px-4 py-3 text-xs leading-5 text-accent-rose" role="alert">
                {desktopStatus.message}
              </p>
            ) : null}
          </div>

          <p className="mt-4 text-center text-xs text-foreground-muted">
            还没有账号？在网页登录页可直接注册
          </p>
        </div>
      </div>
    );
  }

  // ================= 浏览器端：本地开发入口 + 账号登录 =================
  // 注意：本地开发入口（IS_DEV）只在 development 构建出现；生产构建不渲染，
  // 且后端 /api/auth/dev-session 在未设置 DEV_AUTH_BYPASS 时返回 404，双保险。
  return (
    <div className={styles.page}>
      <div className={styles.content}>
        {desktopSession && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-full border border-accent-brand/15 bg-accent-brand/[0.06] px-4 py-2 text-xs font-medium text-accent-brand">
            <MonitorUp size={14} aria-hidden="true" />
            正在为知萃桌面客户端登录，完成后自动回到客户端
          </div>
        )}

        <div>
          <header className={styles.header}>
            <div className={styles.brand}>
              <Image
                src="/logo.png"
                alt=""
                width={44}
                height={44}
                className={styles.logo}
                priority
              />
              <span>知萃</span>
            </div>
            <h1 className={styles.title}>
              {mode === 'login' ? '欢迎回来' : '创建你的账号'}
            </h1>
            <p className={styles.subtitle}>
              {mode === 'login' ? '继续整理你的知识与灵感' : '把收藏变成自己的知识'}
            </p>
          </header>

          {nativeMobile ? (
            <section className={styles.scanSection} aria-label="扫码登录">
              {pendingDesktopApproval ? <MobileDesktopLoginScanner
                isAuthenticated={Boolean(user)}
                currentAccountLabel={user?.username || user?.email}
                initialReference={pendingDesktopApproval}
                onPreview={previewDesktopApproval}
                onDecision={decideDesktopApproval}
                onAuthenticationRequired={(reference) => {
                  setPendingDesktopApproval(reference);
                  setShowStandardAuth(true);
                  setFieldError('');
                }}
                onApproved={finishDesktopApproval}
                onDismiss={finishDesktopApproval}
                label="扫描电脑登录码"
                variant="primary"
              /> : <PhoneQrLogin variant="login" onSession={(session) => { acceptSession(session); router.replace('/'); }} />}
              {!pendingDesktopApproval ? <p className={styles.scanHint}>扫描已登录电脑上的二维码</p> : null}
              <div className={styles.divider} aria-hidden="true">或使用账号登录</div>
              {pendingDesktopApproval && !user ? (
                <p className="mt-2 text-center text-xs font-medium text-accent-brand" role="status">
                  登录后继续确认这台电脑
                </p>
              ) : null}
            </section>
          ) : null}

          {IS_DEV && (
            <section className="relative rounded-2xl border border-card-border bg-background/60 p-4">
              <div className="flex items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-brand/10 text-accent-brand">
                  <Code2 size={18} aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-accent-brand">本地开发模式</p>
                  <p className="mt-1 text-pretty text-xs leading-5 text-foreground-muted">
                    使用固定本地开发身份，无需注册即可进入（仅开发环境可见）。
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleDevelopmentEntry}
                disabled={enteringDevelopmentSession}
                className="mt-3.5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-brand px-4 py-2.5 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(16,24,40,0.08),0_6px_16px_-4px_color-mix(in_srgb,var(--accent-brand)_45%,transparent)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {enteringDevelopmentSession ? (
                  <>
                    <LoaderCircle size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                    正在进入…
                  </>
                ) : (
                  <>
                    一键进入开发模式
                    <ArrowRight size={16} aria-hidden="true" />
                  </>
                )}
              </button>

              <div className="mt-3 flex items-center justify-between gap-3 text-xs text-foreground-muted">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck size={14} aria-hidden="true" />
                  仅本机开发可用
                </span>
                <button
                  type="button"
                  onClick={() => {
                    clearError();
                    setShowStandardAuth((visible) => !visible);
                  }}
                  className="group inline-flex items-center gap-1 font-medium text-foreground transition-colors duration-150 hover:text-accent-brand"
                  aria-expanded={showStandardAuth}
                  aria-controls="standard-auth-form"
                  data-state={showStandardAuth ? 'open' : 'closed'}
                >
                  {showStandardAuth ? '收起账号登录' : '使用普通账号'}
                  <ChevronDown
                    size={14}
                    aria-hidden="true"
                    className="transition-transform duration-150 group-data-[state=open]:rotate-180"
                  />
                </button>
              </div>

              {!showStandardAuth && error && (
                <p className="mt-3 rounded-xl bg-accent-rose/5 px-3 py-2 text-xs text-accent-rose" role="alert">
                  {error}
                </p>
              )}
            </section>
          )}

          {(showStandardAuth || !IS_DEV) && (
            <section
              id="standard-auth-form"
              className={`${styles.formSection} ${IS_DEV ? 'mt-4' : ''}`}
            >
              <form onSubmit={handleSubmit} className={styles.form} aria-busy={submitting}>
                <div className={styles.field}>
                  <label htmlFor="login-account">{mode === 'login' ? '邮箱 / 用户名' : '邮箱'}</label>
                  <div className={styles.inputWrap}>
                  <Mail size={18} aria-hidden="true" className={styles.fieldIcon} />
                  <input
                    id="login-account"
                    name="username"
                    type="text"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setFieldError('');
                      clearError();
                    }}
                    placeholder={mode === 'login' ? '输入邮箱或用户名' : '输入邮箱地址'}
                    className={styles.input}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                  />
                  </div>
                </div>

                <div className={styles.field}>
                  <label htmlFor="login-password">密码</label>
                  <div className={styles.inputWrap}>
                  <Lock size={18} aria-hidden="true" className={styles.fieldIcon} />
                  <input
                    id="login-password"
                    name="password"
                    type={passwordVisible ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setFieldError('');
                      clearError();
                    }}
                    placeholder={mode === 'login' ? '输入密码' : '至少 6 位字符'}
                    className={`${styles.input} ${styles.passwordInput}`}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    enterKeyHint={mode === 'login' ? 'go' : 'next'}
                  />
                  <button type="button" className={styles.passwordToggle} aria-label={passwordVisible ? '隐藏密码' : '显示密码'} aria-pressed={passwordVisible} onClick={() => setPasswordVisible((visible) => !visible)}>
                    {passwordVisible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                  </button>
                  </div>
                </div>

                {mode === 'register' && (
                  <div className={styles.field}>
                    <label htmlFor="register-username">用户名</label>
                    <div className={styles.inputWrap}>
                    <User size={18} aria-hidden="true" className={styles.fieldIcon} />
                    <input
                      id="register-username"
                      name="new-username"
                      type="text"
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        setFieldError('');
                        clearError();
                      }}
                      placeholder="用户名（至少 2 位，不可重复）"
                      className={styles.input}
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                    </div>
                  </div>
                )}

                {mode === 'register' && (
                  <div className="flex min-h-11 items-start gap-1 rounded-xl bg-background-secondary/60 px-2 py-2">
                    <label htmlFor="legal-consent" className="grid size-11 shrink-0 cursor-pointer place-items-center">
                      <input
                        id="legal-consent"
                        type="checkbox"
                        checked={legalAccepted}
                        aria-describedby="legal-consent-copy"
                        onChange={(event) => {
                          setLegalAccepted(event.target.checked);
                          setFieldError('');
                          clearError();
                        }}
                        className="size-5 accent-[var(--accent-brand)]"
                      />
                      <span className="sr-only">同意用户协议和隐私政策</span>
                    </label>
                    <p id="legal-consent-copy" className="min-w-0 py-0.5 text-pretty text-xs leading-5 text-foreground-muted">
                      我已阅读并同意
                      <Link className="mx-1 text-accent-brand underline-offset-2 hover:underline" href="/legal/terms">《用户协议》</Link>
                      和
                      <Link className="ml-1 text-accent-brand underline-offset-2 hover:underline" href="/legal/privacy">《隐私政策》</Link>
                    </p>
                  </div>
                )}

                {(fieldError || error) && (
                  <p className="rounded-xl bg-accent-rose/5 px-3 py-2 text-xs text-accent-rose" role="alert">
                    {fieldError || error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting || (desktopSession ? claimState === 'claiming' : false)}
                  className={styles.submit}
                >
                  {submitting
                    ? '处理中…'
                    : desktopSession && claimState === 'claiming'
                      ? '正在交接登录…'
                      : mode === 'login'
                        ? <>登录 <ArrowRight size={16} aria-hidden="true" /></>
                        : <>注册 <ArrowRight size={16} aria-hidden="true" /></>
                  }
                </button>
              </form>

              {mode === 'login' ? <p className={styles.sessionHint}>登录后自动保留登录状态</p> : null}
              <p className={styles.modeSwitch}>
                {mode === 'login' ? '还没有账号？' : '已有账号？'}
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === 'login' ? 'register' : 'login');
                    setPasswordVisible(false);
                    clearError();
                    setFieldError('');
                  }}
                  className={styles.textButton}
                >
                  {mode === 'login' ? '立即注册' : '去登录'}
                </button>
              </p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
