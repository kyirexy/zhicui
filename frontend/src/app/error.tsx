'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { reportBoundaryError } from '@/components/ClientErrorReporter';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportBoundaryError(error, 'route-error-boundary');
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] items-center justify-center bg-background p-4 sm:p-6">
      <section
        className="w-full max-w-lg rounded-2xl border border-card-border bg-card-background p-6 text-center shadow-sm sm:p-8"
        aria-labelledby="route-error-title"
      >
        <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-red-500/10 text-red-600">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6" />
            <path d="M12 17h.01" />
          </svg>
        </div>
        <p className="text-sm font-medium text-foreground-muted">知萃</p>
        <h1
          id="route-error-title"
          className="mt-2 text-balance text-xl font-semibold text-foreground"
        >
          这个页面暂时没有加载成功
        </h1>
        <p className="mt-3 text-pretty text-sm leading-6 text-foreground-muted">
          你的资料不会因此丢失。可以先重新尝试；如果仍然失败，请刷新页面或重新登录。
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={reset}
            className="min-h-11 rounded-xl bg-foreground px-5 py-2.5 text-sm font-medium text-background"
          >
            重新尝试
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="min-h-11 rounded-xl border border-card-border px-5 py-2.5 text-sm font-medium text-foreground"
          >
            刷新页面
          </button>
        </div>

        <nav
          className="mt-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm"
          aria-label="页面恢复"
        >
          <Link className="inline-flex min-h-11 items-center text-foreground-secondary hover:text-foreground" href="/">
            返回首页
          </Link>
          <Link className="inline-flex min-h-11 items-center text-foreground-secondary hover:text-foreground" href="/login">
            前往登录
          </Link>
        </nav>
      </section>
    </div>
  );
}
