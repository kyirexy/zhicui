import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { DesktopUpdateResult } from './contract';
import { nativeUpdateCheckDisposition } from './update-policy';
import type { PackagedReleaseChannel } from './release-channel';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

type UpdatePublisher = (state: DesktopUpdateResult) => void;

let publishUpdate: UpdatePublisher = () => {};
let updaterReady = false;
let updateCheckInFlight: Promise<DesktopUpdateResult> | null = null;
let updateState: DesktopUpdateResult = {
  status: 'idle',
  installedVersion: app.getVersion(),
};

function cleanUpdateError(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  return detail
    .replace(/https?:\/\/\S+/gi, '更新服务')
    .replace(/[A-Za-z]:\\[^\s]+/g, '本地路径')
    .split(/\r?\n/, 1)[0]
    .slice(0, 180) || '检查更新失败';
}

function setUpdateState(
  next: Omit<DesktopUpdateResult, 'installedVersion'>,
): DesktopUpdateResult {
  updateState = {
    installedVersion: app.getVersion(),
    ...next,
  };
  publishUpdate(updateState);
  return updateState;
}

export function getDesktopUpdateState(): DesktopUpdateResult {
  if (!app.isPackaged) {
    return {
      status: 'unsupported',
      installedVersion: app.getVersion(),
      version: app.getVersion(),
    };
  }
  return updateState;
}

export function initializeDesktopUpdater(
  publisher: UpdatePublisher,
  channel: PackagedReleaseChannel,
): void {
  publishUpdate = publisher;
  if (updaterReady) return;
  updaterReady = true;
  // electron-updater 会读取同名 `<channel>.yml`。旧 latest.yml 仅保留给历史 beta。
  autoUpdater.channel = channel;

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    setUpdateState({ status: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', (info) => {
    setUpdateState({
      status: 'current',
      version: info.version || app.getVersion(),
    });
  });
  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({
      status: 'downloading',
      version: updateState.version,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (error) => {
    setUpdateState({
      status: 'error',
      version: updateState.version,
      error: cleanUpdateError(error),
    });
  });
}

export async function checkForDesktopUpdates(): Promise<DesktopUpdateResult> {
  const disposition = nativeUpdateCheckDisposition({
    packaged: app.isPackaged,
    hasInFlightCheck: Boolean(updateCheckInFlight),
    status: updateState.status,
  });
  if (disposition === 'unsupported') return getDesktopUpdateState();
  if (disposition === 'reuse') return updateCheckInFlight!;
  if (disposition === 'hold') return updateState;
  let operation!: Promise<DesktopUpdateResult>;
  operation = (async () => {
    try {
      setUpdateState({ status: 'checking' });
      await autoUpdater.checkForUpdates();
      return updateState;
    } catch (error) {
      return setUpdateState({
        status: 'error',
        error: cleanUpdateError(error),
      });
    } finally {
      if (updateCheckInFlight === operation) updateCheckInFlight = null;
    }
  })();
  updateCheckInFlight = operation;
  return operation;
}

export function installDesktopUpdate(): DesktopUpdateResult {
  if (!app.isPackaged) return getDesktopUpdateState();
  if (updateState.status !== 'downloaded') {
    return setUpdateState({
      status: 'error',
      version: updateState.version,
      error: '新版尚未下载完成，请稍后再试',
    });
  }
  const readyState = updateState;
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return readyState;
}

const STARTUP_CHECK_DELAY_MS = 12_000;
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60_000;
const FOCUS_CHECK_THROTTLE_MS = 5 * 60_000;

export function scheduleDesktopUpdateChecks(window: BrowserWindow): () => void {
  if (!app.isPackaged) return () => {};
  let disposed = false;
  let lastAutomaticCheckAt = 0;

  const run = (force = false) => {
    if (disposed) return;
    const now = Date.now();
    if (!force && now - lastAutomaticCheckAt < FOCUS_CHECK_THROTTLE_MS) return;
    lastAutomaticCheckAt = now;
    void checkForDesktopUpdates();
  };

  const startupTimer = setTimeout(() => run(true), STARTUP_CHECK_DELAY_MS);
  const intervalTimer = setInterval(
    () => run(true),
    PERIODIC_CHECK_INTERVAL_MS,
  );
  const handleFocus = () => run();
  window.on('focus', handleFocus);

  return () => {
    disposed = true;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    if (!window.isDestroyed()) window.removeListener('focus', handleFocus);
  };
}
