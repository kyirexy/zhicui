export type DesktopLoginStage =
  | 'starting'
  | 'browser-open'
  | 'waiting'
  | 'submitting'
  | 'success'
  | 'cancelled'
  | 'error';

export interface DesktopRuntimeInfo {
  desktop: true;
  platform: NodeJS.Platform;
  version: string;
  packaged: boolean;
}

export interface DesktopLoginRequest {
  token: string;
  callbackUrl: string;
}

export interface DesktopLoginStatus {
  stage: DesktopLoginStage;
  message: string;
  browser?: 'chrome' | 'msedge';
}

export interface DesktopLoginResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface DesktopUpdateResult {
  status:
    | 'unsupported'
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'current'
    | 'error';
  installedVersion: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  error?: string;
}

export interface ZhicuiDesktopBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  loginDouyin(request: DesktopLoginRequest): Promise<DesktopLoginResult>;
  cancelDouyinLogin(): Promise<DesktopLoginResult>;
  getUpdateState(): Promise<DesktopUpdateResult>;
  checkForUpdates(): Promise<DesktopUpdateResult>;
  installUpdate(): Promise<DesktopUpdateResult>;
  onDouyinLoginStatus(
    listener: (status: DesktopLoginStatus) => void,
  ): () => void;
  onUpdateStatus(
    listener: (status: DesktopUpdateResult) => void,
  ): () => void;
}
