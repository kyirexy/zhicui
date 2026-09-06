import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
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
  DesktopZhicuiLoginStatus,
  DesktopZhicuiSession,
  PlatformAccountStatus,
} from './contract';
import {
  DesktopAgentIntegration,
  resolveBundledCliEntry,
} from './agent-integration';
import { DesktopAgentActionBridge } from './agent-action-bridge';
import { desktopBuildIdentity } from './build-identity';
import { desktopBridgeDirectory } from './platform-runtime';
import { applyWindowTheme } from './window-theme';
import { readPackagedReleaseChannel } from './release-channel';
import { DouyinDesktopLogin } from './douyin-login';
import { DesktopMediaLibrary } from './media-library';
import { PlatformAccountConnector } from './platform-account';
import { ZhicuiWebLogin } from './zhicui-login';
import {
  assertTrustedIpcSender,
  configuredAppUrl,
  isTrustedAppUrl,
  safeExternalUrl,
  validateAwemeId,
  validateDesktopAgentIntegrationRequest,
  validateMediaSaveRequest,
  validatePlatformAccountCollectRequest,
  validatePlatformAccountRequest,
} from './security';
import {
  checkForDesktopUpdates,
  getDesktopUpdateState,
  initializeDesktopUpdater,
  installDesktopUpdate,
  scheduleDesktopUpdateChecks,
} from './updater';

const DEEP_LINK_PREFIX = 'zhicui://';
const PACKAGED_RELEASE_CHANNEL = readPackagedReleaseChannel(app.getAppPath());
const BUILD_IDENTITY = desktopBuildIdentity(
  app.isPackaged,
  PACKAGED_RELEASE_CHANNEL,
);
app.setName(BUILD_IDENTITY.displayName);
let mainWindow: BrowserWindow | null = null;
let pendingDeepLink: string | null = null;
let mediaLibrary: DesktopMediaLibrary | null = null;
let stopDesktopUpdateChecks: (() => void) | null = null;
let agentActionBridge: DesktopAgentActionBridge | null = null;
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

function emitZhicuiLoginStatus(status: DesktopZhicuiLoginStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('desktop:zhicui-login-status', status);
}

function emitZhicuiSession(session: DesktopZhicuiSession): void {
  const publish = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('desktop:zhicui-session', session);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  const binding = agentActionBridge?.bindUser(
    session.user.agent_profile_key || null,
  );
  if (!binding) {
    publish();
    return;
  }
  void binding.then(publish).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] 登录账号绑定到本机 Agent 失败：${message}`);
    publish();
  });
}

function emitPlatformAccountStatus(status: PlatformAccountStatus): void {
  agentActionBridge?.recordPlatformStatus(status);
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
const zhicuiLogin = new ZhicuiWebLogin(
  () => configuredAppUrl().origin,
  emitZhicuiLoginStatus,
  emitZhicuiSession,
);
const platformAccounts = new PlatformAccountConnector(
  () => join(app.getPath('userData'), 'platform-sessions'),
  emitPlatformAccountStatus,
);
const agentIntegration = new DesktopAgentIntegration(() => (
  resolveBundledCliEntry({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    compiledDirectory: __dirname,
  })
));

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
    title: BUILD_IDENTITY.windowTitle,
    icon: desktopIconPath(),
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'default' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? false : {
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
  if (BUILD_IDENTITY.channel === 'development') {
    window.on('page-title-updated', (event) => {
      event.preventDefault();
      window.setTitle(BUILD_IDENTITY.windowTitle);
    });
  }
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
  if (process.env.ZHICUI_DESKTOP_SMOKE === '1') {
    window.webContents.once('did-finish-load', () => {
      if (!isTrustedAppUrl(window.webContents.getURL())) return;
      window.show();
      window.focus();
      console.log('[desktop-smoke] 页面加载完成');
    });
  }
  window.on('closed', () => {
    stopDesktopUpdateChecks?.();
    stopDesktopUpdateChecks = null;
    mainWindow = null;
  });

  loadDesktopPage(window, desktopDestination(pendingDeepLink));
  pendingDeepLink = null;
  stopDesktopUpdateChecks = scheduleDesktopUpdateChecks(window);
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
      channel: BUILD_IDENTITY.channel,
      displayName: BUILD_IDENTITY.displayName,
    };
  });
  ipcMain.handle(
    'desktop:set-titlebar-theme',
    (event, theme: 'light' | 'dark'): boolean => {
      assertTrustedIpcSender(event);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || !['light', 'dark'].includes(theme)) return false;
      if (process.platform === 'darwin') nativeTheme.themeSource = theme;
      return applyWindowTheme(process.platform, owner, theme);
    },
  );
  ipcMain.handle('desktop:bind-agent-user', async (event, profileKey: string | null) => {
    assertTrustedIpcSender(event);
    if (!agentActionBridge) return false;
    const normalized = profileKey === null
      ? null
      : validatePlatformAccountRequest({ platform: 'douyin', profileKey }).profileKey;
    return agentActionBridge.bindUser(normalized);
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
  ipcMain.handle('desktop:begin-zhicui-login', (event) => {
    assertTrustedIpcSender(event);
    return zhicuiLogin.start();
  });
  ipcMain.handle('desktop:cancel-zhicui-login', (event) => {
    assertTrustedIpcSender(event);
    return zhicuiLogin.cancel();
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
  ipcMain.handle('desktop:get-agent-integration-status', (event) => {
    assertTrustedIpcSender(event);
    return agentIntegration.status();
  });
  ipcMain.handle('desktop:run-agent-integration-action', (event, request) => {
    assertTrustedIpcSender(event);
    return agentIntegration.run(
      validateDesktopAgentIntegrationRequest(request),
    );
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
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: app.getName(), submenu: [
        { role: 'about', label: '关于知萃' },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏知萃' },
        { role: 'hideOthers', label: '隐藏其他应用' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出知萃' },
      ] },
      { label: '编辑', submenu: [
        { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
      ] },
      { label: '显示', submenu: [
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ] },
      { label: '窗口', submenu: [
        { label: '显示知萃', click: () => {
          if (!mainWindow) mainWindow = createMainWindow();
          else focusMainWindow();
        } },
        { role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' },
      ] },
    ]));
  }
  mediaLibrary = new DesktopMediaLibrary(emitMediaStatus);
  protocol.handle(
    'zhicui-media',
    (request) => mediaLibrary!.handleProtocolRequest(request),
  );
  initializeDesktopUpdater(emitUpdateStatus, PACKAGED_RELEASE_CHANNEL);
  registerProtocol();
  registerIpc();
  pendingDeepLink = pendingDeepLink || findDeepLink(process.argv);
  agentActionBridge = new DesktopAgentActionBridge({
    descriptorDirectory: desktopBridgeDirectory(),
    version: app.getVersion(),
    channel: BUILD_IDENTITY.channel,
    platformAccounts,
    getMediaLibrary: () => mediaLibrary,
    getWindow: () => mainWindow,
  });
  void agentActionBridge.start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] Agent 本机桥接启动失败：${message}`);
  });
  mainWindow = createMainWindow();
});

app.on('activate', () => {
  if (!mainWindow) mainWindow = createMainWindow();
});

app.on('before-quit', () => {
  stopDesktopUpdateChecks?.();
  stopDesktopUpdateChecks = null;
  void douyinLogin.cancel();
  void zhicuiLogin.cancel();
  void agentActionBridge?.stop().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[desktop] Agent 本机桥接清理失败：${message}`);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
