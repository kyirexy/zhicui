'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeMobileApp } from '@/lib/douyinNative';
import { resolveClientAuthPolicy } from '@/lib/clientAuthPolicy';

const IS_DEV = process.env.NODE_ENV === 'development';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const {
    user,
    loading,
    error,
  } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { isDesktop, resolved: desktopResolved } = useDesktopApp();
  const isNativeMobile = isNativeMobileApp();
  const policy = resolveClientAuthPolicy(pathname, {
    desktop: isDesktop,
    nativeMobile: isNativeMobile,
    development: IS_DEV,
  });
  const clientGateActive = desktopResolved && policy.browserClientGate;
  useEffect(() => {
    if (!desktopResolved || !policy.browserClientGate) return;
    router.replace('/#download');
  }, [
    desktopResolved,
    policy.browserClientGate,
    router,
  ]);

  useEffect(() => {
    if (!desktopResolved || clientGateActive || loading) return;
    if (!user && !policy.publicRoute) {
      const requestedPath = typeof window === 'undefined'
        ? pathname
        : `${pathname}${window.location.search}${window.location.hash}`;
      router.replace(`/login?redirect=${encodeURIComponent(requestedPath)}`);
    }
  }, [
    clientGateActive,
    policy.publicRoute,
    user,
    loading,
    pathname,
    router,
  ]);

  const startup = (label: string) => (
    <div
      className="flex min-h-[calc(100dvh-4rem)] items-center justify-center px-5"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex items-center gap-3 rounded-2xl border border-card-border bg-white px-5 py-4 shadow-sm">
        <Image
          src="/logo.png"
          alt=""
          width={42}
          height={42}
          className="size-10 object-contain"
          priority
        />
        <div>
          <strong className="block text-sm font-semibold text-foreground">知萃</strong>
          <span className="mt-0.5 block text-xs text-foreground-muted">{label}</span>
        </div>
      </div>
    </div>
  );

  if (!desktopResolved) {
    return startup('正在启动客户端…');
  }

  if (clientGateActive) {
    return (
      <div className="min-h-[70dvh]" role="status" aria-label="正在前往客户端下载页面" />
    );
  }

  if (policy.publicRoute) {
    return <>{children}</>;
  }

  if (loading) {
    return startup('正在恢复账号…');
  }

  if (!user) {
    return startup(error || '正在前往登录与注册…');
  }

  return <>{children}</>;
}
