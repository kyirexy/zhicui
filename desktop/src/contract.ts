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

export type PlatformAccountProvider = 'bilibili' | 'xiaohongshu';
export type PlatformAccountSourceMode = 'like' | 'collect';
export type PlatformAccountStage =
  | 'starting'
  | 'browser-open'
  | 'waiting'
  | 'collecting'
  | 'success'
  | 'cancelled'
  | 'disconnected'
  | 'error';

export interface PlatformAccountRequest {
  platform: PlatformAccountProvider;
  profileKey: string;
}

export interface PlatformAccountCollectRequest extends PlatformAccountRequest {
  mode: PlatformAccountSourceMode;
  limit: number;
}

export interface PlatformAccountStatus {
  platform: PlatformAccountProvider;
  stage: PlatformAccountStage;
  message: string;
  browser?: 'chrome' | 'msedge';
}

export interface PlatformAccountResult {
  success: boolean;
  platform: PlatformAccountProvider;
  cancelled?: boolean;
  connected?: boolean;
  error?: string;
  urls?: string[];
  count?: number;
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

export interface DesktopMediaSettings {
  autoSaveOnPlay: boolean;
  directory: string;
  defaultDirectory: string;
}

export type DesktopMediaAssetStatus =
  | 'remote'
  | 'downloading'
  | 'cached'
  | 'error';

export interface DesktopMediaAsset {
  awemeId: string;
  status: DesktopMediaAssetStatus;
  videoUrl?: string;
  coverUrl?: string;
  fileName?: string;
  directory?: string;
  sizeBytes?: number;
  receivedBytes?: number;
  totalBytes?: number;
  percent?: number;
  savedAt?: string;
  error?: string;
}

export interface DesktopMediaSaveRequest {
  awemeId: string;
  title: string;
  mediaUrl: string;
  coverUrl?: string;
}

export interface DesktopMediaDownloadResult {
  canceled: boolean;
  asset?: DesktopMediaAsset;
  directory?: string;
}

export interface ZhicuiDesktopBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  setTitlebarTheme?(theme: 'light' | 'dark'): Promise<boolean>;
  loginDouyin(request: DesktopLoginRequest): Promise<DesktopLoginResult>;
  cancelDouyinLogin(): Promise<DesktopLoginResult>;
  loginPlatformAccount(request: PlatformAccountRequest): Promise<PlatformAccountResult>;
  collectPlatformAccount(request: PlatformAccountCollectRequest): Promise<PlatformAccountResult>;
  cancelPlatformAccountAction(): Promise<PlatformAccountResult>;
  disconnectPlatformAccount(request: PlatformAccountRequest): Promise<PlatformAccountResult>;
  getUpdateState(): Promise<DesktopUpdateResult>;
  checkForUpdates(): Promise<DesktopUpdateResult>;
  installUpdate(): Promise<DesktopUpdateResult>;
  getMediaSettings(): Promise<DesktopMediaSettings>;
  setMediaAutoSave(enabled: boolean): Promise<DesktopMediaSettings>;
  chooseMediaDirectory(): Promise<DesktopMediaSettings>;
  openMediaDirectory(): Promise<boolean>;
  getMediaAsset(awemeId: string): Promise<DesktopMediaAsset>;
  saveMedia(request: DesktopMediaSaveRequest): Promise<DesktopMediaAsset>;
  downloadMedia(request: DesktopMediaSaveRequest): Promise<DesktopMediaDownloadResult>;
  removeMedia(awemeId: string): Promise<DesktopMediaAsset>;
  revealMedia(awemeId: string): Promise<boolean>;
  onDouyinLoginStatus(
    listener: (status: DesktopLoginStatus) => void,
  ): () => void;
  onPlatformAccountStatus(
    listener: (status: PlatformAccountStatus) => void,
  ): () => void;
  onUpdateStatus(
    listener: (status: DesktopUpdateResult) => void,
  ): () => void;
  onMediaStatus(
    listener: (status: DesktopMediaAsset) => void,
  ): () => void;
}
