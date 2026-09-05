'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Code2,
  LoaderCircle,
  Lock,
  Mail,
  MonitorUp,
  ShieldCheck,
  User,
} from 'lucide-react';
import DesktopQrLoginCard from '@/components/DesktopQrLoginCard';
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
    setClaimState('claiming');
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
        },
      );
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        error?: string;
        detail?: string;
      } | null;
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
      setClaimState('failed');
      setFieldError('登录交接失败，请检查网络后重试');
    }
  }, [desktopSession]);

  // 登录成功且带票据时，把身份交接给客户端（票据一次性）
  useEffect(() => {
    if (!desktopSession || !user || claimState !== 'idle') return;
    const stored = readStoredToken();
    if (stored) void claimDesktopSession(stored);
  }, [desktopSession, user, claimState, claimDesktopSession]);

  // 登录成功后跳转；网页联动登录成功后停留在「请回到客户端」成功页
  useEffect(() => {
    if (!runtimeReady || loading || !user) return;
    if (nativeMobile && pendingDesktopApproval) return;
    if (desktopSession && claimState === 'claimed') return;
    router.replace(getSafeRedirect('/'));
  }, [
    claimState,
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

  // 网页联动登录成功：提示回到客户端
  if (desktopSession && claimState === 'claimed') {
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
            <div className="relative">
              <span className="mx-auto flex size-14 items-center justify-center rounded-full bg-accent-brand/[0.1] text-accent-brand">
                <CheckCircle2 size={28} aria-hidden="true" />
              </span>
              <h1 className="mt-5 text-balance text-xl font-bold tracking-tight text-foreground">
                登录成功
              </h1>
              <p className="mx-auto mt-2 max-w-[18rem] text-pretty text-sm leading-6 text-foreground-muted">
                网页登录已完成，现在可以回到知萃客户端继续使用了。
              </p>
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
    <div className="relative flex min-h-[70vh] items-center justify-center px-5 py-10">
      <div
        className="pointer-events-none absolute -top-24 left-1/2 h-56 w-96 -translate-x-1/2 rounded-full bg-accent-brand/[0.07] blur-3xl"
        aria-hidden="true"
      />
      <div className="relative w-full max-w-sm">
        {desktopSession && (
          <div className="mb-4 flex items-center justify-center gap-2 rounded-full border border-accent-brand/15 bg-accent-brand/[0.06] px-4 py-2 text-xs font-medium text-accent-brand">
            <MonitorUp size={14} aria-hidden="true" />
            正在为知萃桌面客户端登录，完成后自动回到客户端
          </div>
        )}

        <div className="relative overflow-hidden rounded-[1.75rem] border border-card-border bg-card-bg/90 p-6 shadow-[0_24px_80px_-40px_rgba(16,24,40,0.4)] backdrop-blur-xl md:p-7">
          <div
            className="pointer-events-none absolute -top-16 left-1/2 h-36 w-72 -translate-x-1/2 rounded-full bg-accent-brand/[0.09] blur-2xl"
            aria-hidden="true"
          />

          <div className="relative mb-6 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-[1.2rem] bg-accent-brand/[0.08] ring-1 ring-accent-brand/15">
              <Image
                src="/logo.png"
                alt="知萃"
                width={36}
                height={36}
                className="h-9 w-9 object-contain"
                priority
              />
            </div>
            <h1 className="mt-4 text-balance text-[1.25rem] font-bold tracking-tight text-foreground">
              登录知萃
            </h1>
            <p className="mx-auto mt-1.5 max-w-[20rem] text-pretty text-xs leading-5 text-foreground-muted">
              登录后继续整理你的知识卡片与行动计划
            </p>
          </div>

          {nativeMobile ? (
            <section className="relative mb-4 rounded-2xl border border-accent-brand/15 bg-accent-brand/[0.045] p-3.5">
              <MobileDesktopLoginScanner
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
              />
              <div className="mt-3 flex items-center gap-3 text-[11px] text-foreground-muted" aria-hidden="true">
                <span className="h-px flex-1 bg-card-border" />
                或使用账号密码
                <span className="h-px flex-1 bg-card-border" />
              </div>
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
              className={`relative ${IS_DEV ? 'mt-4' : ''} rounded-2xl border border-card-border p-4`}
            >
              <form onSubmit={handleSubmit} className="space-y-3.5">
                <div className="relative">
                  <Mail size={16} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                  <input
                    type="text"
                    value={email}
                    onChange={(event) => {
                      setEmail(event.target.value);
                      setFieldError('');
                      clearError();
                    }}
                    placeholder="邮箱或用户名"
                    aria-label="邮箱或用户名"
                    className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-brand/50 focus:ring-[3px] focus:ring-accent-brand/10"
                    autoComplete="username"
                  />
                </div>

                <div className="relative">
                  <Lock size={16} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setFieldError('');
                      clearError();
                    }}
                    placeholder={mode === 'login' ? '密码' : '密码（至少 6 位）'}
                    aria-label="密码"
                    className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-brand/50 focus:ring-[3px] focus:ring-accent-brand/10"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </div>

                {mode === 'register' && (
                  <div className="relative">
                    <User size={16} aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
                    <input
                      type="text"
                      value={username}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        setFieldError('');
                        clearError();
                      }}
                      placeholder="用户名（至少 2 位，不可重复）"
                      aria-label="用户名"
                      className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-brand/50 focus:ring-[3px] focus:ring-accent-brand/10"
                      autoComplete="username"
                    />
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
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent-brand py-3 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(16,24,40,0.08),0_6px_16px_-4px_color-mix(in_srgb,var(--accent-brand)_45%,transparent)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
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

              <p className="mt-4 text-center text-xs text-foreground-muted">
                {mode === 'login' ? '还没有账号？' : '已有账号？'}
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === 'login' ? 'register' : 'login');
                    clearError();
                    setFieldError('');
                  }}
                  className="ml-1 font-medium text-accent-brand hover:underline"
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
