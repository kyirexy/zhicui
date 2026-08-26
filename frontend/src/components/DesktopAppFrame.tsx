'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ChevronUp,
  CircleUserRound,
  Download,
  Sparkles,
  ShieldCheck,
  LogOut,
  Settings,
  Smartphone,
} from 'lucide-react';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  DESKTOP_PRODUCT_DESTINATIONS,
  isDesktopProductDestinationActive,
} from '@/lib/productNavigation';
import { PRODUCT_NAVIGATION_ICONS } from '@/lib/productNavigationIcons';
import {
  detectDesktopRuntime,
  type DesktopRuntimeInfo,
} from '@/lib/desktopRuntime';
import DesktopSidebarUpdate from '@/components/DesktopSidebarUpdate';

interface DesktopRuntimeState {
  isDesktop: boolean;
  resolved: boolean;
  runtime: DesktopRuntimeInfo | null;
}

const DesktopRuntimeContext = createContext<DesktopRuntimeState>({
  isDesktop: false,
  resolved: false,
  runtime: null,
});

export function useDesktopApp(): DesktopRuntimeState {
  return useContext(DesktopRuntimeContext);
}

function DesktopNavigation() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const userLabel = user?.username || user?.email || '知萃用户';
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setAccountMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountMenuOpen(false);
        accountTriggerRef.current?.focus();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [accountMenuOpen]);

  return (
    <>
      <aside className="desktop-sidebar" aria-label="桌面端主导航">
        <Link
          href="/"
          prefetch={false}
          className="desktop-sidebar__brand"
          aria-label="返回知萃工作台"
          onPointerEnter={() => router.prefetch('/')}
          onFocus={() => router.prefetch('/')}
        >
          <span className="desktop-sidebar__brand-mark" aria-hidden="true">
            <img src="/icons/icon-192.png" alt="" />
          </span>
          <span>
            <strong>知萃</strong>
          </span>
        </Link>

        <nav className="desktop-sidebar__nav" aria-label="主导航">
          {DESKTOP_PRODUCT_DESTINATIONS.map((item) => {
            const Icon = PRODUCT_NAVIGATION_ICONS[item.id];
            const active = isDesktopProductDestinationActive(item.id, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                className={`desktop-sidebar__nav-item ${active ? 'is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={item.label}
                onPointerEnter={() => router.prefetch(item.href)}
                onFocus={() => router.prefetch(item.href)}
              >
                <Icon size={20} strokeWidth={active ? 2.25 : 1.8} aria-hidden="true" />
                <span>{item.label}</span>
                {active && <span className="desktop-sidebar__active-mark" aria-hidden="true" />}
              </Link>
            );
          })}
        </nav>

        <nav className="desktop-sidebar__utility" aria-label="应用与支持">
          <a
            href="/api/client-downloads/android"
            download
            className="desktop-sidebar__mobile-download"
            aria-label="下载知萃 Android 移动端安装包"
            title="下载 Android APK"
          >
            <span className="desktop-sidebar__mobile-download-icon" aria-hidden="true">
              <Smartphone size={20} strokeWidth={1.8} />
            </span>
            <span className="desktop-sidebar__mobile-download-copy">
              <strong>下载移动端</strong>
            </span>
            <Download size={17} aria-hidden="true" />
          </a>
        </nav>

        <DesktopSidebarUpdate />

        <div className="desktop-sidebar__account-shell" ref={accountMenuRef}>
          {accountMenuOpen && (
            <div className="desktop-sidebar__account-menu" aria-label="账户菜单">
              <div className="desktop-sidebar__account-menu-profile">
                <span className="desktop-sidebar__account-menu-avatar" aria-hidden="true">
                  {userLabel.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{userLabel}</strong>
                  {user?.email && user.email !== userLabel && <small>{user.email}</small>}
                </span>
              </div>
              <div className="desktop-sidebar__account-menu-group">
                <Link href="/settings" prefetch={false}>
                  <Settings size={18} aria-hidden="true" />
                  <span>设置</span>
                  <kbd>Ctrl+,</kbd>
                </Link>
                <Link href="/ai-routing" prefetch={false}>
                  <Sparkles size={18} aria-hidden="true" />
                  <span>AI 助手</span>
                </Link>
                {user?.is_admin && (
                  <Link href="/admin" prefetch={false}>
                    <ShieldCheck size={18} aria-hidden="true" />
                    <span>管理端</span>
                  </Link>
                )}
              </div>
              <button
                type="button"
                className="desktop-sidebar__account-menu-signout"
                onClick={() => {
                  setAccountMenuOpen(false);
                  logout();
                }}
              >
                <LogOut size={18} aria-hidden="true" />
                <span>退出登录</span>
              </button>
            </div>
          )}

          <button
            ref={accountTriggerRef}
            type="button"
            className={`desktop-sidebar__account ${accountMenuOpen ? 'is-open' : ''}`}
            aria-haspopup="menu"
            aria-expanded={accountMenuOpen}
            onClick={() => setAccountMenuOpen((open) => !open)}
          >
            <span className="desktop-sidebar__account-avatar" aria-hidden="true">
              <CircleUserRound size={20} strokeWidth={1.8} />
            </span>
            <span className="desktop-sidebar__account-copy">
              <strong>{userLabel}</strong>
            </span>
            <ChevronUp
              className="desktop-sidebar__account-caret"
              size={15}
              aria-hidden="true"
            />
          </button>
        </div>
      </aside>

      <header className="desktop-context-bar" aria-hidden="true" />
    </>
  );
}

export default function DesktopAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [resolved, setResolved] = useState(false);
  const isAuthRoute = pathname.startsWith('/login') || pathname.startsWith('/register');

  useEffect(() => {
    let active = true;
    detectDesktopRuntime()
      .then((info) => {
        if (!active) return;
        if (info) {
          document.documentElement.setAttribute('data-desktop-app', 'true');
          setRuntime(info);
        } else {
          document.documentElement.removeAttribute('data-desktop-app');
        }
      })
      .finally(() => {
        if (
          document.documentElement.getAttribute('data-desktop-app')
          === 'pending'
        ) {
          document.documentElement.removeAttribute('data-desktop-app');
        }
        if (active) setResolved(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return;
    if (isAuthRoute || authLoading || !user) {
      document.documentElement.setAttribute('data-desktop-auth', 'true');
    } else {
      document.documentElement.removeAttribute('data-desktop-auth');
    }
  }, [authLoading, isAuthRoute, runtime, user]);

  useEffect(() => {
    const root = document.documentElement;
    if (!runtime || isAuthRoute) {
      root.removeAttribute('data-desktop-workspace');
      return;
    }
    if (pathname.startsWith('/harness')) {
      root.setAttribute('data-desktop-workspace', 'agent');
    } else if (pathname.startsWith('/extract')) {
      root.setAttribute('data-desktop-workspace', 'extract');
    } else if (pathname.startsWith('/settings')) {
      root.setAttribute('data-desktop-workspace', 'settings');
    } else if (pathname === '/library') {
      root.setAttribute('data-desktop-workspace', 'library');
    } else {
      root.removeAttribute('data-desktop-workspace');
    }
    return () => root.removeAttribute('data-desktop-workspace');
  }, [isAuthRoute, pathname, runtime]);

  const value = useMemo<DesktopRuntimeState>(() => ({
    isDesktop: Boolean(runtime),
    resolved,
    runtime,
  }), [resolved, runtime]);

  return (
    <DesktopRuntimeContext.Provider value={value}>
      {runtime && !isAuthRoute && !authLoading && user && <DesktopNavigation />}
      {children}
    </DesktopRuntimeContext.Provider>
  );
}
