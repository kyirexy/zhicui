'use client';

import { useEffect, useState } from 'react';

export default function AndroidBanner() {
  const [isAndroid, setIsAndroid] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const ua = navigator.userAgent.toLowerCase();
    setIsAndroid(ua.includes('android'));
  }, []);

  if (!isAndroid || dismissed) return null;

  return (
    <div className="glass-card p-4 mb-4 flex items-center gap-3 animate-fade-in">
      <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-accent-brand/15 flex items-center justify-center">
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-accent-brand"
        >
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" x2="12" y1="15" y2="3" />
        </svg>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">下载 Android 版</p>
        <p className="text-xs text-foreground-muted mt-0.5">
          安装 APK，获得更好的体验
        </p>
      </div>
      <a
        href="/api/client-downloads/android"
        className="btn-primary px-4 py-2 text-sm font-medium flex-shrink-0 min-h-[44px] flex items-center"
        download
      >
        下载
      </a>
      <button
        onClick={() => setDismissed(true)}
        className="flex-shrink-0 w-11 h-11 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors text-foreground-muted hover:text-foreground"
        aria-label="关闭"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
    </div>
  );
}
