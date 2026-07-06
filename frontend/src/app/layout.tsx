import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import AppHeader from '@/components/AppHeader';
import BottomTabBar from '@/components/BottomTabBar';
import GlobalSheetManager from '@/components/GlobalSheetManager';
import AuthGuard from '@/components/AuthGuard';
import Providers from './Providers';
import './globals.css';

const inter = localFont({
  src: './InterVariable.woff2',
  display: 'swap',
  variable: '--font-inter',
  weight: '100 900',
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#10b981',
};

export const metadata: Metadata = {
  title: '知萃 · 视频知识萃取工具',
  description: 'AI 驱动的视频知识萃取工具。粘贴视频链接，自动生成结构化知识卡片、任务计划和行动清单。',
  keywords: ['知萃', '视频知识萃取', 'AI知识卡片', '视频笔记', '哔哩哔哩', 'YouTube', 'KnowBrew'],
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={inter.variable} suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const theme = localStorage.getItem('theme') || 'light';
                document.documentElement.setAttribute('data-theme', theme);
              } catch (e) {}
              // Detect Capacitor native app — hide web-only elements.
              (function () {
                try {
                  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
                    document.documentElement.setAttribute('data-capacitor', 'true');
                  }
                } catch (e) {}
              })();
              // Service Worker is production-only. In dev (localhost / 127.0.0.1
              // / *.local), Turbopack rotates chunk hashes on every edit, but a
              // cache-first SW keeps serving stale chunks → 404 → Next refresh
              // → SW returns stale HTML → infinite reload loop. So in dev we
              // also actively unregister any SW that a previous prod build (or
              // a previous version of this app) left behind, and clear its
              // caches.
              (function () {
                if (!('serviceWorker' in navigator)) return;
                var host = location.hostname;
                var isDev =
                  host === 'localhost' ||
                  host === '127.0.0.1' ||
                  host === '0.0.0.0' ||
                  host.endsWith('.local');
                if (isDev) {
                  navigator.serviceWorker.getRegistrations().then(function (regs) {
                    regs.forEach(function (r) { r.unregister(); });
                  }).catch(function () {});
                  if (window.caches) {
                    caches.keys().then(function (keys) {
                      keys.forEach(function (k) { caches.delete(k); });
                    }).catch(function () {});
                  }
                  return;
                }
                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/sw.js').catch(function () {});
                });
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-[100dvh] flex flex-col bg-background">
        <Providers>
          {/* Desktop-only inline header — not fixed, scrolls with content.
              Hidden on mobile where BottomTabBar handles all navigation. */}
          <AppHeader />

          {/* Main content — extra bottom padding on mobile so content clears
              the fixed BottomTabBar (60px tabbar + safe-area + breathing room). */}
          <main className="mx-auto max-w-6xl px-5 pt-6 pb-24 md:px-8 md:py-8 lg:px-12 flex-1 w-full">
            <AuthGuard>
              <GlobalSheetManager />
              {children}
            </AuthGuard>
          </main>

          {/* Footer — desktop only. On mobile the BottomTabBar replaces it. */}
          <footer className="relative border-t border-card-border/50 py-8 md:py-10 hidden md:block">
            <div className="mx-auto max-w-6xl px-4 md:px-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-foreground-muted text-xs">
              <p className="flex items-center gap-2">
                <img src="/logo.png" alt="知萃 Logo" className="h-5 w-5 object-contain" />
                <span>知萃 · 萃取视频里的全部干货</span>
              </p>
              <p className="text-foreground-muted/60">知识卡片提取工具</p>
            </div>
          </footer>

          {/* Mobile-only: bottom tab bar (hidden on md+). */}
          <BottomTabBar />
        </Providers>
      </body>
    </html>
  );
}
