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
import type { ProgressEvent, ProgressEventData } from '@/lib/api';
import { extractVideoStream } from '@/lib/api';

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
  parse: '解析视频',
  transcribe: '提取文案',
  ai: 'AI 榨汁',
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

function storeHomeCard(cardData: CardData): void {
  try {
    sessionStorage.setItem(HOME_CARD_STORAGE_KEY, JSON.stringify(cardData));
  } catch {
    // Extraction results remain available in memory when storage is blocked.
  }
}

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
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [progressSteps, setProgressSteps] = useState<StepState[]>(initialSteps());

  // Ref so the SSE stream runs in the background even if the consumer unmounts.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const startExtraction = useCallback(async (url: string) => {
    // Cancel any in-flight extraction.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    setCardData(null);
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
          if (controller.signal.aborted) return;

          if (event.step === 'error') {
            setError(event.message);
            // Simulate error step locally just for display.
            const idx = upsertStep('error');
            steps[idx] = { ...steps[idx], status: 'error', message: event.message };
            setProgressSteps([...steps]);
            setIsLoading(false);
            return;
          }

          if (event.step === 'done' && event.data) {
            const finalData = event.data as import('@/lib/types').CardData;
            // Force mark save step as done.
            const saveIdx = upsertStep('save');
            steps[saveIdx] = { ...steps[saveIdx], status: 'done', message: '保存成功' };
            setProgressSteps([...steps]);

            setCardData(finalData);
            storeHomeCard(finalData);
            setIsLoading(false);
            return;
          }

          // Update the step that sent the event.
          updateStep(event);
        },
        controller.signal
      );

      if (!result.success && !controller.signal.aborted) {
        setError(result.error || '提取失败');
        setIsLoading(false);
      }
    } catch (e: unknown) {
      if (!controller.signal.aborted) {
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
    setError(null);
    setProgressSteps(initialSteps());
    removeStoredHomeCard();
  }, []);

  const dismissError = useCallback(() => setError(null), []);
  const contextValue = useMemo<ExtractionState>(() => ({
    isLoading,
    error,
    cardData,
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
    startExtraction,
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
