import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  clearStoredSession, createSessionEpoch, isCurrentSessionRejected,
  isSessionExpired, readCachedUser, readStoredToken, sessionExpiresAt,
  sessionFetch, SESSION_REJECTED_EVENT, TOKEN_STORAGE_KEY, USER_STORAGE_KEY,
  writeStoredSession, storedSessionChange, canUpdateCurrentUser,
} from './authSession.ts';

const user = {
  id: 'user-a', email: 'test@example.com', username: 'test-user', avatar_id: 'cartoon-1',
  is_active: true, is_admin: true, email_verified: true, created_at: '2026-01-01',
  agent_profile_key: 'private-agent-binding', password: 'never-cache-this',
};
const jwt = (id = user.id, exp = Math.floor(Date.now() / 1000) + 3600) => (
  `header.${Buffer.from(JSON.stringify({ sub: id, exp })).toString('base64url')}.signature`
);
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('重启可复用同一存储的有效 token 与最小账号缓存，不保存密码或 Agent 绑定', () => {
  const storage = memoryStorage();
  const token = jwt();
  writeStoredSession(token, user, storage);
  assert.equal(readStoredToken(storage), token);
  const restored = readCachedUser(token, storage);
  assert.equal(restored?.id, user.id);
  assert.equal(restored?.username, user.username);
  assert.equal(restored?.avatar_id, user.avatar_id);
  assert.equal(restored?.is_admin, false);
  assert.equal(restored?.agent_profile_key, undefined);
  assert.doesNotMatch(storage.getItem(USER_STORAGE_KEY)!, /never-cache-this|private-agent-binding|signature/);
});

test('缓存只能恢复匹配 JWT 主体的账号，损坏/禁用缓存不恢复', () => {
  const storage = memoryStorage();
  writeStoredSession(jwt(), user, storage);
  assert.equal(readCachedUser(jwt('user-b'), storage), null);
  storage.setItem(USER_STORAGE_KEY, '{broken');
  assert.equal(readCachedUser(jwt(), storage), null);
  writeStoredSession(jwt(), { ...user, is_active: false }, storage);
  assert.equal(readCachedUser(jwt(), storage), null);
});

test('过期边界与损坏 JWT 不恢复离线身份', () => {
  const storage = memoryStorage();
  const expired = jwt(user.id, Math.floor(Date.now() / 1000) - 1);
  writeStoredSession(expired, user, storage);
  assert.equal(readCachedUser(expired, storage), null);
  assert.equal(isSessionExpired(jwt(user.id, 100), 100000), true);
  assert.equal(isSessionExpired(jwt(user.id, 101), 100000), false);
  assert.equal(sessionExpiresAt(jwt(user.id, 101)), 101000);
  for (const token of ['garbage', 'a.b.c', 'a.e30.c']) assert.equal(isSessionExpired(token), true);
});

test('退出只清理本地凭据和账号缓存，保留其他偏好', () => {
  const storage = memoryStorage();
  writeStoredSession(jwt(), user, storage);
  storage.setItem('theme', 'light');
  clearStoredSession(storage);
  assert.equal(readStoredToken(storage), null);
  assert.equal(storage.getItem(USER_STORAGE_KEY), null);
  assert.equal(storage.getItem('theme'), 'light');
});

test('storage 不可用不会让登录/退出抛异常', () => {
  const unavailable = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => writeStoredSession(jwt(), user, unavailable));
  assert.equal(readStoredToken(unavailable), null);
  assert.equal(readCachedUser(jwt(), unavailable), null);
  assert.doesNotThrow(() => clearStoredSession(unavailable));
});

test('退出后旧恢复/登录响应不能写回，切账号后旧任务也失效', async () => {
  const epochs = createSessionEpoch();
  const storage = memoryStorage();
  const beforeLogout = epochs.current();
  let resolveOld!: (token: string) => void;
  const oldResponse = new Promise<string>((resolve) => { resolveOld = resolve; });
  const restore = oldResponse.then((token) => {
    if (epochs.isCurrent(beforeLogout)) writeStoredSession(token, user, storage);
  });
  epochs.begin();
  clearStoredSession(storage);
  resolveOld(jwt());
  await restore;
  assert.equal(readStoredToken(storage), null);
  const firstLogin = epochs.begin();
  const latestLogin = epochs.begin();
  assert.equal(epochs.isCurrent(firstLogin), false);
  assert.equal(epochs.isCurrent(latestLogin), true);
});

test('仅当前 token 的 401 失效；网络异常、403/500 和旧账号 401 不误退出', () => {
  assert.equal(isCurrentSessionRejected(401, 'current', 'current'), true);
  for (const status of [0, 200, 403, 500, 503]) {
    assert.equal(isCurrentSessionRejected(status, 'current', 'current'), false);
  }
  assert.equal(isCurrentSessionRejected(401, 'old', 'new'), false);
  assert.equal(isCurrentSessionRejected(401, null, null), false);
});

test('实际请求遇断网或服务异常保留缓存，当前 401 清理并通知，旧 401 不干扰新登录', async (t) => {
  const storage = memoryStorage();
  const events: Event[] = [];
  const token = jwt();
  const headers = { Authorization: `Bearer ${token}` };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    localStorage: storage,
    dispatchEvent: (event: Event) => { events.push(event); return true; },
  } });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  writeStoredSession(token, user);

  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('offline'); });
  await assert.rejects(sessionFetch('https://example.test/api', { headers }), /offline/);
  assert.equal(readStoredToken(), token);
  assert.equal(readCachedUser(token)?.id, user.id);
  for (const status of [403, 500, 503]) {
    fetchMock.mock.mockImplementation(async () => new Response(null, { status }));
    await sessionFetch('https://example.test/api', { headers });
    assert.equal(readStoredToken(), token);
  }
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 401 }));
  await sessionFetch('https://example.test/api', { headers });
  assert.equal(readStoredToken(), null);
  assert.equal(storage.getItem(USER_STORAGE_KEY), null);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, SESSION_REJECTED_EVENT);

  const newToken = jwt('user-b');
  writeStoredSession(newToken, { ...user, id: 'user-b' });
  await sessionFetch('https://example.test/api', { headers });
  assert.equal(readStoredToken(), newToken);
  assert.equal(events.length, 1);
});

test('Provider 使用会话代次守护恢复/登录/注册，监听联网和到期，并保留现有退出接口', () => {
  const source = readFileSync(new URL('./hooks/AuthContext.tsx', import.meta.url), 'utf8');
  assert.match(source, /const isCurrent = \(\) => !cancelled && sessionEpoch\.current\.isCurrent\(epoch\)/);
  assert.equal((source.match(/if \(!sessionEpoch\.current\.isCurrent\(epoch\)\) return null;/g) || []).length, 3);
  assert.match(source, /window\.addEventListener\('online', refresh\)/);
  assert.match(source, /sessionExpiresAt\(token\) - Date\.now\(\)/);
  assert.match(source, /clearPendingDesktopLoginApproval\(\)/);
  assert.match(source, /const logout = useCallback\(\(\) => \{\s*clearSession\(\)/);
  assert.match(source, /const cached = cachedCandidate && !shouldDiscardDevelopmentSession\(cachedCandidate,[\s\S]*?\? cachedCandidate : null;/);
  assert.match(source, /if \(change === 'reload'\) \{[\s\S]*?sessionEpoch\.current\.begin\(\);[\s\S]*?setUser\(null\);[\s\S]*?window\.location\.reload\(\);/);
});

test('跨标签切换账号触发重新恢复，退出清理，同一 token 不重复刷新', () => {
  assert.equal(storedSessionChange('account-a', 'account-b'), 'reload');
  assert.equal(storedSessionChange(null, 'account-b'), 'reload');
  assert.equal(storedSessionChange('account-a', null), 'clear');
  assert.equal(storedSessionChange('account-a', 'account-a'), 'none');
  assert.equal(storedSessionChange(null, null), 'none');
});

test('资料更新仅限仍登录的同一 token 和账号，退出/切号后的旧头像响应无权恢复会话', () => {
  assert.equal(canUpdateCurrentUser('token-a', 'token-a', 'user-a', 'user-a'), true);
  assert.equal(canUpdateCurrentUser('token-a', null, undefined, 'user-a'), false);
  assert.equal(canUpdateCurrentUser('token-a', 'token-b', 'user-b', 'user-a'), false);
  assert.equal(canUpdateCurrentUser('token-a', 'token-a', 'user-a', 'user-b'), false);
  assert.equal(canUpdateCurrentUser('token-a', 'token-a', undefined, 'user-a'), false);
  assert.equal(canUpdateCurrentUser('', '', 'user-a', 'user-a'), false);
  const avatar = readFileSync(new URL('../components/AvatarPicker.tsx', import.meta.url), 'utf8');
  assert.match(avatar, /if \(!updateCurrentUser\(token, result\.data\)\) return;/);
  assert.doesNotMatch(avatar, /acceptSession|applySession/);
  const context = readFileSync(new URL('./hooks/AuthContext.tsx', import.meta.url), 'utf8');
  const updater = context.match(/const updateCurrentUser = useCallback\(([\s\S]*?)\}, \[user\?\.id\]\);/)?.[1] || '';
  assert.match(updater, /canUpdateCurrentUser\(expectedToken, currentToken\.current, user\?\.id, updatedUser\.id\)/);
  assert.doesNotMatch(updater, /applySession|setToken|writeStoredSession|currentToken\.current\s*=/);
});
