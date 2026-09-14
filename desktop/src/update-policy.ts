export type NativeUpdateCheckDisposition =
  | 'unsupported'
  | 'reuse'
  | 'hold'
  | 'check';

export function nativeUpdateCheckDisposition(options: {
  packaged: boolean;
  hasInFlightCheck: boolean;
  status: string;
}): NativeUpdateCheckDisposition {
  if (!options.packaged) return 'unsupported';
  if (options.hasInFlightCheck) return 'reuse';
  if (options.status === 'downloading' || options.status === 'installing') {
    return 'hold';
  }
  return 'check';
}

export interface NativeUpdateInfo {
  version: string;
  files?: Array<{ url: string; sha512: string; size?: number }>;
  path?: string;
  sha512?: string;
}

export interface NativeUpdaterAdapter {
  check(): Promise<{ isUpdateAvailable: boolean; updateInfo: NativeUpdateInfo } | null>;
  download(): Promise<unknown>;
  validate(info: NativeUpdateInfo): Promise<void>;
  hasCachedFile(): boolean;
  newer(left: string, right: string): boolean;
  install(): void;
}

export interface NativeUpdateCapability {
  supported: boolean;
  code?: string;
  error?: string;
  manualRequired?: boolean;
}

function sameTarget(left: NativeUpdateInfo, right: NativeUpdateInfo): boolean {
  const identity = (value: NativeUpdateInfo) => JSON.stringify([
    value.version, value.files?.map((file) => [file.url, file.sha512, file.size]), value.path, value.sha512,
  ]);
  return identity(left) === identity(right);
}

function updateFailure(error: unknown): { code: string; error: string; manualRequired?: boolean } {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['ERR_UPDATER_INVALID_SIGNATURE', 'UPDATE_SIGNATURE_REQUIRED'].includes(code)) return {
    code, error: '这个版本暂不支持安全自动安装，请下载官方安装包更新', manualRequired: true,
  };
  if (['UPDATE_TARGET_MISMATCH', 'ERR_UPDATER_CHECKSUM_MISMATCH', 'UPDATE_CHECKSUM_MISMATCH'].includes(code)) return {
    code: 'UPDATE_TARGET_MISMATCH', error: '更新文件与目标版本不一致，请重新检查更新',
  };
  if (code === 'UPDATE_FILE_MISSING') return { code, error: '已下载的更新文件不存在，请重新下载' };
  return { code: 'UPDATE_RETRY_REQUIRED', error: '更新暂未完成，请检查网络后重试' };
}

function updateError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** 一个主进程只创建一个控制器；检测、下载、安装分别去重，事件不能覆盖较新的操作。 */
export class NativeUpdateController {
  private state: DesktopUpdateResult;
  private target: NativeUpdateInfo | null = null;
  private downloaded: NativeUpdateInfo | null = null;
  private checkPromise: Promise<DesktopUpdateResult> | null = null;
  private downloadPromise: Promise<DesktopUpdateResult> | null = null;
  private installPromise: Promise<DesktopUpdateResult> | null = null;
  private downloadAttempt: { info: NativeUpdateInfo; event: NativeUpdateInfo | null } | null = null;
  private installRequested = false;

  constructor(
    private readonly adapter: NativeUpdaterAdapter,
    private readonly installedVersion: string,
    private readonly capability: NativeUpdateCapability,
    private readonly publish: (state: DesktopUpdateResult) => void,
  ) {
    this.state = { installedVersion, status: capability.supported ? 'idle' : 'unsupported', canInstall: false,
      ...(!capability.supported ? { code: capability.code, error: capability.error, manualRequired: capability.manualRequired } : {}) };
  }

  getState(): DesktopUpdateResult { return { ...this.state, canInstall: this.state.canInstall === true && this.ready() }; }

  private ready(): boolean {
    return Boolean(this.downloaded && this.target && sameTarget(this.downloaded, this.target) && this.adapter.hasCachedFile());
  }

  private set(next: Omit<DesktopUpdateResult, 'installedVersion'>): DesktopUpdateResult {
    this.state = { installedVersion: this.installedVersion, canInstall: this.ready(),
      downloadedVersion: this.downloaded?.version, ...next };
    try { this.publish(this.getState()); } catch { /* 页面关闭或刷新不影响原生更新任务。 */ }
    return this.getState();
  }

  private fail(error: unknown, allowCached = true): DesktopUpdateResult {
    const failure = updateFailure(error);
    if (failure.manualRequired || failure.code === 'UPDATE_TARGET_MISMATCH') allowCached = false;
    return this.set({ status: allowCached && this.ready() ? 'downloaded' : 'error',
      version: this.target?.version, canInstall: allowCached && this.ready(), ...failure });
  }

  check(forInstall = false): Promise<DesktopUpdateResult> {
    if (this.installPromise && !forInstall) return Promise.resolve(this.getState());
    if (!this.capability.supported || this.installRequested || this.downloadPromise) return Promise.resolve(this.getState());
    if (this.checkPromise) return this.checkPromise;
    const operation = Promise.resolve().then(async () => {
      try {
        this.set({ status: 'checking', version: this.target?.version });
        const result = await this.adapter.check();
        if (!result || !result.updateInfo?.version) throw updateError('UPDATE_CHECK_FAILED');
        const info = result.updateInfo;
        if (this.target && this.adapter.newer(this.target.version, info.version)) {
          if (this.ready()) return this.set({ status: 'downloaded', version: this.downloaded!.version });
          throw updateError('UPDATE_FEED_STALE');
        }
        if (this.target?.version === info.version && !sameTarget(this.target, info)) throw updateError('UPDATE_TARGET_MISMATCH');
        if (!result.isUpdateAvailable || !this.adapter.newer(info.version, this.installedVersion)) {
          // 陈旧的 feed 不能降级，也不能抹掉已经校验好的新版本。
          return this.ready()
            ? this.set({ status: 'downloaded', version: this.downloaded!.version })
            : this.set({ status: 'current', version: this.installedVersion, canInstall: false });
        }
        if (this.downloaded && !this.adapter.newer(info.version, this.downloaded.version)) {
          if (info.version === this.downloaded.version && !sameTarget(info, this.downloaded)) throw updateError('UPDATE_TARGET_MISMATCH');
          if (this.ready()) {
            await this.adapter.validate(this.downloaded);
            return this.set({ status: 'downloaded', version: this.downloaded.version });
          }
        }
        this.target = info;
        this.set({ status: 'available', version: info.version, canInstall: false });
        // 自动下载由此处显式启动，确保下载 promise 一定被观察并保持同一目标。
        void this.startDownload(info);
        return this.getState();
      } catch (error) {
        return this.fail(error);
      }
    });
    this.checkPromise = operation;
    void operation.finally(() => { if (this.checkPromise === operation) this.checkPromise = null; });
    return operation;
  }

  private startDownload(info: NativeUpdateInfo): Promise<DesktopUpdateResult> {
    if (this.downloadPromise) return this.downloadPromise;
    const attempt = { info, event: null as NativeUpdateInfo | null };
    this.downloadAttempt = attempt;
    this.set({ status: 'downloading', version: info.version, percent: 0, canInstall: false });
    const operation = Promise.resolve().then(async () => {
      try {
        await this.adapter.download();
        if (this.downloadAttempt !== attempt || !this.target || !sameTarget(info, this.target)
          || !attempt.event || !sameTarget(info, attempt.event)) throw updateError('UPDATE_TARGET_MISMATCH');
        await this.adapter.validate(info);
        this.downloaded = info;
        return this.set({ status: 'downloaded', version: info.version, percent: 100, canInstall: true });
      } catch (error) {
        return this.fail(error);
      }
    });
    this.downloadPromise = operation;
    void operation.finally(() => {
      if (this.downloadAttempt === attempt) this.downloadAttempt = null;
      if (this.downloadPromise === operation) this.downloadPromise = null;
    });
    return operation;
  }

  progress(progress: { percent: number; transferred: number; total: number; bytesPerSecond: number }): void {
    if (!this.downloadAttempt) return;
    const nonnegative = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
    this.set({ status: 'downloading', version: this.downloadAttempt.info.version,
      percent: Math.min(100, nonnegative(progress.percent)), transferred: nonnegative(progress.transferred),
      total: nonnegative(progress.total), bytesPerSecond: nonnegative(progress.bytesPerSecond), canInstall: false });
  }

  downloadedEvent(info: NativeUpdateInfo): void {
    if (this.downloadAttempt && sameTarget(this.downloadAttempt.info, info)) this.downloadAttempt.event = info;
  }

  updaterError(error: unknown): void {
    // check/download 的错误由各自 promise 接管；没有来源标识的迟到 error 不得覆盖已完成下载。
    if (!this.installRequested) return;
    this.installRequested = false;
    this.fail(error);
  }

  install(): Promise<DesktopUpdateResult> {
    if (!this.capability.supported || this.installRequested) return Promise.resolve(this.getState());
    if (this.installPromise) return this.installPromise;
    if (!this.ready()) {
      if (this.downloaded && !this.adapter.hasCachedFile()) return Promise.resolve(this.fail(updateError('UPDATE_FILE_MISSING'), false));
      return Promise.resolve({ ...this.getState(), code: 'UPDATE_NOT_READY', error: '新版尚未准备完成，请稍后再试' });
    }
    const operation = Promise.resolve().then(async () => {
      try {
        // 安装前再看一次目标；发现新版本则准备最新版本，不让用户先安装一个已落后的缓存。
        await this.check(true);
        if (this.downloadPromise) await this.downloadPromise;
        if (!this.ready() || this.state.canInstall === false) return this.getState();
        const info = this.downloaded!;
        await this.adapter.validate(info);
        if (!this.target || !sameTarget(info, this.target)) throw updateError('UPDATE_TARGET_MISMATCH');
        this.installRequested = true;
        this.set({ status: 'installing', version: info.version, canInstall: false });
        this.adapter.install();
        return this.getState();
      } catch (error) {
        this.installRequested = false;
        return this.fail(error);
      }
    });
    this.installPromise = operation;
    void operation.finally(() => { if (this.installPromise === operation) this.installPromise = null; });
    return operation;
  }
}
import type { DesktopUpdateResult } from './contract';
