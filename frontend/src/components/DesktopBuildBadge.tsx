'use client';

import { useEffect, useState } from 'react';
import { detectDesktopRuntime, type DesktopRuntimeInfo } from '@/lib/desktopRuntime';

export default function DesktopBuildBadge() {
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);

  useEffect(() => {
    let active = true;
    void detectDesktopRuntime().then((info) => {
      if (active) setRuntime(info);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!runtime || runtime.packaged || runtime.channel !== 'development') {
    return null;
  }

  return (
    <div
      aria-label="当前为知萃开发版"
      className="pointer-events-none fixed left-1/2 top-1.5 z-[120] -translate-x-1/2 rounded-full border border-amber-400/35 bg-amber-100/95 px-3 py-1 text-[11px] font-semibold tracking-wide text-amber-900 shadow-sm backdrop-blur-sm dark:border-amber-300/25 dark:bg-amber-300/15 dark:text-amber-100"
      data-desktop-build-badge="development"
    >
      开发版 · 本地调试
    </div>
  );
}
