'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeAndroidApp } from '@/lib/douyinNative';

/** Public paths that don't require login. */
const PUBLIC = ['/', '/login', '/style'];
const IS_DEV = process.env.NODE_ENV === 'development';
const CLIENT_ONLY_PATHS = [
  '/agent',
  '/library',
  '/notes',
  '/plans',
  '/process',
  '/settings',
  '/style',
];

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    enteringDevelopmentSession,
    error,
    enterDevelopmentSession,
    clearError,
  } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { isDesktop, resolved: desktopResolved } = useDesktopApp();
  const isNativeAndroid = isNativeAndroidApp();
  const isPublic = PUBLIC.includes(pathname);
  const isClientOnlyPath = CLIENT_ONLY_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  const loginHref = `/login?redirect=${encodeURIComponent(pathname)}`;

  useEffect(() => {
    if (!desktopResolved || !isClientOnlyPath || isDesktop || isNativeAndroid) return;
    router.replace('/#download');
  }, [
    desktopResolved,
    isClientOnlyPath,
    isDesktop,
    isNativeAndroid,
    router,
  ]);

  useEffect(() => {
    if (
      isClientOnlyPath
      && (!desktopResolved || (!isDesktop && !isNativeAndroid))
    ) {
      return;
    }
    if (loading) return;
    if (!user && !isPublic && !IS_DEV) {
      const requestedPath = typeof window === 'undefined'
        ? pathname
        : `${pathname}${window.location.search}${window.location.hash}`;
      router.replace(`/login?redirect=${encodeURIComponent(requestedPath)}`);
    }
  }, [
    desktopResolved,
    isClientOnlyPath,
    isDesktop,
    isNativeAndroid,
    isPublic,
    user,
    loading,
    pathname,
    router,
  ]);

  if (
    isClientOnlyPath
    && (!desktopResolved || (!isDesktop && !isNativeAndroid))
  ) {
    return (
      <div className="min-h-[70dvh]" role="status" aria-label="正在前往客户端下载页面" />
    );
  }

  if (isPublic) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div
        className="flex min-h-[40dvh] items-center justify-center px-4"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="w-full max-w-sm rounded-2xl border border-card-border bg-card-background p-6 text-center shadow-sm">
          <p className="text-balance text-base font-semibold text-foreground">
            正在恢复登录状态
          </p>
          <p className="mt-2 text-pretty text-sm text-foreground-muted">
            最多等待几秒，超时后可以直接重试或前往登录。
          </p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-[40dvh] items-center justify-center px-4">
        <section
          className="w-full max-w-md rounded-2xl border border-card-border bg-card-background p-6 text-center shadow-sm"
          aria-labelledby="auth-recovery-title"
        >
          <p className="text-sm font-medium text-foreground-muted">知萃账号</p>
          <h1
            id="auth-recovery-title"
            className="mt-2 text-balance text-xl font-semibold text-foreground"
          >
            {IS_DEV ? '开发会话没有连接成功' : '需要重新登录'}
          </h1>
          <p
            className="mt-3 text-pretty text-sm leading-6 text-foreground-muted"
            role={error ? 'alert' : undefined}
          >
            {error || (
              IS_DEV
                ? '请确认本地后端已启动，然后重新连接开发会话。'
                : '登录状态已失效，正在前往登录页。'
            )}
          </p>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            {IS_DEV ? (
              <button
                type="button"
                disabled={enteringDevelopmentSession}
                onClick={() => {
                  clearError();
                  void enterDevelopmentSession();
                }}
                className="min-h-11 rounded-xl bg-foreground px-5 py-2.5 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                {enteringDevelopmentSession ? '正在重新连接…' : '重新连接开发会话'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="min-h-11 rounded-xl bg-foreground px-5 py-2.5 text-sm font-medium text-background"
              >
                刷新页面
              </button>
            )}
            <Link
              href={loginHref}
              className="inline-flex min-h-11 items-center justify-center rounded-xl border border-card-border px-5 py-2.5 text-sm font-medium text-foreground"
            >
              前往登录
            </Link>
          </div>
        </section>
      </div>
    );
  }

  return <>{children}</>;
}
