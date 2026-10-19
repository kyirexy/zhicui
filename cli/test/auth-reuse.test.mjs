import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { DAILY_AGENT_SCOPES } from '../dist/connection-policy.js';
import {
  action, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory,
} from './helpers.mjs';

const fakePat = 'zhc_pat_auth_reuse_test_only_secret';
const fakeDevice = 'zhc_access_auth_reuse_test_only_secret';
const fakeRefresh = 'zhc_refresh_auth_reuse_test_only_secret';
const fakeMachineCode = 'machine_auth_reuse_test_only_secret';
const privateValues = [fakePat, fakeDevice, fakeRefresh, fakeMachineCode];
const loginFlags = ['--jsonl', '--no-open', '--non-interactive'];

async function authFixture(t, options = {}) {
  const directory = await temporaryDirectory('zhicui-auth-reuse-');
  const state = {
    starts: [], polls: 0, publicChecks: 0, authenticatedChecks: 0,
    granted: options.granted ?? [...DAILY_AGENT_SCOPES],
    catalog: options.catalog ?? [...DAILY_AGENT_SCOPES, 'plan:write', 'creator:sync'],
    actions: options.actions ?? [action('library.list')],
    expiresIn: options.expiresIn ?? 600,
    authenticatedFailure: options.authenticatedFailure ?? false,
    startedAt: 0,
  };
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) {
      const authenticated = Boolean(request.headers.authorization);
      if (authenticated) {
        state.authenticatedChecks++;
        assert.equal(request.headers.authorization, `Bearer ${fakePat}`);
        if (state.authenticatedFailure) return request.socket.destroy();
      } else state.publicChecks++;
      return json(response, 200, envelope({
        release_profile: 'core', feature_enabled: true,
        scopes: state.catalog.map(id => ({ id })),
        actions: authenticated ? state.actions : [],
        ...(!options.legacy ? { granted_scopes: authenticated ? state.granted : null } : {}),
      }));
    }
    if (request.url.endsWith('/auth/device')) {
      assert.equal(request.headers.authorization, undefined);
      state.starts.push(await readJsonBody(request));
      state.startedAt = Date.now();
      return json(response, 200, envelope({
        device_code: fakeMachineCode, user_code: 'ABCD-EF23',
        verification_uri_complete: `${server.url}/verify?user_code=ABCD-EF23`,
        expires_in: state.expiresIn, interval: 1,
      }));
    }
    if (request.url.endsWith('/auth/device/token')) {
      state.polls++;
      assert.equal((await readJsonBody(request)).device_code, fakeMachineCode);
      return json(response, 200, envelope({
        access_token: fakeDevice, refresh_token: fakeRefresh,
        expires_in: 900, scopes: state.starts.at(-1).scopes,
      }));
    }
    return json(response, 404, { error: { code: 'NOT_FOUND', message: '未预期的测试请求' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  if (options.existing) {
    await writeFile(env.ZHICUI_CREDENTIALS_FILE, JSON.stringify({
      kind: 'pat', access_token: fakePat, created_at: '2026-01-01T00:00:00.000Z',
      server_origin: server.url, scopes: options.storedScopes ?? [],
    }));
  }
  return { state, env };
}

function assertNoSecrets(result) {
  for (const value of privateValues) assert.ok(!(result.stdout + result.stderr).includes(value));
}

function events(result) {
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assertNoSecrets(result);
  return result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
}

for (const [label, catalog, expected] of [
  ['完整日常范围', [...DAILY_AGENT_SCOPES, 'plan:write', 'creator:sync'], [...DAILY_AGENT_SCOPES]],
  ['收窄的发布目录', ['library:read', 'library:write', 'ask:read', 'plan:write'],
    ['library:read', 'library:write', 'ask:read']],
]) {
  test(`auth login 默认按${label}申请，不附带额外目录权限`, async (t) => {
    const { state, env } = await authFixture(t, { catalog });
    const output = events(await runCli(['auth', 'login', ...loginFlags, '--timeout', '5s'], { env }));
    assert.equal(state.starts.length, 1);
    assert.deepEqual(state.starts[0].scopes, expected);
    assert.deepEqual(output[0].scopes, expected);
    assert.equal(output.at(-1).event, 'authorization_complete');
  });
}

test('有效且足够的实际授权直接复用，即使本地历史 scopes 为空', async (t) => {
  const { state, env } = await authFixture(t, { existing: true });
  const output = events(await runCli(['auth', 'login', ...loginFlags], { env }));
  assert.equal(state.starts.length, 0);
  assert.equal(state.polls, 0);
  assert.ok(state.authenticatedChecks > 0);
  assert.equal(output.length, 1);
  assert.equal(output[0].reused, true);
  assert.equal(output[0].valid, true);
  assert.equal(output[0].scopes_complete, true);
  assert.equal(output[0].scopes_source, 'server');
  assert.deepEqual(output[0].scopes, [...DAILY_AGENT_SCOPES].sort());
  assert.equal(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')).access_token, fakePat);
});

test('旧服务的已授权动作足以证明所需权限时可复用，但仍标注不完整', async (t) => {
  const { state, env } = await authFixture(t, {
    existing: true, legacy: true,
    actions: DAILY_AGENT_SCOPES.map((scope, index) => action(`authorized.${index}`, { scopes: [scope] })),
  });
  const output = events(await runCli(['auth', 'login', ...loginFlags], { env }));
  assert.equal(state.starts.length, 0);
  assert.equal(output[0].reused, true);
  assert.equal(output[0].scopes_complete, false);
  assert.equal(output[0].scopes_source, 'authorized_actions');
});

test('目录列出日常权限不代表只读凭证已获授权，缺失时启动明确的授权申请', async (t) => {
  const { state, env } = await authFixture(t, { existing: true, granted: ['library:read'] });
  const output = events(await runCli(['auth', 'login', ...loginFlags, '--timeout', '5s'], { env }));
  assert.equal(state.starts.length, 1);
  assert.deepEqual(state.starts[0].scopes, [...DAILY_AGENT_SCOPES]);
  assert.equal(output[0].event, 'device_authorization');
  assert.notEqual(output.at(-1).reused, true);
});

test('--force 允许已有足够授权的用户重新授权', async (t) => {
  const { state, env } = await authFixture(t, { existing: true });
  const output = events(await runCli(['auth', 'login', '--force', ...loginFlags, '--timeout', '5s'], { env }));
  assert.equal(state.starts.length, 1);
  assert.equal(state.polls, 1);
  assert.equal(output[0].event, 'device_authorization');
  assert.equal(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')).access_token, fakeDevice);
});

for (const existing of [false, true]) {
  test(`明确只读申请保持只读（${existing ? '复用原连接' : '首次授权'}）`, async (t) => {
    const { state, env } = await authFixture(t, { existing, granted: ['library:read'] });
    const output = events(await runCli([
      'auth', 'login', '--scopes', 'library:read', ...loginFlags, '--timeout', '5s',
    ], { env }));
    assert.equal(state.starts.length, existing ? 0 : 1);
    assert.deepEqual(output.at(-1).scopes, ['library:read']);
    if (existing) assert.equal(output[0].reused, true);
    else assert.deepEqual(state.starts[0].scopes, ['library:read']);
  });
}

test('验证现有连接遇到网络错误时不发起新授权，也不替换原凭证', async (t) => {
  const { state, env } = await authFixture(t, { existing: true, authenticatedFailure: true });
  const original = await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8');
  const result = await runCli([
    'auth', 'login', '--scopes', 'library:read', '--json', '--no-open', '--non-interactive',
  ], { env });
  assert.notEqual(result.code, 0);
  assert.ok(['REMOTE_FAILURE', 'NETWORK_ERROR'].includes(JSON.parse(result.stdout).error.code));
  assert.equal(state.starts.length, 0);
  assert.equal(state.polls, 0);
  assert.equal(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'), original);
  assertNoSecrets(result);
});

test('PAT 保存服务实际 grants，status --verify 使用最新 grants 且不输出令牌', async (t) => {
  const { state, env } = await authFixture(t, { granted: ['library:read'] });
  const login = await runCli(['auth', 'pat', '--non-interactive', '--json'], { env, input: fakePat });
  assert.equal(login.code, 0, login.stdout + login.stderr);
  const loginResult = JSON.parse(login.stdout);
  assert.deepEqual(loginResult.scopes, ['library:read']);
  assert.equal(loginResult.scopes_source, 'server');
  assert.equal(loginResult.scopes_complete, true);
  assertNoSecrets(login);
  const saved = JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'));
  assert.equal(saved.access_token, fakePat);
  assert.deepEqual(saved.scopes, ['library:read']);
  assert.equal(saved.scopes_source, 'server');
  assert.equal(saved.scopes_complete, true);

  state.granted = [];
  const verified = await runCli(['auth', 'status', '--verify', '--json'], { env });
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const status = JSON.parse(verified.stdout);
  assert.equal(status.authenticated, true);
  assert.equal(status.valid, true);
  assert.deepEqual(status.scopes, []);
  assert.equal(status.scopes_source, 'server');
  assert.equal(status.scopes_complete, true);
  assert.equal(state.starts.length, 0);
  assertNoSecrets(verified);
});

for (const [label, timeoutFlags, expectedMs] of [
  ['默认尊重服务有效期', [], 600_000],
  ['明确较短等待时间', ['--timeout', '7s'], 7_000],
  ['明确等待时间不能超过服务有效期', ['--timeout', '12m'], 600_000],
]) {
  test(`授权事件期限：${label}`, async (t) => {
    const { state, env } = await authFixture(t, { expiresIn: 600 });
    const output = events(await runCli(['auth', 'login', ...loginFlags, ...timeoutFlags], { env }));
    const first = output[0];
    assert.equal(first.event, 'device_authorization');
    const lifetimeMs = Date.parse(first.expires_at) - state.startedAt;
    assert.ok(lifetimeMs >= expectedMs - 500 && lifetimeMs <= expectedMs + 1_500,
      `授权事件有效期 ${lifetimeMs}ms，预期约 ${expectedMs}ms`);
    assert.equal(state.polls, 1);
  });
}
