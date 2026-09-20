import type { DesktopInstallerTarget, DesktopRuntimeInfo, DesktopUpdateResult } from './desktopRuntime';

export interface DesktopRelease {
  version: string;
  downloadUrl: string;
  sizeBytes: number;
  publishedAt: string;
  notes: string[];
  codeSigned: boolean;
  sha256: string;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const DESKTOP_RELEASE_REFRESH_MS = 5 * 60_000;

// 只比较有效版本；未知版本不能当成 0，防止误下旧安装包。
export function compareDesktopVersions(left: string, right: string): number | null {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) return null;
  for (let index = 1; index <= 3; index += 1) {
    if (Number(a[index]) !== Number(b[index])) return Number(a[index]) > Number(b[index]) ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const aa = a[4].split('.');
  const bb = b[4].split('.');
  for (let index = 0; index < Math.max(aa.length, bb.length); index += 1) {
    if (aa[index] === undefined) return -1;
    if (bb[index] === undefined) return 1;
    if (aa[index] === bb[index]) continue;
    const an = /^\d+$/.test(aa[index]);
    const bn = /^\d+$/.test(bb[index]);
    if (an && bn) return Number(aa[index]) > Number(bb[index]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[index] > bb[index] ? 1 : -1;
  }
  return 0;
}

export function parseDesktopRelease(value: unknown, channel: 'beta' | 'stable'): DesktopRelease | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('版本信息暂不可用');
  const data = value as Record<string, unknown>;
  if (data.schema_version !== 2 || data.platform !== 'windows' || data.channel !== channel || data.architecture !== 'x64') {
    throw new Error('版本信息暂不可用');
  }
  if (data.availability === 'unavailable') return null;
  const version = typeof data.version === 'string' ? data.version : '';
  if (!VERSION.test(version) || data.availability !== 'available' || typeof data.download_url !== 'string') throw new Error('版本信息暂不可用');
  const url = new URL(data.download_url);
  if (url.origin !== 'https://luxai.cn' || url.username || url.password || url.search || url.hash
    || url.pathname !== `/download/windows/Zhicui-Setup-${version}-x64.exe`
    || !Number.isSafeInteger(data.size_bytes) || Number(data.size_bytes) <= 0
    || typeof data.published_at !== 'string' || !Number.isFinite(Date.parse(data.published_at))
    || typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(data.sha256)
    || !Array.isArray(data.release_notes) || data.release_notes.length > 20
    || !data.release_notes.every((note) => typeof note === 'string' && note.trim().length > 0 && note.length <= 240)
    || typeof data.code_signed !== 'boolean' || (channel === 'stable' && !data.code_signed)) {
    throw new Error('版本信息暂不可用');
  }
  return { version, downloadUrl: url.href, sizeBytes: Number(data.size_bytes), publishedAt: data.published_at,
    notes: data.release_notes as string[], codeSigned: data.code_signed, sha256: data.sha256 };
}

export async function fetchDesktopRelease(runtime: DesktopRuntimeInfo): Promise<DesktopRelease | null> {
  if (runtime.platform !== 'win32' || runtime.channel === 'development') return null;
  const response = await fetch(`https://luxai.cn/download/releases/windows/${runtime.channel}.json?t=${Date.now()}`, {
    cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error('暂时无法检查更新，请稍后重试');
  return parseDesktopRelease(await response.json(), runtime.channel);
}

export type DesktopUpdateAction = 'check' | 'install' | 'download';
export interface DesktopUpdateSnapshot {
  update: DesktopUpdateResult;
  runtime: DesktopRuntimeInfo | null;
  release: DesktopRelease | null;
  busy: DesktopUpdateAction | null;
  issue: string;
  openedVersion: string | null;
}
export const INITIAL_DESKTOP_UPDATE: DesktopUpdateSnapshot = {
  update: { status: 'idle', installedVersion: '' }, runtime: null, release: null, busy: null, issue: '', openedVersion: null,
};

export function desktopUpdatePresentation(snapshot: DesktopUpdateSnapshot) {
  const { update, release, runtime, busy } = snapshot;
  const installed = runtime?.version || update.installedVersion;
  const newerRelease = release && compareDesktopVersions(release.version, installed) === 1 ? release : null;
  const newerNative = update.version && compareDesktopVersions(update.version, installed) === 1 ? update.version : null;
  const version = newerRelease && (!newerNative || compareDesktopVersions(newerRelease.version, newerNative) === 1)
    ? newerRelease.version : newerNative || newerRelease?.version || null;
  const legacyDownloaded = update.status === 'downloaded' && update.canInstall === undefined;
  const localInstaller = update.manualInstaller === true
    && ['downloading', 'downloaded', 'installing'].includes(update.status);
  const manual = Boolean(!localInstaller && (update.manualRequired || (runtime?.platform === 'win32' && newerRelease
    && (!release?.codeSigned || update.status === 'unsupported' || legacyDownloaded))));
  const progress = Number.isFinite(update.percent) ? Math.max(0, Math.min(100, Math.round(update.percent!))) : 0;
  const canInstall = update.status === 'downloaded' && update.canInstall === true && (localInstaller || !manual) && Boolean(version)
    && update.downloadedVersion === version;
  const fallback = Boolean(newerRelease && (!newerNative || (compareDesktopVersions(newerRelease.version, newerNative) ?? -1) >= 0));
  const installing = update.status === 'installing' || busy === 'install';
  const downloading = update.status === 'downloading' && !manual;
  let title = '知萃已是最新版本';
  let description = '新版本会自动检查，你可以继续使用。';
  let label = '检查更新';
  let action: DesktopUpdateAction = 'check';
  if (installing) {
    title = '正在重启知萃'; description = '更新后会重新打开，请稍等片刻。'; label = '正在重启…';
  } else if (busy === 'check' || update.status === 'checking') {
    title = '正在检查更新'; description = '稍等片刻，正在确认最新版本。'; label = '正在检查…';
  } else if (canInstall) {
    title = '更新已准备好'; description = '保存当前输入后重启，即可使用新版本。'; label = '重启并更新'; action = 'install';
  } else if (downloading) {
    title = '正在下载更新'; description = '可以继续使用，下载完成后再重启。'; label = `正在下载 ${progress}%`;
  } else if (manual && version) {
    title = '发现知萃新版本'; description = '下载完成后即可更新，账号和资料会保留。';
    label = fallback ? '下载并安装' : '重新检查'; action = fallback ? 'download' : 'check';
  } else if (update.status === 'error') {
    title = '更新暂未完成'; description = '请检查网络后重试，当前版本仍可继续使用。'; label = '重试更新';
  } else if (version) {
    title = '发现知萃新版本'; description = '更新准备好后，你可以选择方便的时候重启。'; label = '准备更新';
  } else if (update.status === 'unsupported') {
    title = '知萃版本与更新'; description = runtime?.platform === 'darwin'
      ? '请通过原安装方式更新，账号和资料会保留。' : '暂未发现可用更新，可以继续使用当前版本。';
  } else if (update.status === 'idle') {
    title = '知萃版本与更新'; description = '新版本会自动检查，你也可以随时手动检查。';
  }
  const alreadyOpened = !localInstaller && action === 'download' && snapshot.openedVersion === version;
  if (alreadyOpened) { title = '安装包已准备好'; description = '完成下载后打开安装包，即可完成更新。'; label = '已打开下载'; }
  if (busy === 'download') label = '正在确认版本…';
  return { title, description, label, action, version, progress, canInstall, manual, downloading, installing,
    fallback, alreadyOpened, attention: Boolean(version || update.status === 'error' || installing),
    disabled: Boolean(busy || installing || downloading || update.status === 'checking' || alreadyOpened || (action === 'download' && !fallback)),
  };
}

interface UpdateBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  getUpdateState(): Promise<DesktopUpdateResult>;
  checkForUpdates(): Promise<DesktopUpdateResult>;
  downloadInstaller?(target: DesktopInstallerTarget): Promise<DesktopUpdateResult>;
  installUpdate(): Promise<DesktopUpdateResult>;
  onUpdateStatus(listener: (status: DesktopUpdateResult) => void): () => void;
}

export function createDesktopUpdateController(bridge: UpdateBridge, dependencies: {
  fetchRelease: (runtime: DesktopRuntimeInfo) => Promise<DesktopRelease | null>;
  openDownload: (url: string) => void | Promise<void>;
  downloadInstaller?: (release: DesktopRelease) => Promise<DesktopUpdateResult>;
}) {
  let snapshot: DesktopUpdateSnapshot = INITIAL_DESKTOP_UPDATE;
  const listeners = new Set<() => void>();
  let revision = 0;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  let releaseRefreshTimer: number | undefined;
  let releaseFocusHandler: (() => void) | undefined;
  let manifestInFlight: Promise<void> | null = null;
  let actionInFlight: Promise<void> | null = null;
  const publish = (patch: Partial<DesktopUpdateSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const refreshRelease = (): Promise<void> => {
    if (manifestInFlight) return manifestInFlight;
    if (!snapshot.runtime) return Promise.resolve();
    manifestInFlight = dependencies.fetchRelease(snapshot.runtime).then((release) => {
      publish({ release });
    }).catch(() => {
      // 不能用旧清单或内置旧版本假装此次检查成功。
      publish({ release: null, issue: '暂时无法确认最新版本，请稍后重试。' });
    }).finally(() => { manifestInFlight = null; });
    return manifestInFlight;
  };
  const start = async () => {
    if (started) return;
    started = true;
    unsubscribe = bridge.onUpdateStatus((update) => {
      revision += 1;
      const targetChanged = update.version !== snapshot.update.version;
      publish({ update, issue: '' });
      if (targetChanged || update.manualRequired) void refreshRelease();
    });
    const initialRevision = revision;
    await Promise.allSettled([
      bridge.getUpdateState().then((update) => { if (revision === initialRevision) publish({ update }); }),
      bridge.getRuntimeInfo().then((runtime) => publish({ runtime })),
    ]);
    await refreshRelease();
    // Beta 安装包可能在当前页面打开后才发布；即使原生更新能力不可用，
    // 也要定期重新读取最高版本，避免会话一直停留在旧的 1.1.x 提示。
    if (typeof window !== 'undefined') {
      releaseFocusHandler = () => { void refreshRelease(); };
      window.addEventListener('focus', releaseFocusHandler);
      releaseRefreshTimer = window.setInterval(() => { void refreshRelease(); }, DESKTOP_RELEASE_REFRESH_MS);
    }
  };
  const run = (action: DesktopUpdateAction): Promise<void> => {
    if (actionInFlight) return actionInFlight;
    const view = desktopUpdatePresentation(snapshot);
    if (view.installing || view.downloading || snapshot.update.status === 'checking') return Promise.resolve();
    if (action === 'install' && !view.canInstall) return Promise.resolve();
    if (action === 'download' && !view.fallback) return Promise.resolve();
    publish({ busy: action, issue: '' });
    actionInFlight = (async () => {
      if (action === 'download') {
        await refreshRelease();
        const fresh = desktopUpdatePresentation(snapshot);
        if (!fresh.fallback || !snapshot.release) {
          publish({ issue: '暂时无法确认可用安装包，请重新检查更新。' }); return;
        }
        if (snapshot.openedVersion === snapshot.release.version && !dependencies.downloadInstaller) return;
        if (dependencies.downloadInstaller) {
          const update = await dependencies.downloadInstaller(snapshot.release);
          publish({ update, openedVersion: null });
        } else {
          await dependencies.openDownload(snapshot.release.downloadUrl);
          publish({ openedVersion: snapshot.release.version });
        }
        return;
      }
      const beforeRequest = revision;
      const update = action === 'install' ? await bridge.installUpdate() : await bridge.checkForUpdates();
      if (revision === beforeRequest) publish({ update });
      if (action === 'check') await refreshRelease();
    })().catch(() => {
      publish({ issue: action === 'install' ? '暂时无法重启更新，请稍后重试。' : '更新暂未完成，请检查网络后重试。' });
    }).finally(() => { actionInFlight = null; publish({ busy: null }); });
    return actionInFlight;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); void start(); return () => { listeners.delete(listener); }; },
    start, run,
    redownload: () => { if (!actionInFlight) publish({ openedVersion: null }); return run('download'); },
    dispose: () => {
      unsubscribe?.();
      if (typeof window !== 'undefined') {
        if (releaseRefreshTimer !== undefined) window.clearInterval(releaseRefreshTimer);
        if (releaseFocusHandler) window.removeEventListener('focus', releaseFocusHandler);
      }
      releaseRefreshTimer = undefined;
      releaseFocusHandler = undefined;
      listeners.clear();
    },
  };
}
