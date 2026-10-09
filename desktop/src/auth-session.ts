import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { DesktopZhicuiSession } from './contract';

interface SavedSession extends DesktopZhicuiSession { refresh_token?: string; session_id?: string }
interface Vault { version: 2; origin: string; session: SavedSession; requestId?: string; logoutPending?: boolean }
export type AuthConnectionState = 'restoring' | 'ready' | 'signed_out' | 'offline';
interface Dependencies {
  fetch?: typeof fetch;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
}
function expiry(token: string): number {
  try { return Number(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp) * 1000; }
  catch { return 0; }
}

/** 主进程独立恢复，不向网页或本机桥输出刷新凭证。 */
export class DesktopAuthSession {
  state: AuthConnectionState = 'restoring';
  private vault: Vault | null = null;
  private loaded = false;
  private generation = 0;
  private pending: Promise<DesktopZhicuiSession | null> | null = null;
  private adoption: { token: string; promise: Promise<DesktopZhicuiSession> } | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private transport: typeof fetch;
  private encrypt: (value: string) => Buffer;
  private decrypt: (value: Buffer) => string;
  constructor(private readonly path: string, private readonly origin: string,
    private readonly onSession: (session: DesktopZhicuiSession | null) => Promise<void>, dependencies: Dependencies = {}) {
    this.transport = dependencies.fetch || fetch;
    this.encrypt = dependencies.encrypt || ((value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('SESSION_STORAGE_UNAVAILABLE: 系统加密暂不可用');
      return safeStorage.encryptString(value);
    });
    this.decrypt = dependencies.decrypt || ((value) => safeStorage.decryptString(value));
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const value = JSON.parse(this.decrypt(await readFile(this.path))) as Vault;
      if (value && (value.version !== 2 || value.origin !== this.origin)) throw new Error('SESSION_ORIGIN_MISMATCH');
      this.vault = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }
  private save(): Promise<void> {
    const value = this.encrypt(JSON.stringify(this.vault));
    const operation = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, value, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  private publicSession(): DesktopZhicuiSession | null {
    const value = this.vault?.session;
    return value && !this.vault?.logoutPending ? { token: value.token, user: value.user } : null;
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.then(operation, operation);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private async request(path: string, body?: unknown, token?: string): Promise<SavedSession> {
    const response = await this.transport(`${this.origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Zhicui-Session-Version': '2',
        'X-Zhicui-Session-Transport': 'native', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12_000),
    });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: SavedSession; detail?: { code?: string } } | null;
    if (!response.ok || !payload?.success) {
      throw new Error(response.status === 401 ? `${payload?.detail?.code || 'SESSION_EXPIRED'}: 请确认知萃登录`
        : 'SESSION_TEMPORARY: 暂时无法连接知萃，会话已保留');
    }
    return payload.data!;
  }
  restore(force = false): Promise<DesktopZhicuiSession | null> {
    if (this.adoption) return this.adoption.promise;
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = this.exclusive(() => this.restoreNow(force, generation)).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async restoreNow(force: boolean, generation: number): Promise<DesktopZhicuiSession | null> {
    if (generation !== this.generation) return null;
    try {
      await this.load();
      if (!this.vault || this.vault.logoutPending) {
        this.state = 'signed_out';
        if (this.vault?.logoutPending) await this.finishLogout().catch(() => undefined);
        return null;
      }
      const current = this.vault.session;
      let next = current;
      if (!current.refresh_token && (expiry(current.token) > Date.now() || this.vault.requestId)) {
        this.vault.requestId ||= randomUUID();
        await this.save();
        next = await this.request('/api/auth/session/migrate', { request_id: this.vault.requestId }, current.token);
      } else if (force || this.vault.requestId || expiry(current.token) <= Date.now() + 60_000) {
        if (!current.refresh_token) throw new Error('SESSION_EXPIRED: 登录需要重新验证');
        this.vault.requestId ||= randomUUID();
        await this.save();
        next = await this.request('/api/auth/refresh', { refresh_token: current.refresh_token, request_id: this.vault.requestId });
      } else {
        try {
          const user = await this.request('/api/auth/me', undefined, current.token);
          next = { ...current, user: user as unknown as DesktopZhicuiSession['user'] };
        } catch (error) {
          if (!String(error).includes('SESSION_EXPIRED') || !current.refresh_token) throw error;
          this.vault.requestId ||= randomUUID();
          await this.save();
          next = await this.request('/api/auth/refresh', { refresh_token: current.refresh_token, request_id: this.vault.requestId });
        }
      }
      if (generation !== this.generation) return null;
      if (!next.token || !next.user?.agent_profile_key) throw new Error('SESSION_INVALID: 账号资料不完整');
      this.vault = { version: 2, origin: this.origin, session: next };
      await this.save();
      if (generation !== this.generation) return null;
      this.state = 'ready';
      const value = this.publicSession();
      await this.onSession(value);
      return value;
    } catch (error) {
      if (generation !== this.generation) return null;
      const terminal = /SESSION_(EXPIRED|REVOKED|INVALID|REFRESH_REUSED)|ACCOUNT_DISABLED/.test(String(error));
      this.state = terminal ? 'signed_out' : 'offline';
      if (terminal) { this.vault = null; await this.save(); await this.onSession(null); }
      throw error;
    }
  }
  adopt(token: string): Promise<DesktopZhicuiSession> {
    if (this.adoption?.token === token) return this.adoption.promise;
    const generation = ++this.generation;
    const promise = this.exclusive(() => this.adoptNow(token, generation)).finally(() => {
      if (this.adoption?.promise === promise) this.adoption = null;
    });
    this.adoption = { token, promise };
    return promise;
  }
  private async adoptNow(token: string, generation: number): Promise<DesktopZhicuiSession> {
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    if (typeof token !== 'string' || token.length > 16000) throw new Error('SESSION_INVALID: 登录凭证无效');
    await this.load();
    const resuming = this.vault?.session.token === token && !!this.vault.requestId && !this.vault.logoutPending;
    const knownRefresh = this.vault?.session.token === token && !!this.vault.session.refresh_token && !this.vault.logoutPending;
    if (expiry(token) <= Date.now() && !resuming && !knownRefresh) throw new Error('SESSION_INVALID: 登录凭证无效');
    if (this.vault?.session.token === token && this.vault.session.refresh_token && !this.vault.logoutPending) {
      if (this.vault.requestId || expiry(token) <= Date.now() + 60_000) {
        const recovered = await this.restoreNow(false, generation);
        if (!recovered) throw new Error('SESSION_CHANGED');
        return recovered;
      }
      this.state = 'ready';
      await this.onSession(this.publicSession());
      return this.publicSession()!;
    }
    const requestId = this.vault?.session.token === token && this.vault.requestId ? this.vault.requestId : randomUUID();
    // 先加密保存迁移中的 JWT 和请求标识，进程退出后仍可恢复同一次请求。
    const user = resuming ? this.vault!.session.user
      : await this.request('/api/auth/me', undefined, token) as unknown as DesktopZhicuiSession['user'];
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    this.vault = { version: 2, origin: this.origin, session: { token, user }, requestId };
    await this.save();
    const value = await this.request('/api/auth/session/migrate', { request_id: requestId }, token);
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    this.vault = { version: 2, origin: this.origin, session: value };
    await this.save();
    if (generation !== this.generation) throw new Error('SESSION_CHANGED');
    this.state = 'ready';
    await this.onSession(this.publicSession());
    return this.publicSession()!;
  }
  logout(expectedSessionId?: string): Promise<void> {
    // 条件退出用于补偿旧页面未完成的 IPC；不能注销之后登录的新会话。
    const expectedGeneration = this.generation;
    if (expectedSessionId !== undefined) return this.exclusive(async () => {
      if (expectedGeneration !== this.generation) return;
      await this.load();
      if (expectedGeneration !== this.generation) return;
      let current = this.vault?.session.session_id;
      if (!current && this.vault?.session.token) {
        try { current = JSON.parse(Buffer.from(this.vault.session.token.split('.')[1], 'base64url').toString()).sid; } catch { /* 旧凭据不匹配条件退出 */ }
      }
      if (!current || current !== expectedSessionId) return;
      await this.logoutNow(++this.generation);
    });
    const generation = ++this.generation;
    return this.exclusive(() => this.logoutNow(generation));
  }
  private async logoutNow(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    await this.load();
    this.state = 'signed_out';
    if (this.vault) { this.vault.logoutPending = true; this.vault.requestId = randomUUID(); await this.save(); }
    await this.onSession(null);
    await this.finishLogout();
  }
  private async finishLogout(): Promise<void> {
    const value = this.vault;
    if (!value?.logoutPending) return;
    await this.request('/api/auth/logout', { refresh_token: value.session.refresh_token, request_id: value.requestId }, value.session.token);
    if (this.vault === value) { this.vault = null; await this.save(); }
  }
}
