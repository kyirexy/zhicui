'use client';

import { Capacitor } from '@capacitor/core';
import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { useCreatorSync } from '@/lib/hooks/CreatorSyncContext';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import { useWebBuildUpdate, useWebBuildUpdateDriver } from '@/lib/hooks/useWebBuildUpdate';
import { webBuildUpdatePresentation } from '@/lib/webBuildUpdateFlow';
import { supportsWebBuildRefresh } from '@/lib/webBuildPreload';
import styles from './WebBuildUpdatePrompt.module.css';

export default function WebBuildUpdatePrompt() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { resolved } = useDesktopApp();
  const extraction = useExtraction();
  const creatorSync = useCreatorSync();
  const analysis = useVideoAnalysis();
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
  useWebBuildActivity('global-creator-sync', creatorSync.activeRuns.length > 0 || creatorSync.loading);
  useWebBuildActivity('global-video-analysis', analysis.activeRuns.length > 0 || analysis.loading);
  useWebBuildActivity('native-install', nativeUpdate.update.status === 'installing');
  useWebBuildUpdateDriver(enabled, user?.id || '');
  const view = webBuildUpdatePresentation(update);
  if (!enabled || !view.visible || dismissed === update.available?.build_id) return null;
  const dismiss = () => {
    update.pause();
    setDismissed(update.available?.build_id || '');
  };
  return (
    <aside className={styles.notice} role="status" aria-labelledby="web-build-update-title">
      <button type="button" className={styles.close} aria-label="稍后更新页面" onClick={dismiss}><X size={18} aria-hidden="true" /></button>
      <h2 id="web-build-update-title">{view.title}</h2>
      <p>{view.description}</p>
      {view.preparing && update.total > 0 && <progress className={styles.progress} aria-label="新版页面资源准备进度" value={update.completed} max={update.total} />}
      <button type="button" className={styles.refresh} disabled={view.disabled}
        onClick={() => { if (update.phase === 'error') void update.retry(); else update.refresh(); }}>
        <RefreshCw size={16} aria-hidden="true" />{view.label}
      </button>
    </aside>
  );
}
