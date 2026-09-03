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
  channel: 'development' | 'beta' | 'stable';
  displayName: string;
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

// ---------------------------------------------------------------------------
// 知萃账号 桌面端 ↔ Web 联动登录
// ---------------------------------------------------------------------------

export type DesktopZhicuiLoginStage =
  | 'starting'
  | 'browser-open'
  | 'waiting'
  | 'success'
  | 'cancelled'
  | 'error';

export interface DesktopZhicuiLoginStatus {
  stage: DesktopZhicuiLoginStage;
  message: string;
}

export interface DesktopZhicuiUser {
  id: string;
  email: string;
  username: string | null;
  is_active: boolean;
  is_admin: boolean;
  agent_profile_key?: string;
}

export interface DesktopZhicuiSession {
  token: string;
  user: DesktopZhicuiUser;
}

export interface DesktopZhicuiLoginResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

export type PlatformAccountProvider = 'douyin' | 'bilibili' | 'xiaohongshu';
export type PlatformAccountSourceMode = 'like' | 'collect' | 'post';
export type PlatformAccountStage =
  | 'starting'
  | 'browser-open'
  | 'waiting'
  | 'collecting'
  | 'needs-action'
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

export interface PlatformAccountItem {
  videoId: string;
  sourceUrl: string;
  title: string;
  caption: string;
  authorName: string;
  coverUrl: string;
  publishedAt: string;
  durationSeconds: number;
  sourceRank: number;
  /**
   * Short-lived playback capability captured from the official page.
   * The renderer may submit it directly to one extraction job, but it must
   * never be included in the persisted public metadata snapshot.
   */
  ephemeralMediaUrl?: string;
}

export interface PlatformAccountResult {
  success: boolean;
  platform: PlatformAccountProvider;
  code?: string;
  cancelled?: boolean;
  connected?: boolean;
  error?: string;
  urls?: string[];
  items?: PlatformAccountItem[];
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

export type DesktopAgentClient = 'codex' | 'claude';
export type DesktopAgentOperation =
  | 'setup'
  | 'doctor'
  | 'status'
  | 'update'
  | 'uninstall';

export interface DesktopAgentIntegrationRequest {
  client: DesktopAgentClient;
  operation: DesktopAgentOperation;
}

export interface DesktopAgentClientStatus {
  client: DesktopAgentClient;
  installed: boolean;
  configured: boolean;
  version?: string;
  message: string;
}

export interface DesktopAgentIntegrationOverview {
  available: boolean;
  cli_available: boolean;
  cli_version?: string;
  clients: DesktopAgentClientStatus[];
  code?: string;
  message?: string;
}

export interface DesktopAgentIntegrationResult {
  success: boolean;
  client: DesktopAgentClient;
  operation: DesktopAgentOperation;
  code: string;
  message: string;
  installed?: boolean;
  configured?: boolean;
  version?: string;
  diagnostics?: string[];
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
  bindAgentUser?(profileKey: string | null): Promise<boolean>;
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
  getAgentIntegrationStatus(): Promise<DesktopAgentIntegrationOverview>;
  runAgentIntegrationAction(
    request: DesktopAgentIntegrationRequest,
  ): Promise<DesktopAgentIntegrationResult>;
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
  beginZhicuiWebLogin(): Promise<DesktopZhicuiLoginResult>;
  cancelZhicuiWebLogin(): Promise<DesktopZhicuiLoginResult>;
  onZhicuiLoginStatus(
    listener: (status: DesktopZhicuiLoginStatus) => void,
  ): () => void;
  onZhicuiSession(
    listener: (session: DesktopZhicuiSession) => void,
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
