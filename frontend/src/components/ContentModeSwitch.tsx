'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Grid3X3, Link2 } from 'lucide-react';

const MODES = [
  {
    href: '/',
    label: '单条链接',
    description: '粘贴一个链接',
    Icon: Link2,
    active: (pathname: string) => pathname === '/',
  },
  {
    href: '/library',
    label: '批量视频库',
    description: '收藏视频与联合问答',
    Icon: Grid3X3,
    active: (pathname: string) => pathname.startsWith('/library'),
  },
];

export default function ContentModeSwitch() {
  const pathname = usePathname() || '/';

  return (
    <nav className="content-mode-switch" aria-label="内容提取方式">
      {MODES.map(({ href, label, description, Icon, active }) => {
        const selected = active(pathname);
        return (
          <Link
            key={href}
            href={href}
            className={`content-mode-option ${selected ? 'is-active' : ''}`}
            aria-current={selected ? 'page' : undefined}
          >
            <span className="content-mode-icon" aria-hidden="true">
              <Icon size={16} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
