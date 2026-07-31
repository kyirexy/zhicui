'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowDown,
  DownloadSimple,
  SignIn,
  UserCircle,
} from '@phosphor-icons/react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { DESKTOP_DOWNLOAD_URL } from '@/lib/desktopRuntime';
import { isNativeAndroidApp } from '@/lib/douyinNative';
import ThemeToggle from '@/components/ThemeToggle';
import QRModal from '@/components/QRModal';
import styles from './MarketingHeader.module.css';

export default function AppHeader() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  if (pathname === '/' && nativeAndroid === null) {
    return null;
  }

  if (pathname === '/' && nativeAndroid === false) {
    return (
      <header className={`${styles.header} web-app-header`}>
        <nav className={styles.nav} aria-label="官网导航">
          <a href="/" className={styles.brand} aria-label="知萃首页">
            <img src="/logo.png" alt="" />
            <span>
              <strong>知萃</strong>
              <small>让收藏真正有用</small>
            </span>
          </a>

          <div className={styles.links}>
            <a href="/#product">产品体验</a>
            <a href="/#workflow">使用方式</a>
            <a href="/#download">
              下载客户端
              <ArrowDown size={13} weight="bold" />
            </a>
          </div>

          <div className={styles.actions}>
            {user?.is_admin && (
              <Link href="/admin" className={styles.adminLink}>
                管理端
              </Link>
            )}
            {user ? (
              <span className={styles.accountLink}>
                <UserCircle size={18} weight="light" />
                账号已登录
              </span>
            ) : (
              <Link href="/login" className={styles.accountLink}>
                <SignIn size={17} weight="light" />
                管理登录
              </Link>
            )}
            <a href={DESKTOP_DOWNLOAD_URL} className={`${styles.downloadLink} ${styles.desktopDownload}`}>
              <DownloadSimple size={17} weight="light" />
              Windows 下载
            </a>
            <a href="/download/zhicui.apk" className={`${styles.downloadLink} ${styles.mobileDownload}`}>
              <DownloadSimple size={17} weight="light" />
              Android 下载
            </a>
          </div>
        </nav>
      </header>
    );
  }

  return (
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
        {[
          ['/library', '视频库'],
          ['/agent', '视频 Agent'],
          ['/notes', '知识库'],
          ['/plans', '计划'],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            className="relative flex min-h-[40px] items-center rounded-xl px-3.5 py-2 text-sm font-medium text-foreground-secondary transition-colors hover:bg-black/[0.035] hover:text-foreground"
          >
            {label}
          </Link>
        ))}

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
            className="ml-2 flex min-h-[40px] items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium text-foreground-secondary transition-colors hover:bg-black/[0.035] hover:text-foreground"
          >
            <SignIn size={15} weight="light" />
            登录
          </Link>
        )}

        <QRModal />
        <ThemeToggle />
      </nav>
    </header>
  );
}
