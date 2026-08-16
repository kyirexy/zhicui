'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useSettings } from '@/lib/hooks/SettingsContext';
import {
  configureLibraryAutoSyncSchedule,
  isLibraryAutoSyncDue,
  runLibraryAutoSync,
} from '@/lib/libraryAutoSync';

const SCHEDULE_CHECK_MS = 60_000;

export default function LibraryAutoSyncScheduler() {
  const { user, loading } = useAuth();
  const { settings } = useSettings();
  const checkingRef = useRef(false);
  const intervalMinutes = settings.libraryAutoSyncIntervalMinutes;

  const checkSchedule = useCallback(async () => {
    if (
      loading
      || !user?.id
      || intervalMinutes === 0
      || checkingRef.current
      || (typeof navigator !== 'undefined' && !navigator.onLine)
    ) return;
    if (!isLibraryAutoSyncDue(user.id, intervalMinutes)) return;
    checkingRef.current = true;
    try {
      await runLibraryAutoSync(user.id, intervalMinutes);
    } finally {
      checkingRef.current = false;
    }
  }, [intervalMinutes, loading, user?.id]);

  useEffect(() => {
    if (loading || !user?.id) return;
    configureLibraryAutoSyncSchedule(user.id, intervalMinutes);
    if (intervalMinutes === 0) return;

    void checkSchedule();
    const timer = window.setInterval(() => void checkSchedule(), SCHEDULE_CHECK_MS);
    const handleOnline = () => void checkSchedule();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void checkSchedule();
    };
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [checkSchedule, intervalMinutes, loading, user?.id]);

  return null;
}
