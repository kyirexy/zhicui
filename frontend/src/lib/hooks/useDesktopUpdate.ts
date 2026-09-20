'use client';

import { useSyncExternalStore } from 'react';
import type { ZhicuiDesktopBridge } from '@/lib/desktopRuntime';
import { createDesktopUpdateController, fetchDesktopRelease, INITIAL_DESKTOP_UPDATE, type DesktopUpdateAction } from '@/lib/desktopUpdate';

let currentBridge: ZhicuiDesktopBridge | undefined;
let controller: ReturnType<typeof createDesktopUpdateController> | null = null;

function getController() {
  const bridge = typeof window === 'undefined' ? undefined : window.zhicuiDesktop;
  if (!bridge) return null;
  if (bridge !== currentBridge) {
    controller?.dispose();
    currentBridge = bridge;
    controller = createDesktopUpdateController(bridge, {
      fetchRelease: fetchDesktopRelease,
      openDownload: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
      downloadInstaller: bridge.downloadInstaller
        ? (release) => bridge.downloadInstaller!({
            version: release.version,
            downloadUrl: release.downloadUrl,
            sizeBytes: release.sizeBytes,
            sha256: release.sha256,
          })
        : undefined,
    });
  }
  return controller;
}

const subscribe = (listener: () => void) => getController()?.subscribe(listener) || (() => {});
const getSnapshot = () => getController()?.getSnapshot() || INITIAL_DESKTOP_UPDATE;
const getServerSnapshot = () => INITIAL_DESKTOP_UPDATE;

export function useDesktopUpdate() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return {
    ...snapshot,
    run: (action: DesktopUpdateAction) => getController()?.run(action),
    redownload: () => getController()?.redownload(),
  };
}
