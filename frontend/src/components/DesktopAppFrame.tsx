'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Books,
  CheckSquareOffset,
  CloudCheck,
  GearSix,
  Question,
  ShieldCheck,
  SignOut,
  SquaresFour,
  UserCircle,
  VideoCamera,
} from '@phosphor-icons/react';
import {
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import AgentMark from '@/components/agent/AgentMark';
import ThemeToggle from '@/components/ThemeToggle';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  detectDesktopRuntime,
  type DesktopRuntimeInfo,
} from '@/lib/desktopRuntime';

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

const NAVIGATION: Array<{
  href: string;
  label: string;
  icon?: PhosphorIcon;
  agentMark?: true;
}> = [
  { href: '/', label: '工作台', icon: SquaresFour },
  { href: '/library', label: '视频库', icon: VideoCamera },
  { href: '/agent', label: '视频 Agent', agentMark: true },
  { href: '/notes', label: '知识库', icon: Books },
  { href: '/plans', label: '行动计划', icon: CheckSquareOffset },
];

const ROUTE_META: Array<{
  match: (pathname: string) => boolean;
  eyebrow: string;
  title: string;
}> = [
  {
    match: (pathname) => pathname.startsWith('/library/detail'),
    eyebrow: '视频库',
    title: '视频知识详情',
  },
  {
    match: (pathname) => pathname === '/library',
    eyebrow: '内容采集',
    title: '批量视频库',
  },
  {
    match: (pathname) => pathname.startsWith('/agent'),
    eyebrow: '视频资料',
    title: '视频 Agent',
  },
  {
    match: (pathname) => pathname.startsWith('/notes'),
    eyebrow: '知识沉淀',
    title: '知识库',
  },
  {
    match: (pathname) => pathname.startsWith('/plans'),
    eyebrow: '行动管理',
    title: '计划工作台',
  },
  {
    match: (pathname) => pathname.startsWith('/settings'),
    eyebrow: '应用管理',
    title: '设置',
  },
  {
    match: (pathname) => pathname.startsWith('/admin'),
    eyebrow: '系统管理',
    title: '管理端',
  },
  {
    match: (pathname) => pathname === '/',
    eyebrow: '今天',
    title: '工作台',
  },
];

export function useDesktopApp(): DesktopRuntimeState {
  return useContext(DesktopRuntimeContext);
}

function DesktopNavigation({ runtime }: { runtime: DesktopRuntimeInfo }) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const userLabel = user?.username || user?.email || '知萃用户';

  const openFeedback = () => {
    window.dispatchEvent(new CustomEvent('zhicui:open-feedback'));
  };

  const routeMeta = ROUTE_META.find((item) => item.match(pathname))
    ?? { eyebrow: '知萃', title: '工作空间' };

  return (
    <>
      <aside className="desktop-sidebar" aria-label="桌面端主导航">
        <Link
          href="/"
          className="desktop-sidebar__brand"
          aria-label="返回知萃工作台"
        >
          <span className="desktop-sidebar__brand-mark" aria-hidden="true">
            <img src="/icons/icon-192.png" alt="" />
          </span>
          <span>
            <strong>知萃</strong>
            <small>把收藏变成行动</small>
          </span>
        </Link>

        <nav className="desktop-sidebar__nav" aria-label="主要功能">
          <p className="desktop-sidebar__section-label">主要功能</p>
          {NAVIGATION.map((item) => {
            const Icon = item.icon;
            const active = item.href === '/'
              ? pathname === '/'
              : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`desktop-sidebar__nav-item ${active ? 'is-active' : ''}`}
                aria-current={active ? 'page' : undefined}
                title={item.label}
              >
                {item.agentMark ? (
                  <AgentMark variant="nav" aria-hidden="true" />
                ) : Icon ? (
                  <Icon size={20} weight={active ? 'fill' : 'light'} aria-hidden="true" />
                ) : null}
                <span>{item.label}</span>
                {active && <span className="desktop-sidebar__active-mark" aria-hidden="true" />}
              </Link>
            );
          })}
        </nav>

        <nav className="desktop-sidebar__utility" aria-label="应用与支持">
          <Link
            href="/settings"
            className={`desktop-sidebar__nav-item ${
              pathname.startsWith('/settings') ? 'is-active' : ''
            }`}
            aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
            title="设置"
          >
            <GearSix size={20} weight="light" aria-hidden="true" />
            <span>设置</span>
          </Link>
          {user?.is_admin && (
            <Link
              href="/admin"
              className={`desktop-sidebar__nav-item ${
                pathname.startsWith('/admin') ? 'is-active' : ''
              }`}
              aria-current={pathname.startsWith('/admin') ? 'page' : undefined}
            >
              <ShieldCheck size={20} weight="light" aria-hidden="true" />
              <span>管理端</span>
            </Link>
          )}
          <button
            type="button"
            className="desktop-sidebar__nav-item"
            onClick={openFeedback}
            title="反馈建议"
          >
            <Question size={20} weight="light" aria-hidden="true" />
            <span>反馈建议</span>
          </button>
        </nav>

        <div className="desktop-sidebar__account">
          <div className="desktop-sidebar__account-avatar" aria-hidden="true">
            <UserCircle size={20} weight="light" />
          </div>
          <div className="desktop-sidebar__account-copy">
            <strong title={userLabel}>{userLabel}</strong>
            <span>Windows · v{runtime.version}</span>
          </div>
          <button
            type="button"
            className="desktop-sidebar__logout"
            onClick={logout}
            aria-label="退出当前账号"
            title="退出账号"
          >
            <SignOut size={18} weight="light" aria-hidden="true" />
          </button>
        </div>
      </aside>

      <header className="desktop-context-bar">
        <div className="desktop-context-bar__route">
          <strong>{routeMeta.title}</strong>
          <span>{routeMeta.eyebrow}</span>
        </div>
        <div className="desktop-context-bar__actions">
          <span className="desktop-context-bar__status">
            <CloudCheck size={16} weight="light" aria-hidden="true" />
            云端已同步
          </span>
          <ThemeToggle />
        </div>
      </header>
    </>
  );
}

export default function DesktopAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
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
    if (isAuthRoute) {
      document.documentElement.setAttribute('data-desktop-auth', 'true');
    } else {
      document.documentElement.removeAttribute('data-desktop-auth');
    }
  }, [isAuthRoute, runtime]);

  useEffect(() => {
    const root = document.documentElement;
    if (!runtime || isAuthRoute) {
      root.removeAttribute('data-desktop-workspace');
      return;
    }
    if (pathname.startsWith('/agent')) {
      root.setAttribute('data-desktop-workspace', 'agent');
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
      {runtime && !isAuthRoute && <DesktopNavigation runtime={runtime} />}
      {children}
    </DesktopRuntimeContext.Provider>
  );
}
