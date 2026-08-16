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
import { listCreatorSyncRuns } from '@/lib/api';
import type { CreatorSyncRun } from '@/lib/types';
import { useAuth } from './AuthContext';

interface CreatorSyncContextValue {
  activeRuns: CreatorSyncRun[];
  recentRuns: CreatorSyncRun[];
  loading: boolean;
  refreshActive: () => Promise<void>;
  refreshRecent: () => Promise<CreatorSyncRun[]>;
  trackRun: (run: CreatorSyncRun) => void;
}

const CreatorSyncContext = createContext<CreatorSyncContextValue | null>(null);

export function CreatorSyncProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [activeRuns, setActiveRuns] = useState<CreatorSyncRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<CreatorSyncRun[]>([]);
  const [loading, setLoading] = useState(false);
  const trackedRef = useRef<CreatorSyncRun[]>([]);
  const initializedRef = useRef(false);

  useEffect(() => {
    trackedRef.current = activeRuns;
  }, [activeRuns]);

  const refreshRecent = useCallback(async () => {
    if (!user) return [];
    const response = await listCreatorSyncRuns('recent');
    const next = response.data?.items || [];
    if (response.success) setRecentRuns(next);
    return next;
  }, [user]);

  const refreshActive = useCallback(async () => {
    if (!user) return;
    const initial = !initializedRef.current;
    if (initial) setLoading(true);
    const response = await listCreatorSyncRuns('active');
    if (response.success && response.data) {
      const next = response.data.items || [];
      const nextIds = new Set(next.map((run) => run.id));
      const completedIds = trackedRef.current
        .filter((run) => !nextIds.has(run.id))
        .map((run) => run.id);
      setActiveRuns(next);
      if (!initial && completedIds.length) {
        const recent = await refreshRecent();
        const completed = recent.filter((run) => completedIds.includes(run.id));
        if (completed.length) {
          window.dispatchEvent(new CustomEvent('vc:creator-sync-updated', {
            detail: { runs: completed },
          }));
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const latest = completed[0];
            new Notification('博主同步已完成', {
              body: `新增 ${latest.new_count} · 已存在 ${latest.reused_count} · 失败 ${latest.failed_count}`,
              icon: '/icons/icon-192.png',
            });
          }
        }
      }
    }
    initializedRef.current = true;
    if (initial) setLoading(false);
  }, [refreshRecent, user]);

  const trackRun = useCallback((run: CreatorSyncRun) => {
    trackedRef.current = [run, ...trackedRef.current.filter((item) => item.id !== run.id)];
    setActiveRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
    window.dispatchEvent(new Event('vc:creator-sync-run-started'));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    initializedRef.current = false;
    setActiveRuns([]);
    setRecentRuns([]);
    if (!user) return;
    void refreshActive();
    void refreshRecent();
  }, [authLoading, refreshActive, refreshRecent, user]);

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
    refreshActive,
    refreshRecent,
    trackRun,
  }), [activeRuns, loading, recentRuns, refreshActive, refreshRecent, trackRun]);

  return <CreatorSyncContext.Provider value={value}>{children}</CreatorSyncContext.Provider>;
}

export function useCreatorSync(): CreatorSyncContextValue {
  const context = useContext(CreatorSyncContext);
  if (!context) throw new Error('useCreatorSync 必须在 CreatorSyncProvider 内使用');
  return context;
}
