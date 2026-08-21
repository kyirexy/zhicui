'use client';

import { useEffect, useRef, useState } from 'react';
import ThemeToggle from '@/components/ThemeToggle';
import QRModal from '@/components/QRModal';

/**
 * Floating glass nav pill. At the top of the page it stays nearly
 * transparent; after scrolling it solidifies (`.nav-scrolled`).
 *
 * On mobile we auto-hide the header when the user scrolls *down* past a
 * threshold and reveal it on scroll *up*, mimicking the pattern used by
 * WeChat, Weibo, YouTube, X, etc. On desktop (md+) the header is always
 * visible.
 */
export default function FloatingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);

  useEffect(() => {
    let ticking = false;

    const onScroll = () => {
      if (ticking) return;
      ticking = true;

      requestAnimationFrame(() => {
        const y = window.scrollY;

        // scrolled → glass solidifies after a tiny threshold
        setScrolled(y > 8);

        // hide ONLY on mobile (the "hidden" translate is guarded by md:
        // classes, but the state change is harmless on desktop)
        if (y > 120 && y > lastY.current) {
          // scrolling down past the show/hide threshold → hide
          setHidden(true);
        } else {
          // scrolling up (or still near the top) → show
          setHidden(false);
        }

        lastY.current = y;
        ticking = false;
      });
    };

    // seed initial value
    lastY.current = window.scrollY;

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div
      className={
        'capacitor-hide fixed top-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-4xl ' +
        'transition-transform duration-350 ease-[cubic-bezier(0.32,0.72,0,1)] ' +
        // hide the pill upward on mobile; always visible on md+
        (hidden ? '-translate-y-[calc(100%+2rem)]' : '')
      }
    >
      <header
        className={`glass nav-pill rounded-2xl px-2 py-1.5 md:px-3 md:py-2 transition-[background-color,border-color,box-shadow] duration-300 ease-out ${
          scrolled ? 'nav-scrolled' : ''
        }`}
        style={{
          boxShadow:
            '0 8px 32px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.04)',
        }}
      >
        <div className="mx-auto max-w-6xl flex items-center justify-between px-3 py-1.5 md:px-4 md:py-2">
          <a
            href="/"
            className="flex items-center gap-2.5 text-foreground no-underline group"
          >
            <img
              src="/logo.png"
              alt="知萃 Logo"
              className="h-7 w-7 md:h-8 md:w-8 object-contain transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:scale-110 group-hover:rotate-6"
            />
            <span className="text-base md:text-lg font-bold tracking-tight text-balance">
              知萃
            </span>
          </a>
          <nav className="flex items-center gap-1 md:gap-1.5">
            {/* Desktop-only: "知识库" link. On mobile, this nav item lives
                in the BottomTabBar so the top bar stays minimal. */}
            <a
              href="/notes"
              className="relative text-foreground-secondary hover:text-foreground transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] text-sm font-medium px-3.5 py-2 rounded-xl hover:bg-white/[0.06] min-h-[40px] hidden md:flex items-center group/nav"
            >
              知识库
              <span className="absolute bottom-1 left-3.5 right-3.5 h-px bg-accent-brand scale-x-0 group-hover/nav:scale-x-100 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] origin-left" />
            </a>
            {/* Desktop-only: "计划" link. Mobile equivalent in TabBar. */}
            <a
              href="/plans"
              className="relative text-foreground-secondary hover:text-foreground transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] text-sm font-medium px-3.5 py-2 rounded-xl hover:bg-white/[0.06] min-h-[40px] hidden md:flex items-center group/nav"
            >
              计划
              <span className="absolute bottom-1 left-3.5 right-3.5 h-px bg-accent-brand scale-x-0 group-hover/nav:scale-x-100 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] origin-left" />
            </a>
            <div className="hidden md:block">
              <QRModal />
            </div>
            <ThemeToggle />
          </nav>
        </div>
      </header>
    </div>
  );
}
