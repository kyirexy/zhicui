import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { DAILY_AGENT_SCOPES } from '../dist/connection-policy.js';
import { action, credentialEnv, envelope, json, runCli, startServer, temporaryDirectory } from './helpers.mjs';

const key = 'zhc_pat_connect_key_test_only_secret';
const previousKey = 'zhc_pat_connect_previous_test_only_secret';

async function fixture(t, { granted = [...DAILY_AGENT_SCOPES], catalog = [...DAILY_AGENT_SCOPES], daily, invalid = false, existing = false } = {}) {
  const directory = await temporaryDirectory('zhicui-connect-key-');
  const requests = [];
  const server = await startServer(async (request, response) => {
    requests.push(request.url);
    assert.ok(!request.url.includes('/auth/device'), '密钥连接不能启动或轮询设备授权');
    if (request.url.endsWith('/capabilities')) {
      const publishedDaily = daily === undefined ? {} : { daily_agent_scopes: daily };
      if (!request.headers.authorization) return json(response, 200, envelope({ release_profile: 'core', scopes: catalog.map(id => ({ id })), ...publishedDaily }));
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      if (invalid) return json(response, 401, { error: { code: 'INVALID_TOKEN', message: '密钥无效' } });
      return json(response, 200, envelope({ actions: [action('library.list')], granted_scopes: granted, ...publishedDaily }));
    }
    return json(response, 200, { success: true });
  });
  t.after(server.close);
  const env = {
    ...credentialEnv(directory, server.url), ZHICUI_PROFILE: 'default',
    ZHICUI_CODEX_COMMAND: process.execPath,
    ZHICUI_CODEX_COMMAND_ARGS: JSON.stringify([resolve('test/fake-agent-client.mjs'), 'codex']),
    ZHICUI_CODEX_CONFIG: resolve(directory, 'codex/config.toml'),
    ZHICUI_CODEX_SKILLS_DIR: resolve(directory, 'codex-skills'),
    FAKE_CODEX_STATE: resolve(directory, 'codex-state.json'),
  };
  const previous = JSON.stringify({ kind: 'pat', access_token: previousKey, created_at: '2026-01-01T00:00:00.000Z', server_origin: server.url });
  if (existing) await writeFile(env.ZHICUI_CREDENTIALS_FILE, previous);
  return { env, requests, previous };
}

function assertPrivate(result) {
  for (const value of [key, previousKey]) assert.ok(!(result.stdout + result.stderr).includes(value));
}

function finalEvent(result) {
  assertPrivate(result);
  const events = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.filter(event => event.terminal).length, 1, 'JSONL 只有一个终态');
  assert.ok(events.every(event => event.event !== 'device_authorization'));
  return events.at(-1);
}

for (const [name, scopes, daily, catalog] of [
  ['旧服务日常范围', [...DAILY_AGENT_SCOPES], undefined, [...DAILY_AGENT_SCOPES]],
  ['旧服务目录子集', ['library:read', 'library:write'], undefined, ['library:read', 'library:write']],
  ['新服务仅开放账号读取', ['account:read'], ['account:read'], [...DAILY_AGENT_SCOPES]],
]) {
  test(`密钥${name}一次接入；新 CLI 进程复用，不发设备码`, async t => {
    const { env, requests } = await fixture(t, { granted: scopes, catalog, daily });
    const connected = await runCli(['connect', '--pat-stdin', '--client', 'codex', '--non-interactive', '--jsonl'], { env, input: key, processTimeoutMs: 25000 });
    assert.equal(connected.code, 0, connected.stdout + connected.stderr);
    const completed = finalEvent(connected);
    assert.equal(completed.event, 'connect.completed');
    assert.equal(completed.data.ready, true);
    assert.equal(completed.data.mcp_healthy, true);
    assert.deepEqual(completed.data.credential.scopes, [...scopes].sort());
    const saved = JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'));
    assert.equal(saved.access_token, key);
    assert.equal(saved.kind, 'pat');
    assert.ok(!(await readFile(env.FAKE_CODEX_STATE, 'utf8')).includes(key));
    const again = await runCli(['connect', '--client', 'codex', '--json'], { env, processTimeoutMs: 25000 });
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assertPrivate(again);
    assert.equal(JSON.parse(again.stdout).setup.codex.changed, false);
    assert.equal(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')).created_at, saved.created_at);
    assert.ok(!requests.some(url => url.includes('/auth/device')));
  });
}

for (const daily of [[], null, ['admin:write']]) {
  test(`明确日常范围 ${JSON.stringify(daily)} 不回退到 profile 目录或设备授权`, async t => {
    const { env, previous, requests } = await fixture(t, { existing: true, daily });
    for (const extra of [[], ['--pat-stdin']]) {
      const result = await runCli(['connect', ...extra, '--non-interactive', '--jsonl'], { env, input: key });
      const failed = finalEvent(result);
      assert.equal(failed.error.code, Array.isArray(daily) && daily.length === 0 ? 'ACTION_NOT_AVAILABLE' : 'REMOTE_FAILURE');
      assert.equal(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'), previous);
      await assert.rejects(access(env.FAKE_CODEX_STATE), { code: 'ENOENT' });
    }
    assert.ok(!requests.some(url => url.includes('/auth/device')));
  });
}

test('公开 daily_agent_scopes 不能作为密钥实际权限，仍检查 granted_scopes', async t => {
  const { env, previous } = await fixture(t, { existing: true, daily: [...DAILY_AGENT_SCOPES], granted: ['library:read'] });
  const result = await runCli(['connect', '--pat-stdin', '--non-interactive', '--jsonl'], { env, input: key });
  assert.equal(finalEvent(result).error.code, 'SCOPE_DENIED');
  assert.equal(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'), previous);
});

for (const mode of ['invalid', 'read-only']) {
  test(`${mode} 密钥保留旧凭据，不配置 MCP、不进入设备授权`, async t => {
    const { env, previous, requests } = await fixture(t, {
      existing: true, invalid: mode === 'invalid', granted: mode === 'read-only' ? ['library:read'] : [...DAILY_AGENT_SCOPES],
    });
    const result = await runCli(['connect', '--pat-stdin', '--non-interactive', '--jsonl'], { env, input: key });
    assert.notEqual(result.code, 0);
    const failed = finalEvent(result);
    assert.equal(failed.error.code, mode === 'invalid' ? 'INVALID_TOKEN' : 'SCOPE_DENIED');
    if (mode === 'read-only') assert.deepEqual(failed.error.details.missing_scopes, DAILY_AGENT_SCOPES.filter(scope => scope !== 'library:read'));
    assert.deepEqual(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')), JSON.parse(previous));
    await assert.rejects(access(env.FAKE_CODEX_STATE), { code: 'ENOENT' });
    assert.ok(!requests.some(url => url.includes('/auth/device')));
  });
}

test('stdin 多行被拒绝，原连接不变', async t => {
  const { env, previous } = await fixture(t, { existing: true });
  const result = await runCli(['connect', '--pat-stdin', '--non-interactive', '--jsonl'], { env, input: `${key}\nextra` });
  assert.equal(finalEvent(result).error.code, 'USAGE_ERROR');
  assert.equal(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'), previous);
});

test('密钥不能放入 argv，错误输出也不回显；密钥接入不接受 scopes', async () => {
  for (const args of [
    ['connect', key], ['connect', `--pat-stdin=${key}`], ['connect', `--key=${key}`],
    ['connect', '--pat-stdin', '--scopes', 'admin:write'],
  ]) {
    const result = await runCli([...args, '--json']);
    assert.equal(result.code, 2, result.stdout + result.stderr);
    assertPrivate(result);
    assert.equal(JSON.parse(result.stdout).error.code, 'USAGE_ERROR');
  }
});
