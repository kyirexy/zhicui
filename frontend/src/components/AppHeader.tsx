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
          className="mx-4 mt-2 flex min-h-11 items-center justify-center rounded-lg border border-accent-emerald/25 bg-accent-emerald/7 px-3 text-sm font-semibold text-accent-emerald focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emerald md:hidden"
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
      <header className="web-app-header hidden w-full max-w-6xl items-center justify-between px-5 py-2.5 md:mx-auto md:flex md:px-8 lg:px-12">
      <a href="/" className="group flex items-center gap-2.5 text-foreground no-underline">
        <img
          src="/logo.png"
          alt="知萃 Logo"
          className="h-8 w-8 object-contain transition-transform duration-300 group-hover:rotate-3 group-hover:scale-105"
        />
        <span className="text-lg font-bold tracking-tight">知萃</span>
      </a>

      <nav className="flex items-center gap-1" aria-label="产品导航">
        {PRODUCT_DESTINATIONS.map(({ id, href, label }) => {
          const active = isProductDestinationActive(id, pathname || '/');
          return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`relative flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors hover:bg-black/[0.035] hover:text-foreground ${active ? 'text-accent-emerald' : 'text-foreground-secondary'}`}
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
            className="ml-1 flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-semibold text-accent-emerald transition-colors hover:bg-accent-emerald/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emerald"
          >
            {analysisStatusText}
          </button>
        )}
        {activeCreatorRuns.length > 0 && (
          <button
            type="button"
            onClick={openCreatorSyncTasks}
            aria-label={`查看博主同步任务：同步中 ${activeCreatorRuns.length}`}
            className="ml-1 flex min-h-11 items-center rounded-xl px-3 py-2 text-sm font-semibold text-foreground-secondary transition-colors hover:bg-black/[0.035]"
          >
            同步中 {activeCreatorRuns.length}
          </button>
        )}

        {user ? (
          <div className="ml-2 flex items-center gap-2">
            {user.is_admin && (
              <Link href="/admin" className="px-2 py-1 text-xs text-accent-emerald hover:underline">
                管理端
              </Link>
            )}
            <span className="flex items-center gap-1 text-xs text-foreground-muted">
              <UserCircle size={14} weight="light" />
              {user.username || user.email}
            </span>
            <button
              type="button"
              onClick={logout}
              className="text-xs text-foreground-muted/70 transition-colors hover:text-foreground"
            >
              退出
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="ml-2 flex min-h-11 items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-foreground-secondary transition-colors hover:bg-black/[0.035] hover:text-foreground"
          >
            <SignIn size={15} weight="light" />
            登录
          </Link>
        )}

        <QRModal />
      </nav>
      </header>
    </>
  );
}
