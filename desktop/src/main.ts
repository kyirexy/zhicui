import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  shell,
} from 'electron';
import type {
  DesktopLoginRequest,
  DesktopLoginStatus,
  DesktopRuntimeInfo,
  DesktopUpdateResult,
} from './contract';
import { DouyinDesktopLogin } from './douyin-login';
import {
  assertTrustedIpcSender,
  configuredAppUrl,
  isTrustedAppUrl,
  safeExternalUrl,
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

function emitLoginStatus(status: DesktopLoginStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:douyin-login-status', status);
}

function emitUpdateStatus(status: DesktopUpdateResult): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:update-status', status);
}

const douyinLogin = new DouyinDesktopLogin(emitLoginStatus);

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
    void mainWindow.loadURL(desktopDestination(deepLink));
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: '#f7faf8',
    title: '知萃',
    icon: desktopIconPath(),
    autoHideMenuBar: true,
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    mainWindow = null;
  });

  void window.loadURL(desktopDestination(pendingDeepLink));
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
