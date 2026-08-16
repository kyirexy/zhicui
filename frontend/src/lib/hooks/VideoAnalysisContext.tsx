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
import { listVideoAnalysisRuns } from '@/lib/api';
import type { VideoAnalysisRun, VideoAnalysisRunResult } from '@/lib/types';
import {
  isActiveVideoAnalysisStatus,
  isTerminalVideoAnalysisStatus,
  isVideoAnalysisAttentionStatus,
  runItemCount,
} from '@/lib/videoAnalysis';
import { useAuth } from './AuthContext';

interface VideoAnalysisContextValue {
  activeRuns: VideoAnalysisRun[];
  attentionRuns: VideoAnalysisRun[];
  recentRuns: VideoAnalysisRun[];
  activeItemCount: number;
  attentionItemCount: number;
  loading: boolean;
  error: string;
  refreshActive: () => Promise<void>;
  refreshRecent: () => Promise<VideoAnalysisRun[]>;
  trackRun: (value: VideoAnalysisRun | VideoAnalysisRunResult) => void;
}

const VideoAnalysisContext = createContext<VideoAnalysisContextValue | null>(null);

function unpackRun(value: VideoAnalysisRun | VideoAnalysisRunResult): VideoAnalysisRun {
  if ('run' in value) return { ...value.run, items: value.items };
  return value;
}

export function VideoAnalysisProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [activeRuns, setActiveRuns] = useState<VideoAnalysisRun[]>([]);
  const [attentionRuns, setAttentionRuns] = useState<VideoAnalysisRun[]>([]);
  const [recentRuns, setRecentRuns] = useState<VideoAnalysisRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const trackedRunsRef = useRef<VideoAnalysisRun[]>([]);
  const initializedRef = useRef(false);

  useEffect(() => {
    trackedRunsRef.current = [...activeRuns, ...attentionRuns];
  }, [activeRuns, attentionRuns]);

  const refreshRecent = useCallback(async () => {
    if (!user) return [];
    const response = await listVideoAnalysisRuns('recent', 1, 12);
    if (response.success && response.data) {
      const next = (response.data.items || []).filter(run => (
        isTerminalVideoAnalysisStatus(run.status)
      ));
      setRecentRuns(next);
      return next;
    }
    return [];
  }, [user]);

  const refreshActive = useCallback(async () => {
    if (!user) return;
    const initial = !initializedRef.current;
    if (initial) setLoading(true);
    const response = await listVideoAnalysisRuns('active', 1, 30);
    if (response.success && response.data) {
      const returnedRuns = (response.data.items || []).filter(run => run.status !== 'prepared');
      const nextRuns = returnedRuns.filter(run => isActiveVideoAnalysisStatus(run.status));
      const nextAttentionRuns = returnedRuns.filter(run => (
        isVideoAnalysisAttentionStatus(run.status)
      ));
      const nextIds = new Set(
        [...nextRuns, ...nextAttentionRuns].map(run => run.id),
      );
      const completed = trackedRunsRef.current.filter(run => !nextIds.has(run.id));
      setActiveRuns(nextRuns);
      setAttentionRuns(nextAttentionRuns);
      setError('');
      if (!initial && completed.length) {
        const recent = await refreshRecent();
        const completedIds = new Set(completed.map(run => run.id));
        const completedRuns = recent.filter(run => (
          completedIds.has(run.id)
          && (run.status === 'succeeded' || run.status === 'partial')
        ));
        if (completedRuns.length) {
          window.dispatchEvent(new CustomEvent('vc:video-analysis-updated', {
            detail: {
              runIds: completedRuns.map(run => run.id),
              noteIds: completedRuns.flatMap(run => (
                run.note_ids || run.items?.map(item => item.note_id) || []
              )),
              runs: completedRuns,
            },
          }));
        }
      }
    } else if (response.status !== 404) {
      setError(response.error || '暂时无法恢复后台解析任务');
    }
    initializedRef.current = true;
    if (initial) setLoading(false);
  }, [refreshRecent, user]);

  const trackRun = useCallback((value: VideoAnalysisRun | VideoAnalysisRunResult) => {
    const run = unpackRun(value);
    if (isVideoAnalysisAttentionStatus(run.status)) {
      trackedRunsRef.current = [
        run,
        ...trackedRunsRef.current.filter(item => item.id !== run.id),
      ];
      setActiveRuns(current => current.filter(item => item.id !== run.id));
      setAttentionRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
    } else if (isActiveVideoAnalysisStatus(run.status)) {
      trackedRunsRef.current = [
        run,
        ...trackedRunsRef.current.filter(item => item.id !== run.id),
      ];
      setAttentionRuns(current => current.filter(item => item.id !== run.id));
      setActiveRuns(current => [run, ...current.filter(item => item.id !== run.id)]);
    } else {
      return;
    }
    window.dispatchEvent(new CustomEvent('vc:video-analysis-run-started', {
      detail: { runId: run.id },
    }));
  }, []);

  useEffect(() => {
    if (authLoading) return;
    initializedRef.current = false;
    setActiveRuns([]);
    setAttentionRuns([]);
    setRecentRuns([]);
    setError('');
    if (!user) return;
    void refreshActive();
    void refreshRecent();
  }, [authLoading, refreshActive, refreshRecent, user]);

  useEffect(() => {
    if (!user) return;
    const intervalMs = activeRuns.length ? 3_000 : 30_000;
    const interval = window.setInterval(() => void refreshActive(), intervalMs);
    const onFocus = () => void refreshActive();
    const onStarted = () => window.setTimeout(() => void refreshActive(), 350);
    window.addEventListener('focus', onFocus);
    window.addEventListener('vc:video-analysis-run-started', onStarted);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('vc:video-analysis-run-started', onStarted);
    };
  }, [activeRuns.length, refreshActive, user]);

  const value = useMemo<VideoAnalysisContextValue>(() => ({
    activeRuns,
    attentionRuns,
    recentRuns,
    activeItemCount: activeRuns.reduce((total, run) => total + runItemCount(run), 0),
    attentionItemCount: attentionRuns.reduce((total, run) => total + runItemCount(run), 0),
    loading,
    error,
    refreshActive,
    refreshRecent,
    trackRun,
  }), [activeRuns, attentionRuns, error, loading, recentRuns, refreshActive, refreshRecent, trackRun]);

  return (
    <VideoAnalysisContext.Provider value={value}>
      {children}
    </VideoAnalysisContext.Provider>
  );
}

export function useVideoAnalysis(): VideoAnalysisContextValue {
  const context = useContext(VideoAnalysisContext);
  if (!context) {
    throw new Error('useVideoAnalysis 必须在 VideoAnalysisProvider 内使用');
  }
  return context;
}
