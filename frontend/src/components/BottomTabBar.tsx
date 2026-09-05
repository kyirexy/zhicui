'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { getPlanStats } from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import { isNativeAndroidApp } from '@/lib/douyinNative';
import {
  PRODUCT_DESTINATIONS,
  isProductDestinationActive,
} from '@/lib/productNavigation';
import { PRODUCT_NAVIGATION_ICONS } from '@/lib/productNavigationIcons';

export default function BottomTabBar() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const { user, loading: authLoading } = useAuth();
  const [planBadge, setPlanBadge] = useState(0);
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);
  const [pendingTab, setPendingTab] = useState<string | null>(null);

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  useEffect(() => {
    if (!user) return;
    PRODUCT_DESTINATIONS.forEach((destination) => router.prefetch(destination.href));
  }, [router, user]);

  useEffect(() => {
    setPendingTab(null);
  }, [pathname]);

  // A8: Fetch plan stats for badge. Refresh every 60s while mounted.
  useEffect(() => {
    if (authLoading || !user || pathname.startsWith('/login')) return undefined;
    if (pathname === '/' && nativeAndroid !== true) return undefined;
    const fetch = () => {
      getPlanStats().then((res) => {
        if (res.success && res.data) setPlanBadge(res.data.open_tasks);
      });
    };
    fetch();
    const interval = setInterval(fetch, 60_000);
    return () => clearInterval(interval);
  }, [authLoading, nativeAndroid, pathname, user]);

  if (authLoading || !user || pathname.startsWith('/login')) {
    return null;
  }

  if (pathname === '/' && nativeAndroid !== true) {
    return null;
  }

  return (
    <nav
      className="mobile-bottom-nav fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="底部导航"
    >
      <div className="border-t border-card-border bg-background">
        <ul className="flex h-16 items-stretch justify-around">
          {PRODUCT_DESTINATIONS.map((tab) => {
            const active = isProductDestinationActive(tab.id, pathname);
            const visuallyActive = active || pendingTab === tab.id;
            const Icon = PRODUCT_NAVIGATION_ICONS[tab.id];
            const badge = tab.id === 'plans' ? planBadge : 0;
            const showBadge = badge > 0;
            const badgeLabel = badge > 9 ? '9+' : String(badge);

            const innerClass = `relative flex h-full min-h-11 w-full touch-manipulation select-none flex-col items-center justify-center gap-1 px-1 transition-[color,background-color,transform] duration-100 active:scale-[0.97] active:bg-background-secondary ${
              visuallyActive ? 'text-foreground' : 'text-foreground-muted hover:text-foreground-secondary'
            }`;

            const inner = (
              <>
                {showBadge && (
                  <span className="absolute top-1.5 right-1/2 translate-x-[16px] min-w-[16px] h-[16px] rounded-full bg-foreground text-background text-[10px] font-bold flex items-center justify-center px-1"
                    aria-label={`${tab.label} ${badgeLabel} 个未完成`}>
                    {badgeLabel}
                  </span>
                )}
                <Icon
                  size={22}
                  strokeWidth={visuallyActive ? 2.4 : 1.8}
                  aria-hidden="true"
                />
                <span className="text-[11px] font-medium leading-none">{tab.mobileLabel}</span>
                {visuallyActive && <span className="absolute top-0 h-0.5 w-7 rounded-full bg-foreground" />}
              </>
            );

            return (
              <li key={tab.id} className="flex-1 min-w-0">
                <Link
                  href={tab.href}
                  prefetch
                  draggable={false}
                  className={innerClass}
                  aria-label={tab.label}
                  aria-current={active ? 'page' : undefined}
                  onPointerDown={() => router.prefetch(tab.href)}
                  onClick={() => setPendingTab(tab.id)}
                >
                  {inner}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
