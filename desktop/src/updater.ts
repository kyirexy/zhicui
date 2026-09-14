import { app, type BrowserWindow } from 'electron';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { autoUpdater, type NsisUpdater } from 'electron-updater';
import type { DesktopUpdateResult } from './contract';
import { NativeUpdateController, type NativeUpdateCapability, type NativeUpdateInfo } from './update-policy';
import type { PackagedReleaseChannel } from './release-channel';

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

export function getDesktopUpdateState(): DesktopUpdateResult { return getController().getState(); }

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
export function installDesktopUpdate(): Promise<DesktopUpdateResult> { return getController().install(); }

const STARTUP_CHECK_DELAY_MS = 12_000;
const PERIODIC_CHECK_INTERVAL_MS = 60 * 60_000;
const FOCUS_CHECK_THROTTLE_MS = 5 * 60_000;

export function scheduleDesktopUpdateChecks(window: BrowserWindow): () => void {
  if (getDesktopUpdateState().status === 'unsupported') return () => {};
  let disposed = false;
  let lastAutomaticCheckAt = 0;
  const run = (force = false) => {
    if (disposed) return;
    const now = Date.now();
    if (!force && now - lastAutomaticCheckAt < FOCUS_CHECK_THROTTLE_MS) return;
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
