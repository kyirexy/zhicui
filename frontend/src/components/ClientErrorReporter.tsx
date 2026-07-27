'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/api';

const recentFingerprints = new Map<string, number>();
const DEDUPE_WINDOW_MS = 15_000;

function runtimeEnvironment(): 'web' | 'capacitor' {
  return document.documentElement.dataset.capacitor === 'true'
    ? 'capacitor'
    : 'web';
}

function hasSession(): boolean {
  try {
    return Boolean(localStorage.getItem('zhicui_token'));
  } catch {
    return false;
  }
}

function sendClientError(
  message: string,
  stack: string,
  errorType: string,
  component = 'window',
) {
  if (!hasSession()) return;
  const fingerprint = `${errorType}:${message.slice(0, 300)}:${window.location.pathname}`;
  const now = Date.now();
  const previous = recentFingerprints.get(fingerprint) || 0;
  if (now - previous < DEDUPE_WINDOW_MS) return;
  recentFingerprints.set(fingerprint, now);
  for (const [key, timestamp] of recentFingerprints) {
    if (now - timestamp > DEDUPE_WINDOW_MS * 4) {
      recentFingerprints.delete(key);
    }
  }
  void reportClientError({
    message: message.slice(0, 4000),
    stack: stack.slice(0, 16000),
    path: window.location.pathname,
    error_type: errorType.slice(0, 128),
    environment: runtimeEnvironment(),
    component,
  });
}

export function reportBoundaryError(
  error: Error & { digest?: string },
  component: string,
) {
  if (typeof window === 'undefined') return;
  sendClientError(
    error.message || error.name || '客户端边界错误',
    error.stack || '',
    error.name || 'Error',
    component,
  );
}

export default function ClientErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      sendClientError(
        event.message || event.error?.message || '客户端运行时错误',
        event.error?.stack || '',
        event.error?.name || 'Error',
      );
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      if (reason instanceof Error) {
        sendClientError(
          reason.message || reason.name,
          reason.stack || '',
          reason.name || 'UnhandledRejection',
        );
        return;
      }
      sendClientError(
        typeof reason === 'string' ? reason : '未处理的 Promise 拒绝',
        '',
        'UnhandledRejection',
      );
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  return null;
}
