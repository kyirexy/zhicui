import { app, type BrowserWindow } from 'electron';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import * as https from 'node:https';
import { join, win32 } from 'node:path';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import type { DesktopInstallerTarget, DesktopUpdateResult } from './contract';
import { NativeUpdateController, type NativeUpdateCapability, type NativeUpdateInfo } from './update-policy';
import type { PackagedReleaseChannel } from './release-channel';
import {
  PERIODIC_CHECK_INTERVAL_MS,
  STARTUP_CHECK_DELAY_MS,
  shouldRunAutomaticUpdateCheck,
} from './update-schedule';

// 仍自动准备更新，但由控制器显式持有下载 promise；关闭应用不绕过安装前的目标校验。
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.autoRunAppAfterInstall = true;
autoUpdater.disableWebInstaller = true;

type UpdatePublisher = (state: DesktopUpdateResult) => void;
let publishUpdate: UpdatePublisher = () => {};
let controller: NativeUpdateController | null = null;
let updaterReady = false;
let publisherNames: string[] = [];
let manualInstaller: { target: DesktopInstallerTarget; path: string } | null = null;
let manualDownload: Promise<DesktopUpdateResult> | null = null;
let manualState: DesktopUpdateResult | null = null;

function publishManualState(state: DesktopUpdateResult): DesktopUpdateResult {
  manualState = state;
  publishUpdate(state);
  return state;
}

function validateManualTarget(target: DesktopInstallerTarget): DesktopInstallerTarget {
  const version = String(target?.version || '').trim();
  const downloadUrl = String(target?.downloadUrl || '').trim();
  const sizeBytes = Number(target?.sizeBytes);
  const sha256 = String(target?.sha256 || '').trim().toLowerCase();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0
    || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error('安装包清单无效');
  }
  let parsed: URL;
  try { parsed = new URL(downloadUrl); } catch { throw new Error('安装包地址无效'); }
  if (parsed.origin !== 'https://luxai.cn' || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== `/download/windows/Zhicui-Setup-${version}-x64.exe`) {
    throw new Error('安装包地址不受信任');
  }
  return { version, downloadUrl: parsed.href, sizeBytes, sha256 };
}

function manualStateFor(target: DesktopInstallerTarget, status: DesktopUpdateResult['status'], extra: Partial<DesktopUpdateResult> = {}): DesktopUpdateResult {
  return {
    status,
    installedVersion: app.getVersion(),
    version: target.version,
    manualInstaller: true,
    ...extra,
  };
}

function downloadInstallerFile(target: DesktopInstallerTarget, path: string): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(path, { flags: 'wx' });
    const hash = createHash('sha256');
    let transferred = 0;
    let startedAt = Date.now();
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      reject(error);
    };
    const request = https.get(target.downloadUrl, { headers: { 'User-Agent': 'Zhicui-Updater/1.0', Accept: 'application/octet-stream' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        fail(new Error(`安装包下载失败（HTTP ${response.statusCode || 0}）`));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        hash.update(chunk);
        const elapsed = Math.max(1, Date.now() - startedAt);
        const percent = Math.min(99, Math.floor((transferred / target.sizeBytes) * 100));
        publishManualState(manualStateFor(target, 'downloading', {
          percent,
          transferred,
          total: target.sizeBytes,
          bytesPerSecond: Math.floor((transferred * 1000) / elapsed),
        }));
        startedAt = Date.now();
      });
      response.on('error', fail);
      response.pipe(output);
    });
    request.setTimeout(30_000, () => request.destroy(new Error('安装包下载超时')));
    request.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) return;
      settled = true;
      const digest = hash.digest('hex');
      resolve({ size: transferred, sha256: digest });
    });
  });
}

export async function downloadDesktopInstaller(rawTarget: DesktopInstallerTarget): Promise<DesktopUpdateResult> {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return publishManualState({ status: 'unsupported', installedVersion: app.getVersion(), manualRequired: true, error: '当前环境不支持应用内更新' });
  }
  const target = validateManualTarget(rawTarget);
  const semver = require('semver') as { gt: (left: string, right: string) => boolean };
  if (!semver.gt(target.version, app.getVersion())) {
    return publishManualState({ status: 'current', installedVersion: app.getVersion() });
  }
  if (manualInstaller?.target.version === target.version && existsSync(manualInstaller.path)) {
    return publishManualState(manualStateFor(target, 'downloaded', { canInstall: true, downloadedVersion: target.version }));
  }
  if (manualDownload) return manualDownload;
  manualDownload = (async () => {
    const directory = join(app.getPath('temp'), 'Zhicui', 'updates');
    await mkdir(directory, { recursive: true });
    const fileName = `Zhicui-Setup-${target.version}-x64.exe`;
    const finalPath = join(directory, fileName);
    const tempPath = join(directory, `.${fileName}.${process.pid}.${randomUUID()}.part`);
    try {
      publishManualState(manualStateFor(target, 'downloading', { percent: 0, transferred: 0, total: target.sizeBytes }));
      const result = await downloadInstallerFile(target, tempPath);
      if (result.size !== target.sizeBytes) throw new Error('安装包大小校验失败');
      if (result.sha256 !== target.sha256) throw new Error('安装包校验失败');
      await rm(finalPath, { force: true });
      await rename(tempPath, finalPath);
      manualInstaller = { target, path: finalPath };
      return publishManualState(manualStateFor(target, 'downloaded', { percent: 100, transferred: result.size, total: result.size, canInstall: true, downloadedVersion: target.version }));
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      return publishManualState(manualStateFor(target, 'error', { manualRequired: true, error: error instanceof Error ? error.message : '安装包下载失败' }));
    } finally {
      manualDownload = null;
    }
  })();
  return manualDownload;
}

function updaterCapability(): NativeUpdateCapability {
  if (!app.isPackaged) return { supported: false, code: 'UPDATE_DEVELOPMENT_BUILD' };
  try {
    const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
    if (process.platform === 'darwin' && metadata.nativeUpdatesEnabled === true) return { supported: true };
    if (process.platform === 'win32' && metadata.nativeUpdatesEnabled === true) {
      // electron-updater 自己依赖 js-yaml；使用同一解析器读取包内受信配置，不读取用户网络配置。
      const yaml = require('js-yaml') as { load: (value: string) => unknown };
      const config = yaml.load(readFileSync(join(process.resourcesPath, 'app-update.yml'), 'utf8'));
      const publisher = config && typeof config === 'object' && 'publisherName' in config ? config.publisherName : undefined;
      const values = typeof publisher === 'string' ? [publisher] : Array.isArray(publisher) ? publisher : [];
      if (values.length && values.every((name) => typeof name === 'string' && name.trim().length > 0)) {
        publisherNames = values.map((name) => name.trim());
        return { supported: true };
      }
    }
  } catch { /* 配置缺失或无法确认签名能力时保留人工覆盖安装路径。 */ }
  return { supported: false, code: 'UPDATE_SIGNATURE_REQUIRED', manualRequired: true,
    error: '当前安装包暂不支持安全自动更新，请下载官方新版覆盖安装' };
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function installerPath(): string | null {
  const path = 'installerPath' in autoUpdater ? autoUpdater.installerPath : undefined;
  return typeof path === 'string' && path ? path : null;
}

async function verifyAuthenticodeStrict(path: string): Promise<void> {
  // 原校验器在旧 PowerShell/ConvertTo-Json 不可用时可能返回 null，不能把“未执行”当作通过。
  // 固定脚本、独立参数和 LiteralPath 避免路径变成命令；只输出公开签名字段。
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:ZHICUI_UPDATE_INSTALLER_PATH -ErrorAction Stop',
    '[pscustomobject]@{status=[int]$signature.Status; path=[string]$signature.Path; subject=[string]$signature.SignerCertificate.Subject; thumbprint=[string]$signature.SignerCertificate.Thumbprint} | Microsoft.PowerShell.Utility\\ConvertTo-Json -Compress',
  ].join('; ');
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  if (!win32.isAbsolute(systemRoot)) throw codedError('UPDATE_SIGNATURE_REQUIRED');
  const powershell = win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = await new Promise<string>((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      shell: false, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024, encoding: 'utf8',
      env: { ...process.env, PSModulePath: '', ZHICUI_UPDATE_INSTALLER_PATH: path },
    }, (error, stdout, stderr) => {
      if (error || stderr.trim()) reject(codedError('UPDATE_SIGNATURE_REQUIRED'));
      else resolve(stdout);
    });
  }).catch(() => { throw codedError('UPDATE_SIGNATURE_REQUIRED'); });
  let result: unknown;
  try { result = JSON.parse(output.replace(/^\uFEFF/, '').trim()); }
  catch { throw codedError('UPDATE_SIGNATURE_REQUIRED'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw codedError('UPDATE_SIGNATURE_REQUIRED');
  const data = result as Record<string, unknown>;
  if (typeof data.status !== 'number' || typeof data.path !== 'string'
    || typeof data.subject !== 'string' || typeof data.thumbprint !== 'string') throw codedError('UPDATE_SIGNATURE_REQUIRED');
  if (data.status !== 0 || !data.subject || !/^[a-f0-9]{40}$/i.test(data.thumbprint)
    || win32.resolve(data.path).toLowerCase() !== win32.resolve(path).toLowerCase()) throw codedError('ERR_UPDATER_INVALID_SIGNATURE');
  // 与默认校验器使用相同的 DN 解析器，但执行能力不足、缺字段和解析错误均严格拒绝。
  let matched = false;
  try {
    const { parseDn } = require('builder-util-runtime') as { parseDn: (value: string) => Map<string, string> };
    const subject = parseDn(data.subject);
    matched = publisherNames.some((name) => {
      const expected = parseDn(name);
      return expected.size > 0
        ? [...expected].every(([key, value]) => subject.get(key) === value)
        : subject.get('CN') === name;
    });
  } catch { throw codedError('UPDATE_SIGNATURE_REQUIRED'); }
  if (!matched) throw codedError('ERR_UPDATER_INVALID_SIGNATURE');
}

async function validateDownloadedTarget(info: NativeUpdateInfo): Promise<void> {
  if (process.platform !== 'win32') return;
  const path = installerPath();
  if (!path || !existsSync(path)) throw codedError('UPDATE_FILE_MISSING');
  const executable = info.files?.find((file) => /\.exe(?:$|[?#])/i.test(file.url));
  const expected = executable?.sha512 || info.sha512;
  if (!expected || !publisherNames.length) throw codedError('UPDATE_SIGNATURE_REQUIRED');
  const details = await stat(path);
  if (!details.isFile() || (executable?.size !== undefined && details.size !== executable.size)) throw codedError('UPDATE_TARGET_MISMATCH');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('base64') !== expected) throw codedError('UPDATE_CHECKSUM_MISMATCH');
  // 缓存命中会跳过下载阶段签名校验，因此安装前也调用原有校验器。
  const verifier = (autoUpdater as NsisUpdater).verifyUpdateCodeSignature;
  if (typeof verifier !== 'function') throw codedError('UPDATE_SIGNATURE_REQUIRED');
  let signatureError: string | null;
  try { signatureError = await verifier(publisherNames, path); }
  catch { throw codedError('UPDATE_SIGNATURE_REQUIRED'); }
  if (signatureError !== null) throw codedError('ERR_UPDATER_INVALID_SIGNATURE');
  await verifyAuthenticodeStrict(path);
}

function getController(): NativeUpdateController {
  if (controller) return controller;
  // 版本比较与 electron-updater 使用同一运行时依赖。
  const semver = require('semver') as { gt: (left: string, right: string) => boolean };
  controller = new NativeUpdateController({
    check: async () => {
      const result = await autoUpdater.checkForUpdates();
      return result ? { isUpdateAvailable: result.isUpdateAvailable, updateInfo: result.updateInfo } : null;
    },
    download: () => autoUpdater.downloadUpdate(),
    validate: validateDownloadedTarget,
    hasCachedFile: () => process.platform !== 'win32' || Boolean(installerPath() && existsSync(installerPath()!)),
    newer: (left, right) => semver.gt(left, right),
    // 用户只确认一次重启；NSIS 静默执行已下载、已核对的目标，并启动更新后的客户端。
    install: () => autoUpdater.quitAndInstall(true, true),
  }, app.getVersion(), updaterCapability(), (state) => publishUpdate(state));
  return controller;
}

export function getDesktopUpdateState(): DesktopUpdateResult { return manualState || getController().getState(); }

export function initializeDesktopUpdater(publisher: UpdatePublisher, channel: PackagedReleaseChannel): void {
  publishUpdate = publisher;
  if (updaterReady) return;
  updaterReady = true;
  autoUpdater.channel = channel;
  // channel setter 会自动打开 allowDowngrade，必须在赋渠道之后重新关闭。
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = channel === 'beta';
  autoUpdater.requestHeaders = { ...autoUpdater.requestHeaders, 'Cache-Control': 'no-cache' };
  const updates = getController();
  autoUpdater.on('download-progress', (progress) => updates.progress(progress));
  autoUpdater.on('update-downloaded', (info) => updates.downloadedEvent(info));
  autoUpdater.on('error', (error) => updates.updaterError(error));
}

export function checkForDesktopUpdates(): Promise<DesktopUpdateResult> { return getController().check(); }
export async function installDesktopUpdate(): Promise<DesktopUpdateResult> {
  if (!manualInstaller) return getController().install();
  const { target, path } = manualInstaller;
  if (!existsSync(path)) {
    manualInstaller = null;
    return publishManualState(manualStateFor(target, 'error', { manualRequired: true, canInstall: false, error: '安装包已不存在，请重新下载' }));
  }
  try {
    const child = spawn(path, [], { detached: true, windowsHide: false, stdio: 'ignore' });
    child.unref();
    const state = publishManualState(manualStateFor(target, 'installing', { canInstall: false, downloadedVersion: target.version }));
    setTimeout(() => app.quit(), 250);
    return state;
  } catch (error) {
    return publishManualState(manualStateFor(target, 'error', { manualRequired: true, canInstall: true, downloadedVersion: target.version, error: error instanceof Error ? error.message : '无法启动安装器' }));
  }
}

export function scheduleDesktopUpdateChecks(window: BrowserWindow): () => void {
  if (getDesktopUpdateState().status === 'unsupported') return () => {};
  let disposed = false;
  let lastAutomaticCheckAt = 0;
  const run = (force = false) => {
    if (disposed) return;
    const now = Date.now();
    if (!shouldRunAutomaticUpdateCheck(now, lastAutomaticCheckAt, force)) return;
    lastAutomaticCheckAt = now;
    void checkForDesktopUpdates();
  };
  const startupTimer = setTimeout(() => run(true), STARTUP_CHECK_DELAY_MS);
  const intervalTimer = setInterval(() => run(true), PERIODIC_CHECK_INTERVAL_MS);
  const handleFocus = () => run();
  window.on('focus', handleFocus);
  return () => {
    disposed = true;
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
    if (!window.isDestroyed()) window.removeListener('focus', handleFocus);
  };
}
