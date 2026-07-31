import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopLoginRequest,
  DesktopLoginResult,
  DesktopLoginStatus,
  DesktopRuntimeInfo,
  DesktopUpdateResult,
  ZhicuiDesktopBridge,
} from './contract';

const bridge: ZhicuiDesktopBridge = {
  getRuntimeInfo: () => (
    ipcRenderer.invoke('desktop:get-runtime-info') as Promise<DesktopRuntimeInfo>
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
  onDouyinLoginStatus: (
    listener: (status: DesktopLoginStatus) => void,
  ) => {
    const handler = (_event: Electron.IpcRendererEvent, status: DesktopLoginStatus) => {
      listener(status);
    };
    ipcRenderer.on('desktop:douyin-login-status', handler);
    return () => ipcRenderer.removeListener('desktop:douyin-login-status', handler);
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
};

contextBridge.exposeInMainWorld('zhicuiDesktop', bridge);
