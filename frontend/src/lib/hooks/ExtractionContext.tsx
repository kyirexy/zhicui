'use client';

import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import type { CardData } from '@/lib/types';
import type { ProgressEvent } from '@/lib/api';
import { extractVideoStream } from '@/lib/api';

// ---------------------------------------------------------------------------
// Pipeline step helpers (same shape as page.tsx)
// ---------------------------------------------------------------------------

export interface StepState {
  key: string;
  label: string;
  message: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

function initialSteps(): StepState[] {
  return [
    { key: 'parse',      label: '解析视频',   message: '', status: 'pending' },
    { key: 'transcribe', label: '提取文案',   message: '', status: 'pending' },
    { key: 'ai',         label: 'AI 榨汁',   message: '', status: 'pending' },
    { key: 'save',       label: '保存笔记',   message: '', status: 'pending' },
  ];
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
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cardData, setCardData] = useState<CardData | null>(null);
  const [progressSteps, setProgressSteps] = useState<StepState[]>(initialSteps());

  // Ref so the SSE stream runs in the background even if the consumer unmounts.
  const abortRef = useRef<AbortController | null>(null);

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

    const updateStep = (key: string, message: string, status: StepState['status']) => {
      const idx = steps.findIndex((s) => s.key === key);
      if (idx !== -1) {
        steps[idx] = { ...steps[idx], message, status };
        // Mark all prior steps as done.
        for (let i = 0; i < idx; i++) {
          if (steps[i].status === 'pending') steps[i] = { ...steps[i], status: 'done', message: steps[i].message || '完成' };
        }
        setProgressSteps([...steps]);
      }
    };

    try {
      const result = await extractVideoStream(url, (event: ProgressEvent) => {
        // Check if aborted.
        if (controller.signal.aborted) return;

        if (event.step === 'error') {
          setError(event.message);
          updateStep(event.step, event.message, 'error');
          setIsLoading(false);
          return;
        }

        if (event.step === 'done' && event.data) {
          updateStep('save', '保存成功', 'done');
          setCardData(event.data);
          sessionStorage.setItem('vc-home-card', JSON.stringify(event.data));
          setIsLoading(false);
          return;
        }

        // Update the step that sent the event.
        updateStep(event.step, event.message, event.status);
        // If the event has a nested step (e.g. "ai" status=done), mark it.
        if (event.status === 'done') {
          updateStep(event.step, event.message, 'done');
        }
        if (event.status === 'active') {
          updateStep(event.step, event.message, 'active');
        }
      });

      if (!result.success && !controller.signal.aborted) {
        // If 401, save the URL so the user can resume after login
        if (result.error === '请先登录') {
          setPendingUrl(url);
        }
        setError(result.error || '提取失败');
        setIsLoading(false);
      }
    } catch (e: unknown) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : '网络错误');
        setIsLoading(false);
      }
    }
  }, []);

  const clearCard = useCallback(() => {
    abortRef.current?.abort();
    setCardData(null);
    setError(null);
    setProgressSteps(initialSteps());
    sessionStorage.removeItem('vc-home-card');
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return (
    <ExtractionContext.Provider value={{ isLoading, error, cardData, progressSteps, startExtraction, clearCard, dismissError }}>
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
