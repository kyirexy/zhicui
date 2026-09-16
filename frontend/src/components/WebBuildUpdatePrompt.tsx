'use client';

import { Capacitor } from '@capacitor/core';
import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import { useWebBuildUpdate, useWebBuildUpdateDriver } from '@/lib/hooks/useWebBuildUpdate';
import { webBuildUpdatePresentation } from '@/lib/webBuildUpdateFlow';
import { supportsWebBuildRefresh } from '@/lib/webBuildPreload';
import styles from './WebBuildUpdatePrompt.module.css';

export default function WebBuildUpdatePrompt() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { resolved, isDesktop } = useDesktopApp();
  const extraction = useExtraction();
  const nativeUpdate = useDesktopUpdate();
  const update = useWebBuildUpdate();
  const [dismissed, setDismissed] = useState('');
  // 当前发行 APK 仅有打包页面；刷新该页面并不会获得服务器的新界面。
  const remotePage = typeof window !== 'undefined' && supportsWebBuildRefresh(window.location, Capacitor.isNativePlatform());
  const preview = process.env.NODE_ENV === 'development' && typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('previewWebUpdate') === '1';
  const enabled = remotePage && resolved && !authLoading && Boolean(user) && !pathname.startsWith('/login')
    && (process.env.NODE_ENV !== 'development' || preview);
  useWebBuildActivity('global-extraction', extraction.isLoading);
  // 创作者同步与视频解析是服务端持久 job：刷新页面不影响执行，前端恢复轮询即可，
  // 不能把它们当作前台任务阻塞自动更新（否则长任务期间页面永远停在旧版）。
  useWebBuildActivity('native-install', nativeUpdate.update.status === 'installing');
  useWebBuildUpdateDriver(enabled, user?.id || '');
  const view = webBuildUpdatePresentation(update);
  // 桌面端静默更新：新版页面在空闲时自动重载，不显示网页更新角标；桌面端更新入口只在侧栏（桌面包）。
  if (!enabled || isDesktop || !view.visible || dismissed === update.available?.build_id) return null;
  const dismiss = () => {
    update.pause();
    setDismissed(update.available?.build_id || '');
  };
  return (
    <aside className={styles.notice} role="status" aria-labelledby="web-build-update-title">
      <button type="button" className={styles.close} aria-label="稍后更新页面" onClick={dismiss}><X size={18} aria-hidden="true" /></button>
      <h2 id="web-build-update-title">{view.title}</h2>
      <p>{view.description}</p>
      <p className={styles.footnote}>网页版支持单链接解析；视频同步请在桌面客户端进行。</p>
      {view.preparing && update.total > 0 && <progress className={styles.progress} aria-label="新版页面资源准备进度" value={update.completed} max={update.total} />}
      <button type="button" className={styles.refresh} disabled={view.disabled}
        onClick={() => { if (update.phase === 'error') void update.retry(); else update.refresh(); }}>
        <RefreshCw size={16} aria-hidden="true" />{view.label}
      </button>
    </aside>
  );
}
