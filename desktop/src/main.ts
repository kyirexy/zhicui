import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  protocol,
  shell,
} from 'electron';
import type {
  DesktopLoginRequest,
  DesktopLoginStatus,
  DesktopMediaAsset,
  DesktopRuntimeInfo,
  DesktopUpdateResult,
  PlatformAccountStatus,
} from './contract';
import { DouyinDesktopLogin } from './douyin-login';
import { DesktopMediaLibrary } from './media-library';
import { PlatformAccountConnector } from './platform-account';
import {
  assertTrustedIpcSender,
  configuredAppUrl,
  isTrustedAppUrl,
  safeExternalUrl,
  validateAwemeId,
  validateMediaSaveRequest,
  validatePlatformAccountCollectRequest,
  validatePlatformAccountRequest,
} from './security';
import {
  checkForDesktopUpdates,
  getDesktopUpdateState,
  initializeDesktopUpdater,
  installDesktopUpdate,
  scheduleDesktopUpdateCheck,
} from './updater';

const DEEP_LINK_PREFIX = 'zhicui://';
let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: string | null = null;
let mediaLibrary: DesktopMediaLibrary | null = null;
const DEVELOPMENT_LOAD_RETRY_MS = 1_000;
const DEVELOPMENT_LOAD_RETRY_LIMIT = 120;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'zhicui-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

function desktopDestination(deepLink?: string | null): string {
  const appUrl = configuredAppUrl();
  if (deepLink?.startsWith(`${DEEP_LINK_PREFIX}douyin-login`)) {
    appUrl.pathname = '/library';
    appUrl.searchParams.set('desktopLogin', '1');
  }
  return appUrl.toString();
}

function loadDesktopPage(
  window: BrowserWindow,
  destination: string,
  attempt = 0,
): void {
  void window.loadURL(destination).catch((error: unknown) => {
    if (window.isDestroyed()) return;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] 页面加载失败 (${attempt + 1})：${message}`);
    if (!process.defaultApp || attempt >= DEVELOPMENT_LOAD_RETRY_LIMIT - 1) return;
    setTimeout(() => {
      if (!window.isDestroyed()) {
        loadDesktopPage(window, destination, attempt + 1);
      }
    }, DEVELOPMENT_LOAD_RETRY_MS);
  });
}

function emitLoginStatus(status: DesktopLoginStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:douyin-login-status', status);
}

function emitPlatformAccountStatus(status: PlatformAccountStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:platform-account-status', status);
}

function emitUpdateStatus(status: DesktopUpdateResult): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:update-status', status);
}

function emitMediaStatus(status: DesktopMediaAsset): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:media-status', status);
}

const douyinLogin = new DouyinDesktopLogin(emitLoginStatus);
const platformAccounts = new PlatformAccountConnector(
  () => join(app.getPath('userData'), 'platform-sessions'),
  emitPlatformAccountStatus,
);

function desktopIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-icon.png')
    : join(__dirname, '..', '..', 'frontend', 'public', 'icons', 'icon-512.png');
}

function findDeepLink(argv: string[]): string | null {
  return argv.find((value) => value.startsWith(DEEP_LINK_PREFIX)) || null;
}

function focusMainWindow(deepLink?: string | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (deepLink) {
    loadDesktopPage(mainWindow, desktopDestination(deepLink));
  }
}

function createMainWindow(): BrowserWindow {
  const darkTitlebar = nativeTheme.shouldUseDarkColors;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: darkTitlebar ? '#111714' : '#f5f7f6',
    title: '知萃',
    icon: desktopIconPath(),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: darkTitlebar ? '#111714' : '#f5f7f6',
      symbolColor: darkTitlebar ? '#e9efeb' : '#26312b',
      height: 34,
    },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    const external = safeExternalUrl(url);
    if (external) void shell.openExternal(external);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[desktop] 渲染进程退出：${details.reason}`);
    if (!window.isDestroyed() && process.defaultApp) {
      loadDesktopPage(window, desktopDestination());
    }
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });

  loadDesktopPage(window, desktopDestination(pendingDeepLink));
  pendingDeepLink = null;
  return window;
}

function registerIpc(): void {
  ipcMain.handle('desktop:get-runtime-info', (event): DesktopRuntimeInfo => {
    assertTrustedIpcSender(event);
    return {
      desktop: true,
      platform: process.platform,
      version: app.getVersion(),
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle(
    'desktop:set-titlebar-theme',
    (event, theme: 'light' | 'dark'): boolean => {
      assertTrustedIpcSender(event);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || !['light', 'dark'].includes(theme)) return false;
      const dark = theme === 'dark';
      owner.setTitleBarOverlay({
        color: dark ? '#111714' : '#f5f7f6',
        symbolColor: dark ? '#e9efeb' : '#26312b',
        height: 34,
      });
      owner.setBackgroundColor(dark ? '#111714' : '#f5f7f6');
      return true;
    },
  );
  ipcMain.handle(
    'desktop:login-douyin',
    (event, request: DesktopLoginRequest) => {
      assertTrustedIpcSender(event);
      return douyinLogin.start(request);
    },
  );
  ipcMain.handle('desktop:cancel-douyin-login', (event) => {
    assertTrustedIpcSender(event);
    return douyinLogin.cancel();
  });
  ipcMain.handle('desktop:login-platform-account', (event, request) => {
    assertTrustedIpcSender(event);
    return platformAccounts.login(validatePlatformAccountRequest(request));
  });
  ipcMain.handle('desktop:collect-platform-account', (event, request) => {
    assertTrustedIpcSender(event);
    return platformAccounts.collect(
      validatePlatformAccountCollectRequest(request),
    );
  });
  ipcMain.handle('desktop:cancel-platform-account-action', (event) => {
    assertTrustedIpcSender(event);
    return platformAccounts.cancel();
  });
  ipcMain.handle('desktop:disconnect-platform-account', (event, request) => {
    assertTrustedIpcSender(event);
    return platformAccounts.disconnect(validatePlatformAccountRequest(request));
  });
  ipcMain.handle('desktop:check-for-updates', (event) => {
    assertTrustedIpcSender(event);
    return checkForDesktopUpdates();
  });
  ipcMain.handle('desktop:get-update-state', (event) => {
    assertTrustedIpcSender(event);
    return getDesktopUpdateState();
  });
  ipcMain.handle('desktop:install-update', (event) => {
    assertTrustedIpcSender(event);
    return installDesktopUpdate();
  });
  ipcMain.handle('desktop:get-media-settings', (event) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.getSettings();
  });
  ipcMain.handle(
    'desktop:set-media-auto-save',
    (event, enabled: boolean) => {
      assertTrustedIpcSender(event);
      if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
      return mediaLibrary.setAutoSave(enabled);
    },
  );
  ipcMain.handle('desktop:choose-media-directory', (event) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.chooseDirectory(mainWindow);
  });
  ipcMain.handle('desktop:open-media-directory', (event) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.openDirectory();
  });
  ipcMain.handle('desktop:get-media-asset', (event, awemeId: string) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.getAsset(validateAwemeId(awemeId));
  });
  ipcMain.handle('desktop:save-media', (event, request) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.save(validateMediaSaveRequest(request));
  });
  ipcMain.handle('desktop:download-media', (event, request) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.downloadToChosenDirectory(
      mainWindow,
      validateMediaSaveRequest(request),
    );
  });
  ipcMain.handle('desktop:remove-media', (event, awemeId: string) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.remove(validateAwemeId(awemeId));
  });
  ipcMain.handle('desktop:reveal-media', (event, awemeId: string) => {
    assertTrustedIpcSender(event);
    if (!mediaLibrary) throw new Error('本地媒体服务尚未就绪');
    return mediaLibrary.reveal(validateAwemeId(awemeId));
  });
}

function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('zhicui', process.execPath, [
      join(process.cwd(), process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient('zhicui');
}

app.on('second-instance', (_event, argv) => {
  focusMainWindow(findDeepLink(argv));
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (!url.startsWith(DEEP_LINK_PREFIX)) return;
  if (mainWindow) focusMainWindow(url);
  else pendingDeepLink = url;
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  mediaLibrary = new DesktopMediaLibrary(emitMediaStatus);
  protocol.handle(
    'zhicui-media',
    (request) => mediaLibrary!.handleProtocolRequest(request),
  );
  initializeDesktopUpdater(emitUpdateStatus);
  registerProtocol();
  registerIpc();
  pendingDeepLink = findDeepLink(process.argv);
  mainWindow = createMainWindow();
  scheduleDesktopUpdateCheck();
});

app.on('activate', () => {
  if (!mainWindow) mainWindow = createMainWindow();
});

app.on('before-quit', () => {
  void douyinLogin.cancel();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
