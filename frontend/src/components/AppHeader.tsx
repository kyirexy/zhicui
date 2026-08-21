'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DownloadSimple,
  GearSix,
  SignIn,
  UserCircle,
} from '@phosphor-icons/react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import { useCreatorSync } from '@/lib/hooks/CreatorSyncContext';
import { isNativeAndroidApp } from '@/lib/douyinNative';
import QRModal from '@/components/QRModal';
import { PRODUCT_DESTINATIONS, isProductDestinationActive } from '@/lib/productNavigation';
import styles from './MarketingHeader.module.css';

export default function AppHeader() {
  const pathname = usePathname();
  const { user, loading: authLoading, logout } = useAuth();
  const { activeItemCount, attentionItemCount } = useVideoAnalysis();
  const { activeRuns: activeCreatorRuns } = useCreatorSync();
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);
  const analysisTaskCount = activeItemCount + attentionItemCount;
  const analysisStatusText = attentionItemCount > 0
    ? (activeItemCount > 0
      ? `解析中 ${activeItemCount} · 待确认 ${attentionItemCount}`
      : `待确认 ${attentionItemCount}`)
    : `解析中 ${activeItemCount}`;

  const openAnalysisTasks = () => {
    window.dispatchEvent(new Event('vc:open-video-analysis-sheet'));
  };
  const openCreatorSyncTasks = () => {
    window.dispatchEvent(new Event('vc:open-creator-sync-sheet'));
  };

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  if (pathname?.startsWith('/login')) {
    return null;
  }

  if (nativeAndroid === true && (authLoading || !user)) {
    return null;
  }

  if (pathname === '/' && nativeAndroid === null) {
    return null;
  }

  if (pathname === '/' && nativeAndroid === false) {
    return (
      <header className={`${styles.header} web-app-header`}>
        <nav className={styles.nav} aria-label="官网导航">
          <a href="/" className={styles.brand} aria-label="知萃首页">
            <img src="/logo.png" alt="" />
            <strong>知萃</strong>
          </a>

          <div className={styles.links}>
            <a href="/#product">核心功能</a>
          </div>

          <div className={styles.actions}>
            {user?.is_admin && (
              <Link href="/admin" className={styles.adminLink}>
                <GearSix size={16} weight="light" aria-hidden="true" />
                <span>管理端</span>
              </Link>
            )}
            <a href="/#download" className={styles.downloadLink}>
              <DownloadSimple size={17} weight="light" />
              下载客户端
            </a>
          </div>
        </nav>
      </header>
    );
  }

  return (
    <>
      {analysisTaskCount > 0 && (
        <button
          type="button"
          onClick={openAnalysisTasks}
          aria-label={`查看详细解析任务：${analysisStatusText}`}
          className="mx-4 mt-2 flex min-h-11 items-center justify-center rounded-lg border border-accent-brand/25 bg-accent-brand/7 px-3 text-sm font-semibold text-accent-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-brand md:hidden"
        >
          {analysisStatusText}
        </button>
      )}
      {activeCreatorRuns.length > 0 && (
        <button
          type="button"
          onClick={openCreatorSyncTasks}
          aria-label={`查看博主同步任务：同步中 ${activeCreatorRuns.length}`}
          className="mx-4 mt-2 flex min-h-11 items-center justify-center rounded-lg border border-card-border bg-card-bg px-3 text-sm font-semibold text-foreground-secondary md:hidden"
        >
          同步中 {activeCreatorRuns.length}
        </button>
      )}
      <header className="web-app-header sticky top-0 z-30 hidden w-full border-b border-card-border/80 bg-background/85 backdrop-blur-xl md:block">
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-5 py-2.5 md:px-8 lg:px-12">
      <a href="/" className="group flex items-center gap-2.5 text-foreground no-underline">
        <img
          src="/logo.png"
          alt="知萃 Logo"
          className="h-8 w-8 rounded-[0.65rem] object-contain transition-transform duration-300 group-hover:scale-105"
        />
        <span className="text-[1.05rem] font-bold tracking-tight">知萃</span>
      </a>

      <nav className="flex items-center gap-1" aria-label="产品导航">
        {PRODUCT_DESTINATIONS.map(({ id, href, label }) => {
          const active = isProductDestinationActive(id, pathname || '/');
          return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`relative flex min-h-10 items-center rounded-[0.6rem] px-3.5 py-2 text-sm font-medium transition-colors hover:bg-foreground/[0.045] ${active ? 'bg-accent-brand/[0.09] text-accent-brand' : 'text-foreground-secondary hover:text-foreground'}`}
          >
            {label}
          </Link>
          );
        })}

        {analysisTaskCount > 0 && (
          <button
            type="button"
            onClick={openAnalysisTasks}
            aria-label={`查看详细解析任务：${analysisStatusText}`}
            className="ml-1 flex min-h-10 items-center rounded-[0.6rem] px-3 py-2 text-sm font-semibold text-accent-brand transition-colors hover:bg-accent-brand/[0.07]"
          >
            {analysisStatusText}
          </button>
        )}
        {activeCreatorRuns.length > 0 && (
          <button
            type="button"
            onClick={openCreatorSyncTasks}
            aria-label={`查看博主同步任务：同步中 ${activeCreatorRuns.length}`}
            className="ml-1 flex min-h-10 items-center rounded-[0.6rem] px-3 py-2 text-sm font-semibold text-foreground-secondary transition-colors hover:bg-foreground/[0.045]"
          >
            同步中 {activeCreatorRuns.length}
          </button>
        )}

        {user ? (
          <div className="ml-2 flex items-center gap-2">
            {user.is_admin && (
              <Link href="/admin" className="px-2 py-1 text-xs font-medium text-accent-brand hover:underline">
                管理端
              </Link>
            )}
            <span className="flex items-center gap-1.5 rounded-full border border-card-border bg-card-bg py-1 pl-1 pr-3 text-xs font-medium text-foreground-secondary">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-brand/[0.12] text-accent-brand">
                <UserCircle size={15} weight="fill" />
              </span>
              {user.username || user.email}
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-xs text-foreground-muted transition-colors hover:text-foreground"
            >
              退出
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="ml-2 flex min-h-10 items-center gap-1.5 rounded-[0.6rem] bg-accent-brand px-4 py-2 text-sm font-semibold text-white shadow-[0_1px_2px_rgba(16,24,40,0.08),0_6px_16px_-4px_color-mix(in_srgb,var(--accent-brand)_45%,transparent)] transition-all hover:bg-accent-brand-strong"
          >
            <SignIn size={15} weight="light" />
            登录
          </Link>
        )}

        <QRModal />
      </nav>
      </div>
      </header>
    </>
  );
}
