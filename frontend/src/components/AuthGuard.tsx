'use client';

import { useEffect } from 'react';
import Image from 'next/image';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeAndroidApp } from '@/lib/douyinNative';

/** Browser-only public pages. Installed clients treat `/` as the workspace. */
const BROWSER_PUBLIC = ['/', '/style'];
const ALWAYS_PUBLIC = ['/login'];
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
    error,
  } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { isDesktop, resolved: desktopResolved } = useDesktopApp();
  const isNativeAndroid = isNativeAndroidApp();
  const isInstalledClient = isDesktop || isNativeAndroid;
  const isPublic = ALWAYS_PUBLIC.includes(pathname)
    || (!isInstalledClient && BROWSER_PUBLIC.includes(pathname));
  const isClientOnlyPath = CLIENT_ONLY_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  const clientGateActive = !IS_DEV
    && isClientOnlyPath
    && desktopResolved
    && !isInstalledClient;
  useEffect(() => {
    if (IS_DEV || !desktopResolved || !isClientOnlyPath || isInstalledClient) return;
    router.replace('/#download');
  }, [
    desktopResolved,
    isClientOnlyPath,
    isInstalledClient,
    router,
  ]);

  useEffect(() => {
    if (!desktopResolved || clientGateActive || loading) return;
    if (!user && !isPublic) {
      const requestedPath = typeof window === 'undefined'
        ? pathname
        : `${pathname}${window.location.search}${window.location.hash}`;
      router.replace(`/login?redirect=${encodeURIComponent(requestedPath)}`);
    }
  }, [
    clientGateActive,
    isPublic,
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

  if (isPublic) {
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
