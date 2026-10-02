'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { listLibrarySyncRuns } from '@/lib/api';
import { useAuth } from './AuthContext';
import { notifyLibraryUpdated } from '@/lib/libraryUpdates';
import { emptyLibrarySyncState, watchLibrarySync, type LibrarySyncState } from '@/lib/librarySyncMonitor';
import { useWebBuildActivity } from './useWebBuildActivity';

const LibrarySyncContext = createContext<LibrarySyncState>(emptyLibrarySyncState());

export function LibrarySyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<{ userId: string; state: LibrarySyncState } | null>(null);
  const state = snapshot && snapshot.userId === user?.id ? snapshot.state : emptyLibrarySyncState();
  const active = state.runs.some((run) => run.status === 'running') || Boolean(state.capture
    && !['error', 'cancelled', 'disconnected'].includes(state.capture.stage));
  useWebBuildActivity('external-library-sync', active);
  useEffect(() => {
    setSnapshot(null);
    if (!user?.id) return;
    const userId = user.id;
    return watchLibrarySync({
      read: async (signal) => {
        const response = await listLibrarySyncRuns(20, signal);
        if (!response.success || !response.data) throw new Error('同步记录暂时不可用');
        return response.data.items;
      },
      subscribeCapture: (listener) => window.zhicuiDesktop?.onPlatformAccountStatus?.(listener) || (() => {}),
      subscribeWake: (listener) => {
        window.addEventListener('focus', listener);
        window.addEventListener('pageshow', listener);
        document.addEventListener('visibilitychange', listener);
        return () => {
          window.removeEventListener('focus', listener);
          window.removeEventListener('pageshow', listener);
          document.removeEventListener('visibilitychange', listener);
        };
      },
      visible: () => document.visibilityState !== 'hidden',
      onState: (next) => setSnapshot({ userId, state: next }),
      onSaved: () => notifyLibraryUpdated(),
    });
  }, [user?.id]);
  return <LibrarySyncContext.Provider value={state}>{children}</LibrarySyncContext.Provider>;
}

export const useLibrarySync = () => useContext(LibrarySyncContext);
