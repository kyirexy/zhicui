import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopLoginRequest,
  DesktopLoginResult,
  DesktopLoginStatus,
  DesktopMediaAsset,
  DesktopMediaDownloadResult,
  DesktopMediaSaveRequest,
  DesktopRuntimeInfo,
  DesktopUpdateResult,
  PlatformAccountCollectRequest,
  PlatformAccountRequest,
  PlatformAccountResult,
  PlatformAccountStatus,
  ZhicuiDesktopBridge,
} from './contract';

const bridge: ZhicuiDesktopBridge = {
  getRuntimeInfo: () => (
    ipcRenderer.invoke('desktop:get-runtime-info') as Promise<DesktopRuntimeInfo>
  ),
  setTitlebarTheme: (theme: 'light' | 'dark') => (
    ipcRenderer.invoke('desktop:set-titlebar-theme', theme) as Promise<boolean>
  ),
  loginDouyin: (request: DesktopLoginRequest) => (
    ipcRenderer.invoke(
      'desktop:login-douyin',
      request,
    ) as Promise<DesktopLoginResult>
  ),
  cancelDouyinLogin: () => (
    ipcRenderer.invoke(
      'desktop:cancel-douyin-login',
    ) as Promise<DesktopLoginResult>
  ),
  loginPlatformAccount: (request: PlatformAccountRequest) => (
    ipcRenderer.invoke(
      'desktop:login-platform-account',
      request,
    ) as Promise<PlatformAccountResult>
  ),
  collectPlatformAccount: (request: PlatformAccountCollectRequest) => (
    ipcRenderer.invoke(
      'desktop:collect-platform-account',
      request,
    ) as Promise<PlatformAccountResult>
  ),
  cancelPlatformAccountAction: () => (
    ipcRenderer.invoke(
      'desktop:cancel-platform-account-action',
    ) as Promise<PlatformAccountResult>
  ),
  disconnectPlatformAccount: (request: PlatformAccountRequest) => (
    ipcRenderer.invoke(
      'desktop:disconnect-platform-account',
      request,
    ) as Promise<PlatformAccountResult>
  ),
  getUpdateState: () => (
    ipcRenderer.invoke(
      'desktop:get-update-state',
    ) as Promise<DesktopUpdateResult>
  ),
  checkForUpdates: () => (
    ipcRenderer.invoke(
      'desktop:check-for-updates',
    ) as Promise<DesktopUpdateResult>
  ),
  installUpdate: () => (
    ipcRenderer.invoke(
      'desktop:install-update',
    ) as Promise<DesktopUpdateResult>
  ),
  getMediaSettings: () => (
    ipcRenderer.invoke('desktop:get-media-settings')
  ),
  setMediaAutoSave: (enabled: boolean) => (
    ipcRenderer.invoke('desktop:set-media-auto-save', enabled)
  ),
  chooseMediaDirectory: () => (
    ipcRenderer.invoke('desktop:choose-media-directory')
  ),
  openMediaDirectory: () => (
    ipcRenderer.invoke('desktop:open-media-directory') as Promise<boolean>
  ),
  getMediaAsset: (awemeId: string) => (
    ipcRenderer.invoke(
      'desktop:get-media-asset',
      awemeId,
    ) as Promise<DesktopMediaAsset>
  ),
  saveMedia: (request: DesktopMediaSaveRequest) => (
    ipcRenderer.invoke(
      'desktop:save-media',
      request,
    ) as Promise<DesktopMediaAsset>
  ),
  downloadMedia: (request: DesktopMediaSaveRequest) => (
    ipcRenderer.invoke(
      'desktop:download-media',
      request,
    ) as Promise<DesktopMediaDownloadResult>
  ),
  removeMedia: (awemeId: string) => (
    ipcRenderer.invoke(
      'desktop:remove-media',
      awemeId,
    ) as Promise<DesktopMediaAsset>
  ),
  revealMedia: (awemeId: string) => (
    ipcRenderer.invoke(
      'desktop:reveal-media',
      awemeId,
    ) as Promise<boolean>
  ),
  onDouyinLoginStatus: (
    listener: (status: DesktopLoginStatus) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopLoginStatus) => {
      listener(status);
    };
    ipcRenderer.on('desktop:douyin-login-status', handler);
    return () => ipcRenderer.removeListener('desktop:douyin-login-status', handler);
  },
  onPlatformAccountStatus: (
    listener: (status: PlatformAccountStatus) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: PlatformAccountStatus,
    ) => {
      listener(status);
    };
    ipcRenderer.on('desktop:platform-account-status', handler);
    return () => ipcRenderer.removeListener('desktop:platform-account-status', handler);
  },
  onUpdateStatus: (
    listener: (status: DesktopUpdateResult) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: DesktopUpdateResult,
    ) => {
      listener(status);
    };
    ipcRenderer.on('desktop:update-status', handler);
    return () => ipcRenderer.removeListener('desktop:update-status', handler);
  },
  onMediaStatus: (
    listener: (status: DesktopMediaAsset) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: DesktopMediaAsset,
    ) => {
      listener(status);
    };
    ipcRenderer.on('desktop:media-status', handler);
    return () => ipcRenderer.removeListener('desktop:media-status', handler);
  },
};

contextBridge.exposeInMainWorld('zhicuiDesktop', bridge);
