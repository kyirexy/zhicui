'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { notifyLibraryUpdated } from '@/lib/libraryUpdates';
import { listCreatorSyncRuns } from '@/lib/api';
import type { CreatorSyncRun } from '@/lib/types';
import { useAuth } from './AuthContext';

interface CreatorSyncContextValue {
  activeRuns: CreatorSyncRun[];
  recentRuns: CreatorSyncRun[];
  loading: boolean;
  lastUpdatedAt: number;
  refreshActive: () => Promise<void>;
  refreshRecent: () => Promise<CreatorSyncRun[]>;
  refreshAll: () => Promise<void>;
  trackRun: (run: CreatorSyncRun) => void;
}

const CreatorSyncContext = createContext<CreatorSyncContextValue | null>(null);

export function CreatorSyncProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [activeRuns, setActiveRuns] = useState<CreatorSyncRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<CreatorSyncRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  const trackedRef = useRef<CreatorSyncRun[]>([]);
  const initializedRef = useRef(false);
  const currentUserIdRef = useRef(user?.id);
  currentUserIdRef.current = user?.id;
  const activeRequestRef = useRef(0);
  const recentRequestRef = useRef(0);

  useEffect(() => {
    trackedRef.current = activeRuns;
  }, [activeRuns]);

  const refreshRecent = useCallback(async () => {
    if (!user) return [];
    const requestId = ++recentRequestRef.current;
    const response = await listCreatorSyncRuns('recent');
    if (requestId !== recentRequestRef.current || user.id !== currentUserIdRef.current) return [];
    const next = response.data?.items || [];
    if (response.success) {
      setRecentRuns(next);
      setLastUpdatedAt(Date.now());
    }
    return next;
  }, [user?.id]);

  const refreshActive = useCallback(async () => {
    if (!user) return;
    const initial = !initializedRef.current;
    if (initial) setLoading(true);
    const requestId = ++activeRequestRef.current;
    const response = await listCreatorSyncRuns('active');
    if (requestId !== activeRequestRef.current || user.id !== currentUserIdRef.current) return;
    if (response.success && response.data) {
      const next = response.data.items || [];
      const nextIds = new Set(next.map((run) => run.id));
      const completedIds = trackedRef.current
        .filter((run) => !nextIds.has(run.id))
        .map((run) => run.id);
      setActiveRuns(next);
      setLastUpdatedAt(Date.now());
      if (!initial && completedIds.length) {
        const recent = await refreshRecent();
        if (requestId !== activeRequestRef.current || user.id !== currentUserIdRef.current) return;
        const completed = recent.filter((run) => completedIds.includes(run.id));
        if (completed.length) {
          for (const run of completed) {
            if (run.new_count > 0 || run.reused_count > 0) notifyLibraryUpdated(`creator-sync:${run.id}:${run.status}`);
          }
          window.dispatchEvent(new CustomEvent('vc:creator-sync-updated', {
            detail: { runs: completed },
          }));
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const latest = completed[0];
            const catalogRun = latest.operation === 'catalog_all';
            new Notification(catalogRun ? '博主作品清单已更新' : '博主文稿任务已完成', {
              body: catalogRun
                ? `已发现 ${latest.discovered_count} 条公开作品`
                : `新增 ${latest.new_count} · 已存在 ${latest.reused_count} · 失败 ${latest.failed_count}`,
              icon: '/icons/icon-192.png',
            });
          }
        }
      }
    }
    initializedRef.current = true;
    if (initial) setLoading(false);
  }, [refreshRecent, user?.id]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshActive(), refreshRecent()]);
  }, [refreshActive, refreshRecent]);

  const trackRun = useCallback((run: CreatorSyncRun) => {
    trackedRef.current = [run, ...trackedRef.current.filter((item) => item.id !== run.id)];
    setActiveRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    setLastUpdatedAt(Date.now());
    window.dispatchEvent(new Event('vc:creator-sync-run-started'));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    initializedRef.current = false;
    trackedRef.current = [];
    setActiveRuns([]);
    setRecentRuns([]);
    if (!user) return;
    void refreshActive();
    void refreshRecent();
    return () => { activeRequestRef.current += 1; recentRequestRef.current += 1; };
  }, [authLoading, refreshActive, refreshRecent, user?.id]);

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(
      () => void refreshActive(),
      activeRuns.length ? 3_000 : 30_000,
    );
    const refresh = () => void refreshActive();
    window.addEventListener('focus', refresh);
    window.addEventListener('vc:creator-sync-run-started', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('vc:creator-sync-run-started', refresh);
    };
  }, [activeRuns.length, refreshActive, user]);

  const value = useMemo(() => ({
    activeRuns,
    recentRuns,
    loading,
    lastUpdatedAt,
    refreshActive,
    refreshRecent,
    refreshAll,
    trackRun,
  }), [activeRuns, lastUpdatedAt, loading, recentRuns, refreshActive, refreshAll, refreshRecent, trackRun]);

  return <CreatorSyncContext.Provider value={value}>{children}</CreatorSyncContext.Provider>;
}

export function useCreatorSync(): CreatorSyncContextValue {
  const context = useContext(CreatorSyncContext);
  if (!context) throw new Error('useCreatorSync 必须在 CreatorSyncProvider 内使用');
  return context;
}
