'use client';

import { RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { desktopUpdatePresentation } from '@/lib/desktopUpdate';
import styles from './WebBuildUpdatePrompt.module.css';
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
  const nativeUpdate = useDesktopUpdate();
  const inFlightRef = useRef<Promise<void> | null>(null);
  const lastCheckAtRef = useRef(0);
  const [available, setAvailable] = useState<WebBuildManifest | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV === 'development'
      && new URLSearchParams(window.location.search).get('previewWebUpdate') === '1'
      && resolved && isDesktop && user) {
      setAvailable({ ...currentWebBuild(), build_id: 'development-preview-only' });
      return undefined;
    }
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

  const dismiss = () => {
    try { if (available) sessionStorage.setItem(DISMISSED_BUILD_KEY, available.build_id); } catch { /* 存储不可用也允许稍后更新。 */ }
    setAvailable(null);
  };

  const refresh = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    window.location.reload();
  };

  // 程序重启会一并载入新页面，避免两种更新同时争抢注意力。
  const nativeView = desktopUpdatePresentation(nativeUpdate);
  if (!available || !isDesktop || !user || nativeView.version || nativeView.downloading || nativeView.installing) return null;

  return (
    <aside
      className={styles.notice}
      role="status"
      aria-labelledby="web-build-update-title"
    >
      <button type="button" className={styles.close} aria-label="稍后刷新" onClick={dismiss}><X size={18} aria-hidden="true" /></button>
      <h2 id="web-build-update-title">页面有新功能</h2>
      <p>保存当前输入后刷新即可，无需下载安装。</p>
      <button type="button" className={styles.refresh} disabled={refreshing} onClick={refresh}>
        <RefreshCw size={16} aria-hidden="true" />{refreshing ? '正在刷新…' : '刷新更新'}
      </button>
    </aside>
  );
}
