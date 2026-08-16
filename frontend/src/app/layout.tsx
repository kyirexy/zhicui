import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import AppHeader from '@/components/AppHeader';
import AppFooter from '@/components/AppFooter';
import BottomTabBar from '@/components/BottomTabBar';
import GlobalSheetManager from '@/components/GlobalSheetManager';
import FeedbackButton from '@/components/FeedbackButton';
import AppUpdatePrompt from '@/components/AppUpdatePrompt';
import DesktopUpdatePrompt from '@/components/DesktopUpdatePrompt';
import DesktopAppFrame from '@/components/DesktopAppFrame';
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
  themeColor: '#ffffff',
};

export const metadata: Metadata = {
  title: '知萃 · 把收藏夹里的视频变成能问、能用的知识',
  description: '同步你选择的抖音收藏、喜欢或作品，自动提取完整文稿，基于一条或多条视频提问，并把有用内容转成行动计划。',
  keywords: ['知萃', '抖音收藏整理', '批量视频文案', 'AI视频问答', '视频资料助手', '行动计划'],
  manifest: '/manifest.json',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      translate="no"
      className={inter.variable}
      data-scroll-behavior="smooth"
      data-theme="light"
      data-theme-preference="light"
      suppressHydrationWarning
    >
      <head>
        <meta name="google" content="notranslate" />
        <link rel="icon" href="/icons/icon-192.png" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                var storedAppearance = {};
                try {
                  storedAppearance = JSON.parse(localStorage.getItem('videocapsule-settings') || '{}') || {};
                } catch (error) {}
                var legacyTheme = localStorage.getItem('theme');
                var themeOptions = ['light', 'dark', 'system'];
                var preference = themeOptions.indexOf(storedAppearance.theme) >= 0
                  ? storedAppearance.theme
                  : themeOptions.indexOf(legacyTheme) >= 0
                    ? legacyTheme
                    : themeOptions.indexOf(storedAppearance.desktopSidebar) >= 0
                      ? storedAppearance.desktopSidebar
                      : 'light';
                var effectiveTheme = preference === 'system'
                  ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
                  : preference;
                document.documentElement.setAttribute('data-theme', effectiveTheme);
                document.documentElement.setAttribute('data-theme-preference', preference);
                document.documentElement.setAttribute('data-desktop-sidebar', effectiveTheme);
                document.documentElement.style.colorScheme = effectiveTheme;
              } catch (e) {}
              // Detect Capacitor native app — hide web-only elements.
              (function () {
                try {
                  if (window.Capacitor && window.Capacitor.isNativePlatform()) {
                    document.documentElement.setAttribute('data-capacitor', 'true');
                  }
                } catch (e) {}
              })();
              // Prevent the browser-oriented shell from flashing while the
              // trusted Electron preload bridge is being verified.
              (function () {
                try {
                  if (window.zhicuiDesktop) {
                    document.documentElement.setAttribute('data-desktop-app', 'pending');
                    if (window.location.pathname.indexOf('/agent') === 0) {
                      document.documentElement.setAttribute('data-desktop-workspace', 'agent');
                    }
                    var storedSettings = {};
                    try {
                      storedSettings = JSON.parse(localStorage.getItem('videocapsule-settings') || '{}');
                    } catch (error) {}
                    var density = ['comfortable', 'compact'].indexOf(storedSettings.desktopDensity) >= 0
                      ? storedSettings.desktopDensity
                      : 'comfortable';
                    document.documentElement.setAttribute('data-desktop-density', density);
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
                  var previous = 0;
                  try {
                    previous = Number(sessionStorage.getItem(recoveryKey) || 0);
                  } catch (error) {}
                  if (now - previous < 60000) return;
                  recovering = true;
                  try {
                    sessionStorage.setItem(recoveryKey, String(now));
                  } catch (error) {}
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
                  var reloadStarted = false;
                  function reloadOnce() {
                    if (reloadStarted) return;
                    reloadStarted = true;
                    location.reload();
                  }
                  var reloadFallback = window.setTimeout(reloadOnce, 1500);
                  Promise.all(cleanup).finally(function () {
                    window.clearTimeout(reloadFallback);
                    reloadOnce();
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
              // Service Worker cleanup is intentionally web-wide. Previous
              // releases cached HTML and Next.js chunks, so every current page
              // removes old registrations and Cache Storage entries. Do not
              // register /sw.js again: that file now only exists so browsers
              // with an older registration can update to a one-time cleanup
              // worker and relinquish control.
              (function () {
                if ('serviceWorker' in navigator) {
                  navigator.serviceWorker.getRegistrations().then(function (regs) {
                    return Promise.all(regs.map(function (registration) {
                      return registration.unregister();
                    }));
                  }).catch(function () {});
                }
                if (window.caches) {
                  caches.keys().then(function (keys) {
                    return Promise.all(keys.map(function (key) {
                      return caches.delete(key);
                    }));
                  }).catch(function () {});
                }
              })();
            `,
          }}
        />
      </head>
      <body className="min-h-[100dvh] flex flex-col bg-background">
        <Providers>
          <DesktopAppFrame>
            {/* Desktop-only inline header — not fixed, scrolls with content.
                Hidden on mobile where BottomTabBar handles all navigation. */}
            <AppHeader />

            {/* Main content — extra bottom padding on mobile so content clears
                the fixed BottomTabBar (60px tabbar + safe-area + breathing room). */}
            <main className="app-main mx-auto max-w-[1600px] px-4 pt-4 md:px-8 md:py-8 lg:px-12 flex-1 w-full">
              <AuthGuard>
                <GlobalSheetManager />
                {children}
              </AuthGuard>
            </main>

            <AppFooter />

            {/* Mobile-only: bottom tab bar (hidden on md+). */}
            <BottomTabBar />
            <FeedbackButton />
            <AppUpdatePrompt />
            <DesktopUpdatePrompt />
          </DesktopAppFrame>
        </Providers>
      </body>
    </html>
  );
}
