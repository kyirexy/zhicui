import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlatformAccountProvider, PlatformAccountResult } from './contract';

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

interface LockRecord {
  token: string;
  pid: number;
  createdAt: number;
}

export interface DesktopActionLease {
  key: string;
  release(): Promise<void>;
}

export class LocalActionBusyError extends Error {
  readonly code = 'LOCAL_ACTION_BUSY';

  constructor(message = '同一账号和平台已有本机操作正在进行') {
    super(message);
    this.name = 'LocalActionBusyError';
  }
}

export function desktopUserHash(profileKey: string): string {
  return createHash('sha256').update(profileKey).digest('hex');
}

export function platformSessionPath(
  baseDirectory: string,
  profileKey: string,
  platform: PlatformAccountProvider,
): string {
  return join(baseDirectory, desktopUserHash(profileKey), platform);
}

export function localPlatformLockKey(
  profileKey: string,
  platform: PlatformAccountProvider,
): string {
  return `${desktopUserHash(profileKey)}:${platform}`;
}

export function normalizeLocalPlatformResult(
  platform: PlatformAccountProvider,
  value: Partial<PlatformAccountResult>,
): PlatformAccountResult {
  const error = String(value.error || '')
    .split(/\r?\n/, 1)[0]
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[本机路径]')
    .replace(/((?:cookie|jwt|api[_-]?key|token))\s*[=:]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .slice(0, 220);
  return {
    ...value,
    success: value.success === true,
    platform,
    error: error || undefined,
    urls: value.urls?.slice(0, 100),
    items: value.items?.slice(0, 100),
    count: Number.isFinite(value.count) ? Math.max(0, Number(value.count)) : undefined,
  };
}

export class CrossProcessActionLock {
  constructor(
    private readonly directory: () => string,
    private readonly staleMs = DEFAULT_LOCK_STALE_MS,
  ) {}

  async acquire(key: string): Promise<DesktopActionLease> {
    const root = this.directory();
    await mkdir(root, { recursive: true });
    const fileName = `${createHash('sha256').update(key).digest('hex')}.lock`;
    const path = join(root, fileName);
    const token = randomUUID();
    let handle: FileHandle | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await open(path, 'wx', 0o600);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' || attempt > 0 || !await this.removeIfStale(path)) {
          throw new LocalActionBusyError();
        }
      }
    }
    if (!handle) throw new LocalActionBusyError();
    const record: LockRecord = { token, pid: process.pid, createdAt: Date.now() };
    try {
      await handle.writeFile(JSON.stringify(record), { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    let released = false;
    return {
      key,
      release: async () => {
        if (released) return;
        released = true;
        const current = await this.readRecord(path);
        if (current?.token !== token) return;
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      },
    };
  }

  private async readRecord(path: string): Promise<LockRecord | null> {
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockRecord>;
      if (
        typeof value.token !== 'string'
        || typeof value.pid !== 'number'
        || typeof value.createdAt !== 'number'
      ) {
        return null;
      }
      return value as LockRecord;
    } catch {
      return null;
    }
  }

  private async removeIfStale(path: string): Promise<boolean> {
    const record = await this.readRecord(path);
    if (record && Date.now() - record.createdAt <= this.staleMs) return false;
    try {
      await unlink(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}
