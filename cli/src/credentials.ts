import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError, EXIT_CODES } from './errors.js';
import { runProcess } from './process-utils.js';
import type { StoredCredential } from './types.js';

const SERVICE_NAME = 'cn.luxai.cli';

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
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, data, { encoding: 'utf8', mode });
  await chmod(temporary, mode).catch(() => undefined);
  if (process.platform === 'win32') {
    await rm(path, { force: true }).catch(() => undefined);
  }
  await rename(temporary, path);
}

class WindowsDpapiCredentialStore implements CredentialStore {
  readonly kind = 'windows-dpapi-current-user';

  private path(profile: string): string {
    return join(configRoot(), `credential-${profile}.dpapi`);
  }

  async load(profile: string): Promise<StoredCredential | null> {
    let encrypted: string;
    try {
      encrypted = (await readFile(this.path(profile), 'utf8')).trim();
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
    return assertCredential(JSON.parse(result.stdout));
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
    await rm(this.path(profile), { force: true });
  }
}

class LinuxSecretServiceCredentialStore implements CredentialStore {
  readonly kind = 'linux-secret-service';

  async load(profile: string): Promise<StoredCredential | null> {
    const result = await runProcess('secret-tool', [
      'lookup', 'service', SERVICE_NAME, 'profile', profile,
    ], { allowFailure: true });
    if (result.code !== 0 || !result.stdout.trim()) return null;
    return assertCredential(JSON.parse(result.stdout));
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
    return assertCredential(JSON.parse(result.stdout));
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
      return assertCredential(JSON.parse(await readFile(this.path, 'utf8')));
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
    await rm(this.path, { force: true });
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
      if (!this.fallback) throw error;
    }
    return this.fallback!.load(profile);
  }

  async save(profile: string, credential: StoredCredential): Promise<void> {
    try {
      await this.primary.save(profile, credential);
    } catch (error) {
      if (!this.fallback) throw error;
      await this.fallback.save(profile, credential);
      return;
    }
    if (this.fallback) await this.fallback.delete(profile).catch(() => undefined);
  }

  async delete(profile: string): Promise<void> {
    let primaryError: unknown;
    try { await this.primary.delete(profile); } catch (error) { primaryError = error; }
    if (this.fallback) await this.fallback.delete(profile);
    else if (primaryError) throw primaryError;
  }
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

  constructor(
    readonly profile: string,
    baseUrl = 'https://luxai.cn',
    readonly store: CredentialStore = createCredentialStore(profile),
  ) {
    const parsed = new URL(baseUrl);
    this.origin = parsed.origin.toLowerCase();
    const originHash = createHash('sha256').update(this.origin).digest('hex').slice(0, 16);
    this.storageProfile = `${profile}--${originHash}`;
  }

  async load(): Promise<StoredCredential | null> {
    let credential = await this.store.load(this.storageProfile);
    if (!credential && this.origin === 'https://luxai.cn') {
      const legacy = await this.store.load(this.profile);
      if (legacy && (!legacy.server_origin || legacy.server_origin === this.origin)) {
        credential = { ...legacy, server_origin: this.origin };
        await this.store.save(this.storageProfile, credential);
        await this.store.delete(this.profile).catch(() => undefined);
      }
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
    return this.store.save(this.storageProfile, {
      ...credential,
      server_origin: this.origin,
    });
  }

  delete(): Promise<void> {
    return this.store.delete(this.storageProfile);
  }

  async withRefreshLock<T>(operation: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const root = coordinationRoot();
    const lockPath = join(root, `refresh-${this.storageProfile}.lock`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    while (!acquired) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 60_000) {
          await rmdir(lockPath).catch(() => undefined);
          continue;
        }
        if (Date.now() >= deadline) {
          throw new CliError('TIMEOUT', '等待本机凭据刷新锁超时', {
            exitCode: EXIT_CODES.timeoutOrCanceled,
          });
        }
        await delay(75 + Math.floor(Math.random() * 75));
      }
    }
    try {
      return await operation();
    } finally {
      await rmdir(lockPath).catch(() => undefined);
    }
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
