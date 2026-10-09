import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopAuthSession } from '../dist/auth-session.js';

const root = await mkdtemp(join(tmpdir(), 'zhicui-auth-test-'));
const user = { id: 'one', email: 'one@example.test', agent_profile_key: 'test-profile-one' };
const jwt = (seconds = 3600) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds })).toString('base64url')}.test`;
const requests = [], receipt = new Map();
let loseResponse = false, offline = false, revoked = false, binds = [];
let generation = 0;
const transport = async (url, init) => {
  const body = init.body ? JSON.parse(init.body) : {};
  requests.push({ url, body });
  if (offline) throw new Error('offline');
  if (revoked && !url.endsWith('/logout')) return Response.json({ detail: { code: 'SESSION_REVOKED' } }, { status: 401 });
  if (url.endsWith('/me')) return Response.json({ success: true, data: user });
  if (url.endsWith('/logout')) return Response.json({ success: true, data: { logged_out: true } });
  const key = `${body.refresh_token || init.headers.Authorization}:${body.request_id}`;
  if (!receipt.has(key)) receipt.set(key, { token: jwt(), user, refresh_token: `test-secret-refresh-${++generation}` });
  if (loseResponse) { loseResponse = false; throw new Error('lost response'); }
  return Response.json({ success: true, data: receipt.get(key) });
};
const dependencies = { fetch: transport, encrypt: value => Buffer.from(value).map(byte => byte ^ 123), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 123).toString() };
const path = join(root, 'session.enc');
const session = () => new DesktopAuthSession(path, 'https://luxai.cn', async value => { binds.push(value); }, dependencies);
let auth = session();
assert.equal(await auth.restore(), null);
await auth.adopt(jwt());
assert.equal(auth.state, 'ready');
assert.equal((await readFile(path)).includes(Buffer.from('test-secret-refresh')), false);
auth = session();
assert.equal((await auth.restore()).user.id, user.id);
const before = requests.length;
await Promise.all([auth.restore(true), auth.restore(true), auth.restore(true)]);
assert.equal(requests.length - before, 1, '并发只刷新一次');
loseResponse = true;
await assert.rejects(auth.restore(true));
const lost = requests.at(-1).body;
auth = session();
await auth.restore();
assert.deepEqual(requests.at(-1).body, lost, '进程重启后恢复同一次刷新，不另建请求标识');
offline = true;
await assert.rejects(auth.restore());
assert.equal(auth.state, 'offline');
offline = false;
assert.equal((await auth.restore()).user.id, user.id);
offline = true;
await assert.rejects(auth.logout());
auth = session();
assert.equal(await auth.restore(), null, '离线退出不可自动复活');
offline = false;
assert.equal(await auth.restore(), null);
await auth.adopt(jwt());
revoked = true;
await assert.rejects(auth.restore());
assert.equal(auth.state, 'signed_out');
assert.equal(binds.at(-1), null);
console.log('桌面会话：重启恢复、并发刷新、回包丢失、断网、离线退出与撤销全部通过');

// 多个网页/主进程恢复请求不得重复迁移，旧恢复结果不得覆盖新登录。
revoked = false;
const racedPath = join(root, 'race.enc');
let releaseMe;
const held = new Promise(resolve => { releaseMe = resolve; });
let migrated = 0;
const racing = new DesktopAuthSession(racedPath, 'https://luxai.cn', async () => {}, {
  ...dependencies, fetch: async (url, init) => {
    if (url.endsWith('/me')) await held;
    if (url.endsWith('/migrate')) migrated++;
    return transport(url, init);
  },
});
const loginToken = jwt();
const adoption = racing.adopt(loginToken);
const duplicate = racing.adopt(loginToken);
const duringLogin = racing.restore();
releaseMe();
const values = await Promise.all([adoption, duplicate, duringLogin]);
assert.equal(migrated, 1, '交接与页面采用同一凭据时仅迁移一次');
assert(values.every(v => v.user.id === user.id));

// 主动退出在进行中的网页登录之后仍然生效，不能被迟到的响应覆盖。
let releaseLogoutRace;
const logoutGate = new Promise(resolve => { releaseLogoutRace = resolve; });
const logoutRace = new DesktopAuthSession(join(root, 'logout-race.enc'), 'https://luxai.cn', async () => {}, {
  ...dependencies, fetch: async (url, init) => { if (url.endsWith('/me')) await logoutGate; return transport(url, init); },
});
const interrupted = logoutRace.adopt(jwt());
const rejection = assert.rejects(interrupted, /SESSION_CHANGED/);
const exiting = logoutRace.logout();
releaseLogoutRace();
await Promise.all([rejection, exiting]);
assert.equal(await logoutRace.restore(), null);

// 旧页面补偿退出只能注销它自己的sid，新网页登录不受影响。
const sidToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600, sid: 'fresh-session' })).toString('base64url')}.test`;
const conditional = new DesktopAuthSession(join(root, 'conditional.enc'), 'https://luxai.cn', async () => {}, {
  ...dependencies, fetch: async (url, init) => {
    if (url.endsWith('/migrate')) return Response.json({ success: true, data: { token: sidToken, user, refresh_token: 'conditional-refresh', session_id: 'fresh-session' } });
    return transport(url, init);
  },
});
await conditional.adopt(jwt());
await conditional.logout('old-session');
assert.equal((await conditional.restore()).user.id, user.id);
await Promise.all([conditional.logout('fresh-session'), conditional.adopt(jwt(7200))]);
assert.equal(conditional.state, 'ready', '队列中的旧条件退出不能取消之后的新登录');
await conditional.logout('fresh-session');
assert.equal(await conditional.restore(), null);

// 持久化了迁移请求后，源JWT到期也应让服务端核对原回执。
const expired = jwt(-10);
const migrationPath = join(root, 'migration.enc');
const { writeFile } = await import('node:fs/promises');
await writeFile(migrationPath, dependencies.encrypt(JSON.stringify({ version: 2, origin: 'https://luxai.cn', session: { token: expired, user }, requestId: 'persisted-migration-request' })));
const migration = new DesktopAuthSession(migrationPath, 'https://luxai.cn', async () => {}, dependencies);
assert.equal((await migration.restore()).user.id, user.id);
assert(requests.at(-1).url.endsWith('/migrate'));
assert.equal(requests.at(-1).body.request_id, 'persisted-migration-request');
console.log('桌面回归：重复交接、登录/退出竞态、条件退出、过期迁移回执恢复全部通过');

const pendingRefreshPath = join(root, 'pending-refresh.enc');
await writeFile(pendingRefreshPath, dependencies.encrypt(JSON.stringify({ version: 2, origin: 'https://luxai.cn', session: { token: expired, user, refresh_token: 'pending-refresh-secret' }, requestId: 'persisted-refresh-request' })));
const pendingRefresh = new DesktopAuthSession(pendingRefreshPath, 'https://luxai.cn', async () => {}, dependencies);
const adoptedAfterLostRefresh = await pendingRefresh.adopt(expired);
assert.notEqual(adoptedAfterLostRefresh.token, expired, '采用已知旧token必须恢复原刷新，不能把过期access标为ready');
assert(requests.at(-1).url.endsWith('/refresh'));
assert.equal(requests.at(-1).body.request_id, 'persisted-refresh-request');
console.log('桌面回归：采用已过期的已知会话时先完成待恢复刷新通过');
