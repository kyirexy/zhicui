import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { AuthUser } from './authSession.ts';

const logoutKey = 'zhicui:session-logged-out:v2';
const user: AuthUser = { id: 'fixture-user', email: 'fixture@example.test', username: 'fixture',
  is_active: true, is_admin: false, email_verified: true, created_at: '', agent_profile_key: 'fixture-profile' };
function session(sid: string, expiresIn = 3600) {
  const claims = { sub: user.id, sid, exp: Math.floor(Date.now() / 1000) + expiresIn };
  return { token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`, user };
}
type Session = ReturnType<typeof session>;

// 使用真实恢复模块与存储模块，只替换浏览器、IPC和网络；不读取本机凭据。
function harness(options: { native?: Session | null; failLogouts?: number; offline?: boolean;
  conditionalLogout?: boolean; transport?: (input: string, init?: RequestInit) => Promise<Response> } = {}) {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  let mainSession = options.native ?? null;
  let failures = options.failLogouts ?? 0;
  let requestId = 0;
  const calls = { restore: 0, adopt: 0, logout: [] as (string | undefined)[], fetch: [] as string[] };
  const events: { type: string; detail: unknown }[] = [];
  const bridge = {
    supportsConditionalAuthLogout: options.conditionalLogout !== false,
    async restoreAuthSession(): Promise<Session | null> { calls.restore++; return mainSession; },
    async adoptAuthSession(): Promise<Session> { calls.adopt++; throw new Error('不应重新迁移已退出凭据'); },
    async logoutAuthSession(expectedSessionId?: string): Promise<void> {
      calls.logout.push(expectedSessionId);
      if (failures-- > 0) throw new Error('IPC暂时不可用');
      const currentId = mainSession ? JSON.parse(Buffer.from(mainSession.token.split('.')[1], 'base64url').toString()).sid : null;
      if (!expectedSessionId || expectedSessionId === currentId) mainSession = null;
    },
  };
  const window = { localStorage, zhicuiDesktop: 'native' in options ? bridge : undefined,
    dispatchEvent: (event: { type: string; detail: unknown }) => { events.push(event); return true; } };
  const sandbox = { window, navigator: {}, process: { env: {} }, Date, atob,
    AbortSignal, Headers, Request, Response,
    crypto: { randomUUID: () => `fixture-request-${++requestId}` },
    CustomEvent,
    async fetch(input: string, init?: RequestInit) {
      calls.fetch.push(String(input));
      if (options.offline) throw new TypeError('offline');
      if (options.transport) return options.transport(input, init);
      return Response.json({ success: true, data: { logged_out: true } });
    },
  };
  function load(name: string, imports: Record<string, unknown> = {}) {
    const exports = {};
    const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    const javascript = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    runInNewContext(javascript, { ...sandbox, exports, require: (specifier: string) => {
      assert.ok(specifier in imports, `未预期的依赖：${specifier}`);
      return imports[specifier];
    } });
    return exports;
  }
  const auth = load('authSession') as typeof import('./authSession.ts');
  const recovery = load('sessionRecovery', { './authSession': auth,
    '@capacitor/core': { Capacitor: { isNativePlatform: () => false } } }) as typeof import('./sessionRecovery.ts');
  return { auth, recovery, localStorage, calls, events, bridge,
    current: () => mainSession, setNative: (value: Session | null) => { mainSession = value; } };
}

const rejected = (error: unknown) => Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected);

test('旧renderer布尔退出标记不会注销主进程已恢复的有效会话', async () => {
  const fresh = session('native-fresh');
  const h = harness({ native: fresh });
  h.localStorage.setItem(logoutKey, '1');
  const result = await h.recovery.recoverSession();
  assert.equal(result?.token, fresh.token);
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.logout.length, 0);
  assert.equal(h.calls.adopt, 0);
  assert.equal(h.localStorage.getItem(logoutKey), null);
});

test('真实主动退出由主进程确认，页面遗留token不能重新迁移而复活', async () => {
  const old = session('explicit-logout');
  const h = harness({ native: old });
  h.auth.writeStoredSession(old.token, user);
  await h.recovery.revokeSession(old.token);
  assert.equal(h.current(), null);
  assert.deepEqual(h.calls.logout, [undefined]);
  assert.equal(JSON.parse(h.localStorage.getItem(logoutKey)!).state, 'confirmed');
  await assert.rejects(h.recovery.recoverSession(), rejected);
  assert.equal(h.calls.adopt, 0);
  assert.equal(h.events.length, 0);
});

test('主动退出IPC失败保留原sid意图，恢复时仅针对该会话补偿退出', async () => {
  const old = session('pending-logout');
  const h = harness({ native: old, failLogouts: 1 });
  h.auth.writeStoredSession(old.token, user);
  await assert.rejects(h.recovery.revokeSession(old.token), /IPC/);
  h.auth.clearStoredSession();
  const stored = h.localStorage.getItem(logoutKey)!;
  assert.equal(JSON.parse(stored).sessionId, 'pending-logout');
  assert.equal(JSON.parse(stored).state, 'pending');
  assert.equal(stored.includes(old.token), false, '退出意图不保存JWT');
  await assert.rejects(h.recovery.recoverSession(), rejected);
  assert.deepEqual(h.calls.logout, [undefined, 'pending-logout']);
  assert.equal(h.current(), null);
  assert.equal(h.auth.readStoredToken(), null);
});

test('旧sid的未完成退出不能注销后来网页登录产生的新主进程会话', async () => {
  const old = session('older-session');
  const fresh = session('new-browser-login');
  const h = harness({ native: old, failLogouts: 1 });
  await assert.rejects(h.recovery.revokeSession(old.token));
  h.setNative(fresh);
  assert.equal((await h.recovery.recoverSession())?.token, fresh.token);
  assert.deepEqual(h.calls.logout, [undefined]);
  assert.equal(h.current()?.token, fresh.token);
  assert.equal(h.localStorage.getItem(logoutKey), null);
});

test('Web离线退出仍阻止HttpOnly Cookie自动恢复', async () => {
  const h = harness({ offline: true });
  await assert.rejects(h.recovery.revokeSession(session('web-session').token), /offline/);
  assert.equal(h.localStorage.getItem(logoutKey), '1');
  await assert.rejects(h.recovery.recoverSession(), rejected);
  assert.ok(h.calls.fetch.every(path => path.endsWith('/api/auth/logout')));
  assert.equal(h.events.length, 0);
});

test('网页登录handoff早于renderer订阅时，启动从主进程恢复并回填页面', async () => {
  const fresh = session('handoff-before-subscription');
  const h = harness({ native: fresh });
  // 没有模拟收到onZhicuiSession；仅保留旧页面退出标记。
  h.localStorage.setItem(logoutKey, '1');
  assert.equal(h.auth.readStoredToken(), null);
  const result = await h.recovery.recoverSession();
  assert.equal(result?.user.id, user.id);
  assert.equal(h.auth.readStoredToken(), fresh.token);
  assert.equal(h.events.at(-1)?.type, 'zhicui:session-updated');
  assert.equal(h.calls.logout.length, 0);
});

test('恢复快照后发生新handoff，补偿退出携带旧sid供主进程拒绝', async () => {
  const old = session('snapshot-old');
  const fresh = session('snapshot-new');
  const h = harness({ native: old, failLogouts: 1 });
  await assert.rejects(h.recovery.revokeSession(old.token));
  h.bridge.restoreAuthSession = async () => { h.setNative(fresh); return old; };
  await assert.rejects(h.recovery.recoverSession(), rejected);
  assert.deepEqual(h.calls.logout, [undefined, 'snapshot-old']);
  assert.equal(h.current()?.token, fresh.token);
  h.bridge.restoreAuthSession = async () => fresh;
  assert.equal((await h.recovery.recoverSession())?.token, fresh.token);
});

test('恢复等待期间显式登录后，旧退出快照不能发出补偿IPC', async () => {
  const old = session('async-old');
  const fresh = session('async-new');
  const h = harness({ native: old, failLogouts: 1 });
  await assert.rejects(h.recovery.revokeSession(old.token));
  let resolve!: (value: Session) => void;
  h.bridge.restoreAuthSession = () => new Promise(done => { resolve = done; });
  const pending = h.recovery.recoverSession();
  h.recovery.markExplicitLogin();
  h.auth.writeStoredSession(fresh.token, user);
  h.setNative(fresh);
  resolve(old);
  await assert.rejects(pending, /已忽略旧恢复结果/);
  assert.deepEqual(h.calls.logout, [undefined]);
  assert.equal(h.auth.readStoredToken(), fresh.token);
});

test('旧preload不支持条件退出时保留pending，不调用会忽略sid的logout', async () => {
  const old = session('legacy-bridge-old');
  const fresh = session('legacy-bridge-new');
  const h = harness({ native: old, failLogouts: 1, conditionalLogout: false });
  await assert.rejects(h.recovery.revokeSession(old.token));
  const pendingIntent = h.localStorage.getItem(logoutKey);
  // 主进程在恢复快照之后接到新网页登录；旧preload会丢弃任何参数。
  h.bridge.restoreAuthSession = async () => { h.setNative(fresh); return old; };
  h.bridge.logoutAuthSession = async () => { h.calls.logout.push(undefined); h.setNative(null); };
  await assert.rejects(h.recovery.recoverSession(), /请更新知萃客户端/);
  assert.deepEqual(h.calls.logout, [undefined], '不能调用旧版无条件退出IPC');
  assert.equal(h.localStorage.getItem(logoutKey), pendingIntent);
  assert.equal(h.current()?.token, fresh.token);
  h.bridge.restoreAuthSession = async () => fresh;
  assert.equal((await h.recovery.recoverSession())?.token, fresh.token);
});

test('Web迁移回包丢失且原JWT过期时，使用已保存request_id领取原回执', async () => {
  const expired = session('migration-old', -60);
  const fresh = session('migration-receipt');
  const requests: { path: string; requestId: string; authorization: string | null }[] = [];
  const h = harness({ transport: async (path, init) => {
    requests.push({ path, requestId: JSON.parse(String(init?.body)).request_id,
      authorization: new Headers(init?.headers).get('Authorization') });
    if (path.endsWith('/refresh')) return Response.json({ success: false }, { status: 401 });
    assert.equal(path, '/api/auth/session/migrate');
    return Response.json({ success: true, data: fresh });
  } });
  h.auth.writeStoredSession(expired.token, user);
  h.localStorage.setItem('zhicui:session-refresh-request:v2', 'existing-migration-receipt');
  assert.equal((await h.recovery.recoverSession())?.token, fresh.token);
  assert.deepEqual(requests.map(request => request.requestId), ['existing-migration-receipt', 'existing-migration-receipt']);
  assert.equal(requests[1].authorization, `Bearer ${expired.token}`);
  assert.equal(h.localStorage.getItem('zhicui:session-refresh-request:v2'), null);
});

test('没有待领取回执时，过期Web JWT不会发起新的迁移', async () => {
  const h = harness({ transport: async () => Response.json({ success: false }, { status: 401 }) });
  h.auth.writeStoredSession(session('expired-without-receipt', -60).token, user);
  await assert.rejects(h.recovery.recoverSession(), rejected);
  assert.deepEqual(h.calls.fetch, ['/api/auth/refresh']);
});
