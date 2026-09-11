import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, EXIT_CODES } from './errors.js';
import { runProcess } from './process-utils.js';
import type { StoredCredential } from './types.js';

const SERVICE_NAME = 'cn.luxai.cli';
const FILE_OPERATION_TIMEOUT_MS = 5_000;

export interface CredentialStore {
  readonly kind: string;
  load(profile: string): Promise<StoredCredential | null>;
  save(profile: string, credential: StoredCredential): Promise<void>;
  delete(profile: string): Promise<void>;
}

function assertCredential(value: unknown): StoredCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError('CREDENTIAL_CORRUPTED', '本机凭据格式无效');
  }
  const item = value as Partial<StoredCredential>;
  if (
    (item.kind !== 'pat' && item.kind !== 'device')
    || typeof item.access_token !== 'string'
    || item.access_token.length < 8
    || typeof item.created_at !== 'string'
  ) {
    throw new CliError('CREDENTIAL_CORRUPTED', '本机凭据字段不完整');
  }
  if (
    (item.refresh_token !== undefined && typeof item.refresh_token !== 'string')
    || (item.expires_at !== undefined && (
      typeof item.expires_at !== 'string' || !Number.isFinite(Date.parse(item.expires_at))
    ))
    || (item.token_prefix !== undefined && typeof item.token_prefix !== 'string')
    || (item.server_origin !== undefined && typeof item.server_origin !== 'string')
    || (item.scopes !== undefined && (
      !Array.isArray(item.scopes) || !item.scopes.every((scope) => typeof scope === 'string')
    ))
  ) {
    throw new CliError('CREDENTIAL_CORRUPTED', '本机凭据可选字段无效');
  }
  return item as StoredCredential;
}

function parseCredential(value: string): StoredCredential {
  try {
    return assertCredential(JSON.parse(value));
  } catch (error) {
    if (error instanceof CliError) throw error;
    // JSON 解析错误会带原文片段，凭据损坏时也不能把令牌输出至终端。
    throw new CliError('CREDENTIAL_CORRUPTED', '本机凭据格式无效，请重新登录');
  }
}

function configRoot(): string {
  if (process.env.ZHICUI_CONFIG_HOME) return process.env.ZHICUI_CONFIG_HOME;
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Zhicui', 'cli');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'zhicui');
}

function coordinationRoot(): string {
  return process.env.ZHICUI_CREDENTIALS_FILE
    ? dirname(process.env.ZHICUI_CREDENTIALS_FILE)
    : configRoot();
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, data, { encoding: 'utf8', mode });
    await chmod(temporary, mode).catch(() => undefined);
    await withCredentialWriteGate(path, () => retryWindowsFileOperation(() => rename(temporary, path)));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function credentialFileTimeout(): CliError {
  return new CliError('TIMEOUT', '等待本机凭据文件读写超时，请稍后重试', {
    exitCode: EXIT_CODES.timeoutOrCanceled,
  });
}

async function retryWindowsFileOperation<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + FILE_OPERATION_TIMEOUT_MS;
  for (;;) {
    try { return await operation(); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error;
      if (Date.now() >= deadline) throw credentialFileTimeout();
      await delay(25);
    }
  }
}

async function credentialWriterPresent(gate: string, preserveUnknownEmpty = false): Promise<boolean> {
  let owners: string[];
  try { owners = await readdir(gate); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    // Windows 在门控目录换入/移除时也可能短暂拒绝扫描，按仍在写入等待。
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(code || '')) return true;
    throw error;
  }
  // 旧版刷新锁没有 owner，无法证明其持有者已退出，不能按目录时间抢锁。
  if (owners.length === 0 && preserveUnknownEmpty) return true;
  for (const owner of owners) {
    const match = /^owner-([1-9]\d*)-[a-f0-9-]+$/u.exec(owner);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return true;
    try { process.kill(Number(match[1]), 0); return true; } catch (error) {
      // 仅清理能够确认已退出的进程，不按时间猜测活跃写入已经失效。
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      await retryWindowsFileOperation(() => rm(join(gate, owner), { force: true }));
    }
  }
  // 只移除空目录。另一进程已换入的新 owner 不会被误删。
  await retryWindowsFileOperation(() => rmdir(gate)).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
  });
  return false;
}

async function withOwnedCredentialGate<T>(
  gate: string,
  operation: () => Promise<T>,
  timeoutMs = FILE_OPERATION_TIMEOUT_MS,
  preserveUnknownEmpty = false,
): Promise<T> {
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = `${gate}.${owner}`;
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(gate), { recursive: true, mode: 0o700 });
  await mkdir(candidate, { mode: 0o700 });
  let acquired = false;
  try {
    await writeFile(join(candidate, owner), '', { mode: 0o600, flag: 'wx' });
    for (;;) {
      if (!(await credentialWriterPresent(gate, preserveUnknownEmpty))) {
        try {
          // owner 随目录一同出现；已有非空门控不会被 rename 覆盖。
          await rename(candidate, gate);
          acquired = true;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(code || '')) throw error;
        }
      }
      if (Date.now() >= deadline) throw credentialFileTimeout();
      await delay(15 + Math.floor(Math.random() * 15));
    }
    return await operation();
  } finally {
    const directory = acquired ? gate : candidate;
    await retryWindowsFileOperation(() => rm(join(directory, owner), { force: true }));
    await retryWindowsFileOperation(() => rmdir(directory)).catch((error) => {
      // 其他写入者可能已原子换入新的非空目录，此时不拥有目录的删除权。
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    });
  }
}

async function withCredentialWriteGate<T>(path: string, operation: () => Promise<T>): Promise<T> {
  return withOwnedCredentialGate(`${path}.write-lock`, operation);
}

async function readCredentialFile(path: string): Promise<string> {
  const deadline = Date.now() + FILE_OPERATION_TIMEOUT_MS;
  // 写入排队后暂停新读取，避免持续 readFile 在 Windows 令替换操作饥饿。
  // 已进入的读取仍可完成；写入只需等待这批有限的文件句柄释放。
  while (await credentialWriterPresent(`${path}.write-lock`)) {
    if (Date.now() >= deadline) throw credentialFileTimeout();
    await delay(15 + Math.floor(Math.random() * 15));
  }
  return retryWindowsFileOperation(() => readFile(path, 'utf8'));
}

async function deleteCredentialFile(path: string): Promise<void> {
  await withCredentialWriteGate(path, () => retryWindowsFileOperation(() => rm(path, { force: true })));
}

class WindowsDpapiCredentialStore implements CredentialStore {
  readonly kind = 'windows-dpapi-current-user';

  private path(profile: string): string {
    return join(configRoot(), `credential-${profile}.dpapi`);
  }

  async load(profile: string): Promise<StoredCredential | null> {
    let encrypted: string;
    try {
      encrypted = (await readCredentialFile(this.path(profile))).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$cipher=[Console]::In.ReadToEnd().Trim();',
      '$bytes=[Convert]::FromBase64String($cipher);',
      '$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain));',
    ].join('');
    const result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { input: encrypted, timeoutMs: 15_000 });
    return parseCredential(result.stdout);
  }

  async save(profile: string, credential: StoredCredential): Promise<void> {
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$plain=[Console]::In.ReadToEnd();',
      '$bytes=[Text.Encoding]::UTF8.GetBytes($plain);',
      '$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($cipher));',
    ].join('');
    const result = await runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], { input: JSON.stringify(credential), timeoutMs: 15_000 });
    await atomicWrite(this.path(profile), result.stdout.trim());
  }

  async delete(profile: string): Promise<void> {
    await deleteCredentialFile(this.path(profile));
  }
}

class LinuxSecretServiceCredentialStore implements CredentialStore {
  readonly kind = 'linux-secret-service';

  async load(profile: string): Promise<StoredCredential | null> {
    const result = await runProcess('secret-tool', [
      'lookup', 'service', SERVICE_NAME, 'profile', profile,
    ], { allowFailure: true });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return parseCredential(result.stdout);
  }

  async save(profile: string, credential: StoredCredential): Promise<void> {
    await runProcess('secret-tool', [
      'store', '--label=知萃 CLI', 'service', SERVICE_NAME, 'profile', profile,
    ], { input: JSON.stringify(credential) });
  }

  async delete(profile: string): Promise<void> {
    await runProcess('secret-tool', [
      'clear', 'service', SERVICE_NAME, 'profile', profile,
    ], { allowFailure: true });
  }
}

class MacKeychainCredentialStore implements CredentialStore {
  readonly kind = 'macos-keychain';

  async load(profile: string): Promise<StoredCredential | null> {
    const result = await runProcess('/usr/bin/security', [
      'find-generic-password', '-a', profile, '-s', SERVICE_NAME, '-w',
    ], { allowFailure: true });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return parseCredential(result.stdout);
  }

  async save(profile: string, credential: StoredCredential): Promise<void> {
    // `security -w` without an argv value consumes the password from stdin.
    await runProcess('/usr/bin/security', [
      'add-generic-password', '-U', '-a', profile, '-s', SERVICE_NAME, '-w',
    ], { input: JSON.stringify(credential) });
  }

  async delete(profile: string): Promise<void> {
    await runProcess('/usr/bin/security', [
      'delete-generic-password', '-a', profile, '-s', SERVICE_NAME,
    ], { allowFailure: true });
  }
}

class ExplicitFileCredentialStore implements CredentialStore {
  readonly kind = 'explicit-plaintext-file';
  constructor(private readonly path: string) {}

  async load(_profile: string): Promise<StoredCredential | null> {
    try {
      return parseCredential(await readCredentialFile(this.path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async save(_profile: string, credential: StoredCredential): Promise<void> {
    if (process.env.ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS !== '1') {
      throw new CliError(
        'LOCAL_CAPABILITY_UNAVAILABLE',
        '系统凭据库不可用；仅在明确设置 ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS=1 后才能使用权限受限文件',
        { exitCode: EXIT_CODES.localUnavailable },
      );
    }
    await atomicWrite(this.path, JSON.stringify(credential));
  }

  async delete(_profile: string): Promise<void> {
    await deleteCredentialFile(this.path);
  }
}

class PreferredSystemCredentialStore implements CredentialStore {
  readonly kind: string;

  constructor(
    private readonly primary: CredentialStore,
    private readonly fallback: CredentialStore | null,
  ) {
    this.kind = fallback
      ? `${primary.kind}-preferred-with-explicit-file-fallback`
      : primary.kind;
  }

  async load(profile: string): Promise<StoredCredential | null> {
    try {
      const credential = await this.primary.load(profile);
      if (credential || !this.fallback) return credential;
    } catch (error) {
      if (!this.fallback || transientCredentialFailure(error)) throw error;
    }
    return this.fallback!.load(profile);
  }

  async save(profile: string, credential: StoredCredential): Promise<void> {
    try {
      await this.primary.save(profile, credential);
    } catch (error) {
      // 文件正在刷新不等于系统凭据库不可用，降级会让新旧凭据分叉。
      if (!this.fallback || transientCredentialFailure(error)) throw error;
      await this.fallback.save(profile, credential);
      return;
    }
    if (this.fallback) await this.fallback.delete(profile).catch(() => undefined);
  }

  async delete(profile: string): Promise<void> {
    let primaryError: unknown;
    try { await this.primary.delete(profile); } catch (error) { primaryError = error; }
    if (this.fallback) await this.fallback.delete(profile);
    if (primaryError) throw primaryError;
  }
}

function transientCredentialFailure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | CliError | null)?.code;
  return ['TIMEOUT', 'EPERM', 'EACCES', 'EBUSY'].includes(code || '');
}

export function createCredentialStore(profile = 'default'): CredentialStore {
  if (process.env.ZHICUI_CREDENTIALS_FILE) {
    return new ExplicitFileCredentialStore(process.env.ZHICUI_CREDENTIALS_FILE);
  }
  const primary = process.platform === 'win32'
    ? new WindowsDpapiCredentialStore()
    : process.platform === 'darwin'
      ? new MacKeychainCredentialStore()
      : new LinuxSecretServiceCredentialStore();
  const fallback = process.env.ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS === '1'
    ? new ExplicitFileCredentialStore(join(configRoot(), `credential-${profile}.json`))
    : null;
  return new PreferredSystemCredentialStore(primary, fallback);
}

export class CredentialManager {
  readonly origin: string;
  readonly storageProfile: string;
  readonly coordinationProfile: string;

  constructor(
    readonly profile: string,
    baseUrl = 'https://luxai.cn',
    readonly store: CredentialStore = createCredentialStore(profile),
  ) {
    const parsed = new URL(baseUrl);
    this.origin = parsed.origin.toLowerCase();
    const originHash = createHash('sha256').update(this.origin).digest('hex').slice(0, 16);
    this.storageProfile = `${profile}--${originHash}`;
    const explicitPath = process.env.ZHICUI_CREDENTIALS_FILE;
    // 显式文件忽略 profile，同一文件的所有调用必须共用读改写与刷新锁。
    const resolvedPath = explicitPath && store.kind === 'explicit-plaintext-file'
      ? resolve(explicitPath) : null;
    this.coordinationProfile = resolvedPath
      ? `file-${createHash('sha256').update(process.platform === 'win32'
        ? resolvedPath.toLowerCase() : resolvedPath).digest('hex').slice(0, 32)}`
      : this.storageProfile;
  }

  async load(): Promise<StoredCredential | null> {
    let credential = await this.store.load(this.storageProfile);
    if (!credential && this.origin === 'https://luxai.cn') {
      credential = await this.withMutationLock(async () => {
        // 排队期间可能已有登录或迁移完成，不能再以旧凭据覆盖。
        const latest = await this.store.load(this.storageProfile);
        if (latest) return latest;
        const legacy = await this.store.load(this.profile);
        if (!legacy || (legacy.server_origin && legacy.server_origin !== this.origin)) return null;
        const migrated = { ...legacy, server_origin: this.origin };
        await this.store.save(this.storageProfile, migrated);
        await this.store.delete(this.profile).catch(() => undefined);
        return migrated;
      });
    }
    if (!credential) return null;
    if (credential.server_origin !== this.origin) {
      throw new CliError(
        'CREDENTIAL_ORIGIN_MISMATCH',
        '当前凭据属于另一个知萃服务地址，已阻止跨来源发送',
        { exitCode: EXIT_CODES.permission },
      );
    }
    return credential;
  }

  save(credential: StoredCredential): Promise<void> {
    return this.withMutationLock(() => this.store.save(this.storageProfile, {
      ...credential, server_origin: this.origin,
    }));
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return withOwnedCredentialGate(
      join(coordinationRoot(), `credential-${this.coordinationProfile}.mutation-lock`), operation,
    );
  }

  private async replaceIfUnchanged(
    expected: StoredCredential,
    replacement: StoredCredential | null,
  ): Promise<boolean> {
    return this.withMutationLock(async () => {
      const latest = await this.store.load(this.storageProfile);
      if (!latest || latest.server_origin !== this.origin
        || latest.kind !== expected.kind || latest.created_at !== expected.created_at
        || latest.access_token !== expected.access_token
        || latest.refresh_token !== expected.refresh_token) return false;
      if (replacement) {
        await this.store.save(this.storageProfile, { ...replacement, server_origin: this.origin });
      } else {
        await this.store.delete(this.storageProfile);
      }
      return true;
    });
  }

  saveIfUnchanged(expected: StoredCredential, replacement: StoredCredential): Promise<boolean> {
    return this.replaceIfUnchanged(expected, replacement);
  }

  deleteIfUnchanged(expected: StoredCredential): Promise<boolean> {
    return this.replaceIfUnchanged(expected, null);
  }

  delete(): Promise<void> {
    return this.withMutationLock(() => this.store.delete(this.storageProfile));
  }

  async withRefreshLock<T>(operation: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const root = coordinationRoot();
    const legacyPath = join(root, `refresh-${this.storageProfile}.lock`);
    const lockPath = join(root, `refresh-${this.coordinationProfile}.v2.lock`);
    const deadline = Date.now() + timeoutMs;
    const waitForLegacy = async () => {
      while (await credentialWriterPresent(legacyPath, true)) {
        if (Date.now() >= deadline) {
          throw new CliError('TIMEOUT', '等待旧版 CLI 刷新锁超时；请结束旧版命令后检查残留锁', {
            exitCode: EXIT_CODES.timeoutOrCanceled,
          });
        }
        await delay(25);
      }
    };
    await waitForLegacy();
    // v2 的 owner 随非空目录原子出现，空目录可以安全回收（含释放时崩溃）。
    // 旧版空目录可能仍在刷新，不能沿用 v2 的回收规则。
    return withOwnedCredentialGate(lockPath, async () => {
      await waitForLegacy();
      return operation();
    }, Math.max(1, deadline - Date.now()));
  }

  async status(): Promise<Record<string, unknown>> {
    const credential = await this.load();
    if (!credential) return { authenticated: false, store: this.store.kind };
    return {
      authenticated: true,
      kind: credential.kind,
      token_prefix: credential.token_prefix || `${credential.access_token.slice(0, 6)}…`,
      expires_at: credential.expires_at || null,
      scopes: credential.scopes || [],
      store: this.store.kind,
    };
  }
}

export async function isExecutableAvailable(command: string): Promise<boolean> {
  const pathEntries = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const directory of pathEntries) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === 'win32' ? `${command}${extension}` : command);
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        // Continue searching without exposing PATH content.
      }
    }
  }
  return false;
}
