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
  platform: string;
  version: string;
  packaged: boolean;
}

export interface DesktopLoginRequest {
  token: string;
  callbackUrl: string;
}

export interface DesktopLoginResult {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

export interface DesktopLoginStatus {
  stage: DesktopLoginStage;
  message: string;
  browser?: 'chrome' | 'msedge';
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

declare global {
  interface Window {
    zhicuiDesktop?: ZhicuiDesktopBridge;
  }
}

const DESKTOP_RUNTIME_DETECTION_TIMEOUT_MS = 1800;

export async function detectDesktopRuntime(): Promise<DesktopRuntimeInfo | null> {
  if (typeof window === 'undefined') return null;
  const bridge = window.zhicuiDesktop;
  if (!bridge || typeof bridge.getRuntimeInfo !== 'function') return null;

  let timeoutId: number | undefined;
  try {
    const info = await Promise.race<DesktopRuntimeInfo | null>([
      bridge.getRuntimeInfo(),
      new Promise<null>((resolve) => {
        timeoutId = window.setTimeout(
          () => resolve(null),
          DESKTOP_RUNTIME_DETECTION_TIMEOUT_MS,
        );
      }),
    ]);
    return info?.desktop ? info : null;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function openInstalledDesktopApp(): void {
  if (typeof document === 'undefined') return;
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.src = 'zhicui://douyin-login';
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 1600);
}

export const DESKTOP_DOWNLOAD_URL = (
  'https://luxai.cn/download/Zhicui-Setup-1.0.3-x64.exe'
);
