'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, BookOpen, CheckSquare, Grid3X3, Settings } from 'lucide-react';
import { getPlanStats } from '@/lib/api';

interface TabDef {
  key: string;
  label: string;
  href: string;
  Icon: typeof Home;
  isActive: (pathname: string) => boolean;
}

const ALL_TABS: TabDef[] = [
  { key: 'home', label: '首页', href: '/', Icon: Home, isActive: (p) => p === '/' || p === '' },
  { key: 'library', label: '视频库', href: '/library', Icon: Grid3X3, isActive: (p) => p.startsWith('/library') },
  { key: 'notes', label: '知识库', href: '/notes', Icon: BookOpen, isActive: (p) => p.startsWith('/notes') },
  { key: 'plans', label: '计划', href: '/plans', Icon: CheckSquare, isActive: (p) => p.startsWith('/plans') },
  { key: 'settings', label: '设置', href: '/settings', Icon: Settings, isActive: (p) => p.startsWith('/settings') },
];

export default function BottomTabBar() {
  const pathname = usePathname() ?? '/';
  const [planBadge, setPlanBadge] = useState(0);

  // A8: Fetch plan stats for badge. Refresh every 60s while mounted.
  useEffect(() => {
    const fetch = () => {
      getPlanStats().then((res) => {
        if (res.success && res.data) setPlanBadge(res.data.open_tasks);
      });
    };
    fetch();
    const interval = setInterval(fetch, 60_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="底部导航"
    >
      <div className="glass border-t border-card-border/60"
        style={{ backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)' }}>
        <ul className="flex items-stretch justify-around h-[60px]">
          {ALL_TABS.map((tab) => {
            const active = tab.isActive(pathname);
            const badge = tab.key === 'plans' ? planBadge : 0;
            const showBadge = badge > 0;
            const badgeLabel = badge > 9 ? '9+' : String(badge);

            const innerClass = `flex flex-col items-center justify-center gap-1 h-full w-full px-2 transition-colors duration-200 relative ${
              active ? 'text-accent-emerald' : 'text-foreground-muted hover:text-foreground-secondary'
            }`;

            const inner = (
              <>
                {showBadge && (
                  <span className="absolute top-1.5 right-1/2 translate-x-[16px] min-w-[16px] h-[16px] rounded-full bg-accent-rose text-white text-[10px] font-bold flex items-center justify-center px-1"
                    aria-label={`${tab.label} ${badgeLabel} 个未完成`}>
                    {badgeLabel}
                  </span>
                )}
                <tab.Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
                <span className="text-[11px] font-medium leading-none">{tab.label}</span>
                {active && <span className="absolute top-1 w-1 h-1 rounded-full bg-accent-emerald" />}
              </>
            );

            return (
              <li key={tab.key} className="flex-1 min-w-0">
                <Link href={tab.href} className={innerClass} aria-label={tab.label} aria-current={active ? 'page' : undefined}>{inner}</Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
