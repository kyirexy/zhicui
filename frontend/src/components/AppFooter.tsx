'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, DownloadSimple, ShieldCheck } from '@phosphor-icons/react';
import { isNativeMobileApp } from '@/lib/douyinNative';
import { useAuth } from '@/lib/hooks/AuthContext';
import { PUBLIC_INFORMATION_LINKS } from '@/lib/legalDocuments';
import styles from './MarketingFooter.module.css';

export default function AppFooter() {
  const pathname = usePathname();
  const { user } = useAuth();
  const [nativeMobile, setNativeMobile] = useState<boolean | null>(null);

  useEffect(() => {
    setNativeMobile(isNativeMobileApp());
  }, []);

  if (pathname?.startsWith('/login')) {
    return null;
  }

  if (pathname === '/' && nativeMobile === false) {
    return (
      <footer className={`${styles.footer} web-app-footer`}>
        <div className={styles.inner}>
          <div className={styles.identity}>
            <img src="/logo.png" alt="" />
            <div>
              <strong>知萃</strong>
              <span>把收藏夹里的视频，变成随时能问、真正能用的知识。</span>
            </div>
          </div>
          <nav aria-label="页脚导航">
            <a href="/#download">
              <DownloadSimple size={16} weight="light" />
              下载客户端
            </a>
            {user?.is_admin && (
              <Link href="/admin">
                <ShieldCheck size={16} weight="light" />
                管理员入口
                <ArrowUpRight size={15} weight="light" />
              </Link>
            )}
            {PUBLIC_INFORMATION_LINKS.map((item) => (
              <Link key={item.href} href={item.href}>{item.label}</Link>
            ))}
          </nav>
          <p>© 2026 知萃</p>
        </div>
      </footer>
    );
  }

  if (pathname === '/' && nativeMobile === null) {
    return null;
  }

  return (
    <footer className="web-app-footer relative hidden border-t border-card-border/50 py-8 md:block md:py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-xs text-foreground-muted sm:flex-row md:px-6">
        <p className="flex items-center gap-2">
          <img src="/logo.png" alt="知萃 Logo" className="h-5 w-5 object-contain" />
          <span>知萃 · 把收藏变成行动</span>
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2" aria-label="法律与支持">
          {PUBLIC_INFORMATION_LINKS.map((item) => (
            <Link key={item.href} href={item.href} className="min-h-11 inline-flex items-center hover:text-foreground">
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
