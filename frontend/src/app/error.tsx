'use client';

import { useEffect } from 'react';
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
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="glass-card p-8 max-w-md w-full text-center">
        <div className="w-12 h-12 rounded-xl bg-accent-emerald/15 flex items-center justify-center mx-auto mb-4">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent-emerald"
          >
            <path d="M12 15V3" />
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="m7 10 5 5 5-5" />
          </svg>
        </div>
        <h2 className="text-lg font-bold text-foreground mb-2">页面出了点小问题</h2>
        <p className="text-sm text-foreground-muted mb-6">刷新一下,或稍后重试</p>
        <button
          onClick={reset}
          className="btn-primary px-6 py-2.5 text-sm font-medium"
        >
          重试
        </button>
      </div>
    </div>
  );
}
