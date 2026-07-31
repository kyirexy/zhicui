import { app } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { DesktopUpdateResult } from './contract';

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

type UpdatePublisher = (state: DesktopUpdateResult) => void;

let publishUpdate: UpdatePublisher = () => {};
let updaterReady = false;
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

export function initializeDesktopUpdater(publisher: UpdatePublisher): void {
  publishUpdate = publisher;
  if (updaterReady) return;
  updaterReady = true;

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
  if (!app.isPackaged) return getDesktopUpdateState();
  if (
    updateState.status === 'downloading'
    || updateState.status === 'downloaded'
  ) {
    return updateState;
  }
  try {
    setUpdateState({ status: 'checking' });
    await autoUpdater.checkForUpdates();
    return updateState;
  } catch (error) {
    return setUpdateState({
      status: 'error',
      error: cleanUpdateError(error),
    });
  }
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

export function scheduleDesktopUpdateCheck(): void {
  if (!app.isPackaged) return;
  setTimeout(() => {
    void checkForDesktopUpdates();
  }, 12_000);
}
