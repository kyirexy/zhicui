'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';

/** Public paths that don't require login. */
const PUBLIC = ['/', '/login', '/style'];

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (loading) return;
    if (!user && !PUBLIC.includes(pathname)) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
  }, [user, loading, pathname, router]);

  if (!PUBLIC.includes(pathname) && (loading || !user)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center" role="status" aria-live="polite">
        <p className="text-pretty text-sm text-foreground-muted">
          {loading ? '正在恢复开发会话…' : '正在前往登录页…'}
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
