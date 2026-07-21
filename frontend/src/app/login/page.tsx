'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ChevronDown,
  Code2,
  LoaderCircle,
  Lock,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { useAuth } from '@/lib/hooks/AuthContext';

const IS_DEV = process.env.NODE_ENV === 'development';

function getSafeRedirect(fallback: string): string {
  const candidate = new URLSearchParams(window.location.search).get('redirect');
  if (candidate?.startsWith('/') && !candidate.startsWith('//')) return candidate;
  return fallback;
}

export default function LoginPage() {
  const {
    user,
    loading,
    enteringDevelopmentSession,
    enterDevelopmentSession,
    login,
    register,
    error,
    clearError,
  } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [showStandardAuth, setShowStandardAuth] = useState(!IS_DEV);
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState('');

  useEffect(() => {
    if (loading || !user) return;
    const fallback = IS_DEV ? '/' : (user.is_admin ? '/admin' : '/');
    router.replace(getSafeRedirect(fallback));
  }, [loading, router, user]);

  const validate = () => {
    if (!email.trim()) return '请输入邮箱或用户名';
    if (mode === 'register' && !email.includes('@')) return '请输入有效的邮箱地址';
    if (password.length < 6) return '密码至少需要 6 位字符';
    if (mode === 'register' && username.trim().length < 2) return '请输入用户名（至少 2 个字符）';
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
      await register(email, password, username);
    }
    setSubmitting(false);
  };

  if (loading || user) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-5">
        <div className="dev-session-entry" role="status" aria-live="polite">
          <Image src="/logo.png" alt="知萃" width={48} height={48} className="size-12 object-contain" priority />
          <div>
            <h1 className="text-balance">{IS_DEV ? '正在进入开发环境' : '正在恢复登录状态'}</h1>
            <p className="text-pretty">
              {IS_DEV ? '正在连接本地开发账号，无需填写账号和密码。' : '正在确认你的账号信息。'}
            </p>
          </div>
          <LoaderCircle
            size={18}
            aria-hidden="true"
            className="shrink-0 animate-spin text-accent-emerald motion-reduce:animate-none"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-5 py-8">
      <div className="w-full max-w-sm">
        {IS_DEV && (
          <section className="rounded-3xl border border-card-border bg-card-bg p-5 shadow-sm">
            <div className="flex items-start gap-4">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-accent-emerald/10 text-accent-emerald">
                <Code2 size={20} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-accent-emerald">本地开发模式</p>
                <h1 className="mt-1 text-balance text-xl font-bold text-foreground">不用注册，直接进入</h1>
                <p className="mt-2 text-pretty text-sm leading-6 text-foreground-muted">
                  使用固定的本地开发身份，卡片、计划和问答数据会继续保存在同一个账号下。
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleDevelopmentEntry}
              disabled={enteringDevelopmentSession}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
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

            {!showStandardAuth && error && (
              <p className="mt-3 rounded-xl bg-accent-rose/5 px-3 py-2 text-xs text-accent-rose" role="alert">
                {error}
              </p>
            )}

            <div className="mt-4 flex items-center justify-between gap-3 text-xs text-foreground-muted">
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
                className="group inline-flex items-center gap-1 font-medium text-foreground transition-colors duration-150 hover:text-accent-emerald"
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
          </section>
        )}

        {showStandardAuth && (
          <section
            id="standard-auth-form"
            className="mt-5 rounded-3xl border border-card-border bg-card-bg p-5"
          >
            <div className="mb-6 text-center">
              <Image src="/logo.png" alt="知萃" width={48} height={48} className="mx-auto mb-3 size-12 object-contain" priority />
              <h1 className="text-balance text-xl font-bold text-foreground">
                {mode === 'login' ? '账号登录' : '创建账号'}
              </h1>
              <p className="mt-1 text-pretty text-xs text-foreground-muted">
                {mode === 'login' ? '用于测试正式账号认证流程' : '注册一个新的普通测试账号'}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
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
                  className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-emerald/50"
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
                  placeholder="密码（至少 6 位）"
                  aria-label="密码"
                  className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-emerald/50"
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
                    className="w-full rounded-xl border border-card-border bg-background py-3 pl-10 pr-4 text-sm text-foreground outline-none transition-colors duration-150 placeholder:text-foreground-muted/50 focus:border-accent-emerald/50"
                    autoComplete="username"
                  />
                </div>
              )}

              {(fieldError || error) && (
                <p className="rounded-xl bg-accent-rose/5 px-3 py-2 text-xs text-accent-rose" role="alert">
                  {fieldError || error}
                </p>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent-emerald py-3 text-sm font-semibold text-white transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
              >
                {submitting
                  ? '处理中…'
                  : mode === 'login'
                    ? <>登录 <ArrowRight size={16} aria-hidden="true" /></>
                    : <>注册 <ArrowRight size={16} aria-hidden="true" /></>
                }
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-foreground-muted">
              {mode === 'login' ? '还没有账号？' : '已有账号？'}
              <button
                type="button"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  clearError();
                  setFieldError('');
                }}
                className="ml-1 font-medium text-accent-emerald hover:underline"
              >
                {mode === 'login' ? '立即注册' : '去登录'}
              </button>
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
