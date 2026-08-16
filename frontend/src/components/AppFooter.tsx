'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, DownloadSimple, ShieldCheck } from '@phosphor-icons/react';
import { isNativeAndroidApp } from '@/lib/douyinNative';
import styles from './MarketingFooter.module.css';

export default function AppFooter() {
  const pathname = usePathname();
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  if (pathname?.startsWith('/login')) {
    return null;
  }

  if (pathname === '/' && nativeAndroid === false) {
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
            <Link href="/admin">
              <ShieldCheck size={16} weight="light" />
              管理员入口
              <ArrowUpRight size={15} weight="light" />
            </Link>
          </nav>
          <p>© 2026 知萃 · 视频资料由你选择，视频文件不在服务器永久保存</p>
        </div>
      </footer>
    );
  }

  if (pathname === '/' && nativeAndroid === null) {
    return null;
  }

  return (
    <footer className="web-app-footer relative hidden border-t border-card-border/50 py-8 md:block md:py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-xs text-foreground-muted sm:flex-row md:px-6">
        <p className="flex items-center gap-2">
          <img src="/logo.png" alt="知萃 Logo" className="h-5 w-5 object-contain" />
          <span>知萃 · 把收藏变成行动</span>
        </p>
        <p className="text-foreground-muted/60">你的个人视频知识工作台</p>
      </div>
    </footer>
  );
}
