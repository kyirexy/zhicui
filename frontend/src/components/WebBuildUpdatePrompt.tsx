'use client';

import { RefreshCw, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { usePathname } from 'next/navigation';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  currentWebBuild,
  fetchLatestWebBuild,
  isDifferentWebBuild,
  type WebBuildManifest,
} from '@/lib/webBuildUpdate';

const STARTUP_DELAY_MS = 12_000;
const CHECK_INTERVAL_MS = 30 * 60_000;
const FOCUS_THROTTLE_MS = 60_000;
const DISMISSED_BUILD_KEY = 'zhicui_web_build_dismissed';

export default function WebBuildUpdatePrompt() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { isDesktop, resolved } = useDesktopApp();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastCheckAtRef = useRef(0);
  const [available, setAvailable] = useState<WebBuildManifest | null>(null);

  useEffect(() => {
    if (
      process.env.NODE_ENV === 'development'
      || !resolved
      || !isDesktop
      || authLoading
      || !user
      || pathname.startsWith('/login')
    ) {
      return undefined;
    }

    const controller = new AbortController();
    let disposed = false;
    const check = (force = false) => {
      if (disposed || inFlightRef.current) return inFlightRef.current;
      const now = Date.now();
      if (!force && now - lastCheckAtRef.current < FOCUS_THROTTLE_MS) {
        return null;
      }
      lastCheckAtRef.current = now;
      const operation = fetchLatestWebBuild(controller.signal)
        .then((latest) => {
          if (disposed || !isDifferentWebBuild(currentWebBuild(), latest)) return;
          if (sessionStorage.getItem(DISMISSED_BUILD_KEY) === latest.build_id) return;
          setAvailable(latest);
        })
        .catch(() => {
          // Version discovery is advisory. The current workspace remains usable.
        })
        .finally(() => {
          if (inFlightRef.current === operation) inFlightRef.current = null;
        });
      inFlightRef.current = operation;
      return operation;
    };

    const startupId = window.setTimeout(() => void check(true), STARTUP_DELAY_MS);
    const intervalId = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    const handleFocus = () => void check();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      disposed = true;
      controller.abort();
      window.clearTimeout(startupId);
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
      inFlightRef.current = null;
    };
  }, [authLoading, isDesktop, pathname, resolved, user]);

  useEffect(() => {
    if (available && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [available]);

  const dismiss = () => {
    if (available) sessionStorage.setItem(DISMISSED_BUILD_KEY, available.build_id);
    dialogRef.current?.close();
    setAvailable(null);
  };

  const refresh = () => {
    dialogRef.current?.close();
    window.location.reload();
  };

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) dismiss();
  };

  return (
    <dialog
      ref={dialogRef}
      className="app-update-dialog"
      aria-labelledby="web-build-update-title"
      aria-describedby="web-build-update-description"
      onClick={handleBackdrop}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      {available && (
        <div className="app-update-card">
          <header className="app-update-header">
            <div className="app-update-icon" aria-hidden="true">
              <Sparkles size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="app-update-eyebrow">网页功能已更新</p>
              <h2 id="web-build-update-title" className="text-balance">
                刷新即可使用最新版知萃
              </h2>
            </div>
            <button type="button" className="app-update-close" aria-label="稍后刷新" onClick={dismiss}>
              <X size={19} aria-hidden="true" />
            </button>
          </header>
          <p id="web-build-update-description" className="app-update-description text-pretty">
            当前输入和生成任务不会被自动打断。请在方便时刷新，桌面程序无需重新安装。
          </p>
          <footer className="app-update-actions">
            <button type="button" className="app-update-later" onClick={dismiss}>稍后</button>
            <button type="button" className="app-update-primary" onClick={refresh}>
              <RefreshCw size={18} aria-hidden="true" />
              刷新到最新版
            </button>
          </footer>
        </div>
      )}
    </dialog>
  );
}
