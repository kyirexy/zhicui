'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/hooks/AuthContext';
import ThemeToggle from '@/components/ThemeToggle';
import QRModal from '@/components/QRModal';
import { LogIn, User } from 'lucide-react';

/**
 * Desktop-only inline header. Not fixed — scrolls with page content naturally.
 * Hidden on mobile where the BottomTabBar handles all navigation.
 */
export default function AppHeader() {
  const { user, logout } = useAuth();

  return (
    <header className="hidden md:flex items-center justify-between px-5 md:px-8 lg:px-12 py-2.5 max-w-6xl mx-auto w-full">
      <a
        href="/"
        className="flex items-center gap-2.5 text-foreground no-underline group"
      >
        <img
          src="/logo.png"
          alt="知萃 Logo"
          className="h-8 w-8 object-contain transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-110 group-hover:rotate-6"
        />
        <span className="text-lg font-bold tracking-tight">知萃</span>
      </a>

      <nav className="flex items-center gap-1">
        <a
          href="/notes"
          className="relative text-foreground-secondary hover:text-foreground transition-all duration-300 text-sm font-medium px-3.5 py-2 rounded-xl hover:bg-white/[0.06] min-h-[40px] flex items-center group/nav"
        >
          知识库
          <span className="absolute bottom-1 left-3.5 right-3.5 h-px bg-accent-emerald scale-x-0 group-hover/nav:scale-x-100 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] origin-left" />
        </a>
        <a
          href="/plans"
          className="relative text-foreground-secondary hover:text-foreground transition-all duration-300 text-sm font-medium px-3.5 py-2 rounded-xl hover:bg-white/[0.06] min-h-[40px] flex items-center group/nav"
        >
          计划
          <span className="absolute bottom-1 left-3.5 right-3.5 h-px bg-accent-emerald scale-x-0 group-hover/nav:scale-x-100 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] origin-left" />
        </a>

        {user ? (
          <div className="flex items-center gap-2 ml-2">
            <span className="text-xs text-foreground-muted flex items-center gap-1">
              <User size={12} />
              {user.email}
            </span>
            <button
              onClick={logout}
              className="text-xs text-foreground-muted/60 hover:text-foreground-muted transition-colors"
            >
              退出
            </button>
          </div>
        ) : (
          <Link
            href="/login"
            className="relative text-foreground-secondary hover:text-foreground transition-all duration-300 text-sm font-medium px-3.5 py-2 rounded-xl hover:bg-white/[0.06] min-h-[40px] flex items-center gap-1.5 ml-2"
          >
            <LogIn size={14} />
            登录
          </Link>
        )}

        <QRModal />
        <ThemeToggle />
      </nav>
    </header>
  );
}
