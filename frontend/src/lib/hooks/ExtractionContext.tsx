'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CardData } from '@/lib/types';
import type { ExtractionVideoPreview, ProgressEvent, ProgressEventData } from '@/lib/api';
import { extractVideoStream } from '@/lib/api';
import { useAuth } from './AuthContext';

// ---------------------------------------------------------------------------
// Pipeline step helpers (same shape as page.tsx)
// ---------------------------------------------------------------------------

export interface StepLog {
  message: string;
  status: 'active' | 'done' | 'error';
  timestamp: number;
  elapsedMs?: number;
  level?: 'info' | 'warning';
}

export interface StepState {
  key: string;
  label: string;
  message: string;
  status: 'pending' | 'active' | 'done' | 'error';
  logs: StepLog[];
}

const STEP_LABELS: Record<string, string> = {
  parse: '读取内容',
  transcribe: '提取文字',
  ai: '整理内容',
  plan: '生成计划',
  save: '保存笔记',
};

function createStep(key: string): StepState {
  return {
    key,
    label: STEP_LABELS[key] || key,
    message: '',
    status: 'pending',
    logs: [],
  };
}

function initialSteps(): StepState[] {
  return ['parse', 'transcribe', 'ai', 'save'].map(createStep);
}

const HOME_CARD_STORAGE_KEY = 'vc-home-card';

function removeStoredHomeCard(): void {
  try {
    sessionStorage.removeItem(HOME_CARD_STORAGE_KEY);
  } catch {
    // State cleanup below remains authoritative.
  }
}

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

interface ExtractionState {
  isLoading: boolean;
  error: string | null;
  cardData: CardData | null;
  previewVideo: ExtractionVideoPreview | null;
  transcript: string;
  progressSteps: StepState[];
  startExtraction: (url: string) => void;
  clearCard: () => void;
  dismissError: () => void;
}

const ExtractionContext = createContext<ExtractionState | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ExtractionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // 账号是解析状态的边界；同账号续期保持进度，退出或换号立即重建。
  return <AccountExtractionProvider key={user?.id || 'signed-out'}>{children}</AccountExtractionProvider>;
}

function AccountExtractionProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [previewVideo, setPreviewVideo] = useState<ExtractionVideoPreview | null>(null);
  const [transcript, setTranscript] = useState('');
  const [progressSteps, setProgressSteps] = useState<StepState[]>(initialSteps());

  // Ref so the SSE stream runs in the background even if the consumer unmounts.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // 旧版缓存没有账号归属且已无读取方，不再将私人原文写入该缓存。
    removeStoredHomeCard();
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      removeStoredHomeCard();
    };
  }, []);

  const startExtraction = useCallback(async (url: string) => {
    // Cancel any in-flight extraction.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrent = () => abortRef.current === controller && !controller.signal.aborted;

    setIsLoading(true);
    setError(null);
    setCardData(null);
    setPreviewVideo(null);
    setTranscript('');
    setProgressSteps(initialSteps());

    const steps = [...initialSteps()];

    const getProgressData = (event: ProgressEvent): ProgressEventData => {
      if (event.data && typeof event.data === 'object' && event.step !== 'done') {
        return event.data as ProgressEventData;
      }
      return {};
    };

    const upsertStep = (key: string): number => {
      const existingIndex = steps.findIndex((s) => s.key === key);
      if (existingIndex !== -1) return existingIndex;

      const newStep = createStep(key);
      if (key === 'plan') {
        const saveIndex = steps.findIndex((s) => s.key === 'save');
        const insertIndex = saveIndex === -1 ? steps.length : saveIndex;
        steps.splice(insertIndex, 0, newStep);
        return insertIndex;
      }

      steps.push(newStep);
      return steps.length - 1;
    };

    const updateStep = (event: ProgressEvent) => {
      const key = event.step;
      if (key === 'done' || key === 'error') return;

      const idx = upsertStep(key);
      const data = getProgressData(event);
      const nextLogs = [
        ...steps[idx].logs,
        {
          message: event.message,
          status: event.status,
          timestamp: Date.now(),
          elapsedMs: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined,
          level: data.level,
        },
      ].slice(-30);

      steps[idx] = {
        ...steps[idx],
        message: event.message,
        status: event.status,
        logs: nextLogs,
      };

      // Mark all prior pending steps as done.
      for (let i = 0; i < idx; i++) {
        if (steps[i].status === 'pending') {
          steps[i] = {
            ...steps[i],
            status: 'done',
            message: steps[i].message || '完成',
          };
        }
      }

      setProgressSteps([...steps]);
    };

    try {
      const result = await extractVideoStream(
        url,
        (event: ProgressEvent) => {
          // Check if aborted.
          if (!isCurrent()) return;

          if (event.step === 'error') {
            setError(event.message);
            // 保留本次已读取的资料与文稿，转写失败时仍可下载原视频。
            // Simulate error step locally just for display.
            const idx = upsertStep('error');
            steps[idx] = { ...steps[idx], status: 'error', message: event.message };
            setProgressSteps([...steps]);
            setIsLoading(false);
            return;
          }

          if (event.step !== 'done' && event.data && typeof event.data === 'object') {
            const progressData = event.data as ProgressEventData;
            if (progressData.video) setPreviewVideo(progressData.video);
            if (typeof progressData.transcript === 'string') setTranscript(progressData.transcript);
          }

          if (event.step === 'done' && event.data) {
            const finalData = event.data as import('@/lib/types').CardData;
            // Force mark save step as done.
            const saveIdx = upsertStep('save');
            steps[saveIdx] = { ...steps[saveIdx], status: 'done', message: '保存成功' };
            setProgressSteps([...steps]);

            setCardData(finalData);
            setIsLoading(false);
            return;
          }

          // Update the step that sent the event.
          updateStep(event);
        },
        controller.signal
      );

      if (!result.success && isCurrent()) {
        setError(result.error || '提取失败');
        setIsLoading(false);
      }
    } catch (e: unknown) {
      if (isCurrent()) {
        setError(e instanceof Error ? e.message : '网络错误');
        setIsLoading(false);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, []);

  const clearCard = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsLoading(false);
    setCardData(null);
    setPreviewVideo(null);
    setTranscript('');
    setError(null);
    setProgressSteps(initialSteps());
    removeStoredHomeCard();
  }, []);

  const dismissError = useCallback(() => setError(null), []);
  const contextValue = useMemo<ExtractionState>(() => ({
    isLoading,
    error,
    cardData,
    previewVideo,
    transcript,
    progressSteps,
    startExtraction,
    clearCard,
    dismissError,
  }), [
    cardData,
    clearCard,
    dismissError,
    error,
    isLoading,
    progressSteps,
    previewVideo,
    startExtraction,
    transcript,
  ]);

  return (
    <ExtractionContext.Provider value={contextValue}>
      {children}
    </ExtractionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useExtraction(): ExtractionState {
  const ctx = useContext(ExtractionContext);
  if (!ctx) throw new Error('useExtraction must be used within ExtractionProvider');
  return ctx;
}
