import assert from 'node:assert/strict';
import test from 'node:test';
import { compareDesktopVersions, createDesktopUpdateController, desktopUpdatePresentation, INITIAL_DESKTOP_UPDATE, parseDesktopRelease } from './desktopUpdate.ts';
import type { DesktopRuntimeInfo, DesktopUpdateResult } from './desktopRuntime';

const runtime: DesktopRuntimeInfo = { desktop: true, platform: 'win32', version: '1.1.9', packaged: true, channel: 'beta', displayName: '知萃' };
const rawRelease = {
  schema_version: 2, platform: 'windows', architecture: 'x64', channel: 'beta', availability: 'available',
  version: '1.1.10', download_url: 'https://luxai.cn/download/windows/Zhicui-Setup-1.1.10-x64.exe',
  size_bytes: 93600448, published_at: '2026-09-14T01:00:00Z', sha256: 'a'.repeat(64), code_signed: true,
  release_notes: ['同步体验更顺畅。'],
};
const release = parseDesktopRelease(rawRelease, 'beta')!;
const status = (state: DesktopUpdateResult['status'], extra = {}): DesktopUpdateResult => ({ status: state, installedVersion: runtime.version, version: release.version, ...extra });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function setup(options: { initial?: DesktopUpdateResult; getState?: () => Promise<DesktopUpdateResult>; check?: () => Promise<DesktopUpdateResult>; install?: () => Promise<DesktopUpdateResult>; fetchRelease?: () => Promise<typeof release | null> } = {}) {
  let listener: (state: DesktopUpdateResult) => void = () => {};
  let checks = 0; let installs = 0;
  const downloads: string[] = [];
  const controller = createDesktopUpdateController({
    getRuntimeInfo: async () => runtime,
    getUpdateState: options.getState || (async () => options.initial || status('current')),
    checkForUpdates: async () => { checks += 1; return options.check ? options.check() : status('current'); },
    installUpdate: async () => { installs += 1; return options.install ? options.install() : status('installing'); },
    onUpdateStatus: (accept) => { listener = accept; return () => {}; },
  }, { fetchRelease: options.fetchRelease || (async () => release), openDownload: async (url) => { downloads.push(url); } });
  return { controller, downloads, emit: (value: DesktopUpdateResult) => listener(value), counts: () => ({ checks, installs }) };
}

test('只接受同渠道且绑定版本的官网下载地址，无旧包或任意 URL 兜底', () => {
  assert.equal(parseDesktopRelease(rawRelease, 'beta')?.version, '1.1.10');
  for (const patch of [
    { channel: 'stable' }, { download_url: 'https://example.com/Zhicui-Setup-1.1.10-x64.exe' },
    { download_url: 'https://luxai.cn/download/windows/Zhicui-Setup-latest-x64.exe' },
    { download_url: 'https://luxai.cn/download/windows/Zhicui-Setup-1.1.9-x64.exe' },
    { download_url: `${rawRelease.download_url}?redirect=old` }, { sha256: '' }, { architecture: 'arm64' },
  ]) assert.throws(() => parseDesktopRelease({ ...rawRelease, ...patch }, 'beta'));
  assert.throws(() => parseDesktopRelease({ ...rawRelease, channel: 'stable', code_signed: false }, 'stable'));
  assert.equal(parseDesktopRelease({ ...rawRelease, availability: 'unavailable' }, 'beta'), null);
});

test('版本比较支持两位数、预发布，不将未知版本或已安装包判断为更新', () => {
  assert.equal(compareDesktopVersions('1.1.10', '1.1.9'), 1);
  assert.equal(compareDesktopVersions('1.1.9', '1.1.10'), -1);
  assert.equal(compareDesktopVersions('1.1.10-beta.2', '1.1.10-beta.10'), -1);
  assert.equal(compareDesktopVersions('1.1.10', '1.1.10-beta.10'), 1);
  assert.equal(compareDesktopVersions('1.1.10+hash', '1.1.10'), 0);
  assert.equal(compareDesktopVersions('unknown', '1.1.10'), null);
});

test('签名缺失与旧 bridge 的 downloaded 都不显示自动重启', () => {
  const snapshot = { ...INITIAL_DESKTOP_UPDATE, runtime, release };
  const legacy = desktopUpdatePresentation({ ...snapshot, update: status('downloaded') });
  assert.equal(legacy.canInstall, false); assert.equal(legacy.action, 'download');
  const unsigned = { ...release, codeSigned: false };
  const view = desktopUpdatePresentation({ ...snapshot, release: unsigned, update: status('downloaded', { canInstall: true, downloadedVersion: release.version }) });
  assert.equal(view.canInstall, false); assert.equal(view.action, 'download'); assert.equal(view.manual, true);
  assert.equal(desktopUpdatePresentation({ ...snapshot, update: status('unsupported', { manualRequired: true, code: 'UPDATE_SIGNATURE_REQUIRED' }) }).label, '下载并安装');
});

test('下载完成只允许安装同一新目标，旧目标不会出现重启按钮', () => {
  const snapshot = { ...INITIAL_DESKTOP_UPDATE, runtime, release };
  assert.equal(desktopUpdatePresentation({ ...snapshot, update: status('downloaded', { canInstall: true, downloadedVersion: release.version }) }).canInstall, true);
  assert.equal(desktopUpdatePresentation({ ...snapshot, update: status('downloaded', { canInstall: true, downloadedVersion: '1.1.8' }) }).canInstall, false);
  assert.equal(desktopUpdatePresentation({ ...snapshot, runtime: { ...runtime, version: release.version }, update: status('current') }).attention, false);
});

test('原生推送下载完成后，晚到的初始查询不能覆盖新状态', async () => {
  const initial = deferred<DesktopUpdateResult>();
  const fixture = setup({ getState: () => initial.promise });
  const startup = fixture.controller.start();
  fixture.emit(status('downloaded', { canInstall: true, downloadedVersion: release.version }));
  initial.resolve(status('idle')); await startup;
  assert.equal(fixture.controller.getSnapshot().update.status, 'downloaded');
});

test('多个入口同时检查只发一次 IPC，推送进度不被旧返回值覆盖', async () => {
  const check = deferred<DesktopUpdateResult>(); const fixture = setup({ check: () => check.promise });
  await fixture.controller.start();
  const first = fixture.controller.run('check'); const second = fixture.controller.run('check');
  assert.equal(first, second); assert.equal(fixture.counts().checks, 1);
  fixture.emit(status('downloading', { percent: 56 })); check.resolve(status('available')); await first;
  assert.equal(fixture.controller.getSnapshot().update.status, 'downloading');
  assert.equal(desktopUpdatePresentation(fixture.controller.getSnapshot()).progress, 56);
});

test('检查和安装异常都会释放按钮，不泄露原始错误路径', async () => {
  const fixture = setup({ check: async () => { throw new Error('C:\\private\\token HTTP 502'); }, initial: status('error') });
  await fixture.controller.start(); await fixture.controller.run('check');
  const snapshot = fixture.controller.getSnapshot();
  assert.equal(snapshot.busy, null); assert.doesNotMatch(snapshot.issue, /private|token|502/);
  assert.equal(desktopUpdatePresentation(snapshot).label, '重试更新');
});

test('下载中点击不重复检查或安装，进度异常也不溢出', async () => {
  const fixture = setup({ initial: status('downloading', { percent: Infinity }) });
  await fixture.controller.start(); await fixture.controller.run('check'); await fixture.controller.run('install');
  assert.deepEqual(fixture.counts(), { checks: 0, installs: 0 });
  assert.equal(desktopUpdatePresentation(fixture.controller.getSnapshot()).progress, 0);
  fixture.emit(status('downloading', { percent: 120 }));
  assert.equal(desktopUpdatePresentation(fixture.controller.getSnapshot()).progress, 100);
});

test('重启操作全局去重，原生安装不支持时及时退出重启状态', async () => {
  const install = deferred<DesktopUpdateResult>();
  const fixture = setup({ initial: status('downloaded', { canInstall: true, downloadedVersion: release.version }), install: () => install.promise });
  await fixture.controller.start();
  const first = fixture.controller.run('install'); const second = fixture.controller.run('install');
  assert.equal(first, second); assert.equal(fixture.counts().installs, 1);
  install.resolve(status('unsupported', { manualRequired: true, code: 'UPDATE_SIGNATURE_REQUIRED' })); await first;
  const view = desktopUpdatePresentation(fixture.controller.getSnapshot());
  assert.equal(view.installing, false); assert.equal(view.action, 'download');
});

test('备用下载重新确认新版且去重，安装包打开不等于下载完成', async () => {
  let calls = 0;
  const fixture = setup({ initial: status('unsupported', { manualRequired: true }), fetchRelease: async () => { calls += 1; return { ...release, codeSigned: false }; } });
  await fixture.controller.start(); await Promise.all([fixture.controller.run('download'), fixture.controller.run('download')]);
  assert.equal(calls, 2); assert.deepEqual(fixture.downloads, [release.downloadUrl]);
  await fixture.controller.run('download'); assert.equal(fixture.downloads.length, 1);
  const view = desktopUpdatePresentation(fixture.controller.getSnapshot());
  assert.equal(view.canInstall, false); assert.equal(view.label, '已打开下载');
  await fixture.controller.redownload(); assert.equal(fixture.downloads.length, 2);
});

test('下载前清单失效或回退到旧版本不打开链接，并保留检查重试出口', async () => {
  let calls = 0;
  const fixture = setup({ initial: status('unsupported', { manualRequired: true }), fetchRelease: async () => {
    calls += 1; if (calls > 1) throw new Error('offline'); return { ...release, codeSigned: false };
  } });
  await fixture.controller.start(); await fixture.controller.run('download');
  assert.deepEqual(fixture.downloads, []); assert.equal(fixture.controller.getSnapshot().release, null);
  const view = desktopUpdatePresentation(fixture.controller.getSnapshot());
  assert.equal(view.action, 'check'); assert.equal(view.disabled, false);
});

test('新签名包进入 installing 状态后不会再次安装', async () => {
  const fixture = setup({ initial: status('downloaded', { canInstall: true, downloadedVersion: release.version }) });
  await fixture.controller.start(); await fixture.controller.run('install'); await fixture.controller.run('install');
  assert.equal(fixture.counts().installs, 1);
  assert.equal(desktopUpdatePresentation(fixture.controller.getSnapshot()).label, '正在重启…');
});
