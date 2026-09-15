'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { readStoredToken } from '@/lib/authSession';
import { addHomeVideoToKnowledge, listHomeVideoPreferences, setHomeVideoHidden } from '@/lib/homeVideoActionsApi';
import { createHomeVideoActionsController, EMPTY_HOME_VIDEO_ACTIONS, homeVideoKey, type HomeVideoTarget } from '@/lib/homeVideoActions';

export function useHomeVideoActions(userId: string | undefined) {
  const userRef = useRef(userId); userRef.current = userId;
  const token = readStoredToken();
  const controller = useMemo(() => {
    return createHomeVideoActionsController({
      current: () => Boolean(userId && token && userRef.current === userId && readStoredToken() === token),
      list: (signal) => listHomeVideoPreferences(token || '', signal),
      hide: (video, hidden, signal) => setHomeVideoHidden(video, hidden, token || '', signal),
      save: (video, signal) => addHomeVideoToKnowledge(video, token || '', signal),
    });
  }, [userId, token]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => EMPTY_HOME_VIDEO_ACTIONS);
  useEffect(() => {
    controller.activate();
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  return { ...snapshot, userId,
    visible: (video: HomeVideoTarget) => snapshot.ready && !snapshot.preferences.get(homeVideoKey(video))?.hidden,
    run: controller.run, reload: controller.load, dismiss: controller.dismiss,
  };
}
export type HomeVideoActions = ReturnType<typeof useHomeVideoActions>;
