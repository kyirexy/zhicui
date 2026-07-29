import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import AppHeader from '@/components/AppHeader';
import BottomTabBar from '@/components/BottomTabBar';
import GlobalSheetManager from '@/components/GlobalSheetManager';
import FeedbackButton from '@/components/FeedbackButton';
import AppUpdatePrompt from '@/components/AppUpdatePrompt';
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
  description: '把抖音收藏、喜欢和个人作品整理成可提问的视频知识库，自动生成完整文案、知识卡片与行动计划。',
  keywords: ['知萃', '抖音收藏整理', '批量视频文案', 'AI视频问答', '知识卡片', '行动计划'],
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className={inter.variable} data-scroll-behavior="smooth" suppressHydrationWarning>
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
              // A page that was already open during an atomic deployment can
              // still request an immediately previous Next.js chunk. The
              // server retains those assets for a bounded window; this is the
              // last-resort recovery if a chunk is unavailable or a stale
              // service worker cache survived. Reload at most once per minute.
              (function () {
                var recoveryKey = 'zhicui_chunk_recovery_at';
                var recovering = false;
                function isNextAsset(value) {
                  return typeof value === 'string' && value.indexOf('/_next/static/') !== -1;
                }
                function recoverFromStaleChunk() {
                  if (recovering) return;
                  var now = Date.now();
                  var previous = Number(sessionStorage.getItem(recoveryKey) || 0);
                  if (now - previous < 60000) return;
                  recovering = true;
                  sessionStorage.setItem(recoveryKey, String(now));
                  var cleanup = [];
                  if ('serviceWorker' in navigator) {
                    cleanup.push(
                      navigator.serviceWorker.getRegistrations().then(function (regs) {
                        return Promise.all(regs.map(function (registration) {
                          return registration.unregister();
                        }));
                      }).catch(function () {}),
                    );
                  }
                  if (window.caches) {
                    cleanup.push(
                      caches.keys().then(function (keys) {
                        return Promise.all(keys.map(function (key) {
                          return caches.delete(key);
                        }));
                      }).catch(function () {}),
                    );
                  }
                  Promise.all(cleanup).finally(function () {
                    location.reload();
                  });
                }
                window.addEventListener('error', function (event) {
                  var target = event.target;
                  var source = target && (target.src || target.href);
                  if (isNextAsset(source)) recoverFromStaleChunk();
                }, true);
                window.addEventListener('unhandledrejection', function (event) {
                  var message = String(event.reason && (event.reason.message || event.reason) || '');
                  if (
                    message.indexOf('ChunkLoadError') !== -1 ||
                    message.indexOf('Loading chunk') !== -1 ||
                    message.indexOf('dynamically imported module') !== -1
                  ) {
                    recoverFromStaleChunk();
                  }
                });
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
          <main className="mx-auto max-w-[1600px] px-5 pt-6 pb-24 md:px-8 md:py-8 lg:px-12 flex-1 w-full">
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
          <FeedbackButton />
          <AppUpdatePrompt />
        </Providers>
      </body>
    </html>
  );
}
