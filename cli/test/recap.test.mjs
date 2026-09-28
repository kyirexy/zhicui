import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { refreshRecap, collectedItems, checkRecapCapabilities } from '../dist/recap.js';
import { CliError } from '../dist/errors.js';
import { action, envelope, credentialEnv, json, runCli, startServer, temporaryDirectory } from './helpers.mjs';

const actions = ['library.activity.record', 'library.recap.get', 'local.platform.status', 'local.platform.sync'].map(id => action(id));
const defaults = { day: 'yesterday', platform: 'douyin', mode: 'like', timezone: 'Asia/Shanghai', limit: 50, timeoutMs: 5000 };
function fixture() {
  const calls = [], progress = [];
  let hash = 'a'.repeat(64), number = 0;
  const client = {
    capabilities: async () => ({ actions, user_hash: hash, feature_enabled: true }),
    invoke: async (id, input) => {
      calls.push({ id, input });
      return envelope({ result: id === 'library.recap.get' ? { total: 0, items: [], time_basis: 'first_discovered' } : { accepted: input.items.length, created: 0, reused: input.items.length } });
    },
    getRun: async () => assert.fail('本机 Run 不得交给云端查询'),
  };
  const local = {
    status: async () => ({ available: true }),
    invoke: async (action, input) => {
      calls.push({ id: action.id, input });
      return envelope({ run_id: `local-${++number}`, status: 'succeeded', result: { success: true,
        items: [{ videoId: '7659724478275947822', title: '作品', ephemeralMediaUrl: 'secret-url', cookie: 'secret' }] } });
    },
  };
  return { client, local, calls, progress, switchAccount: () => { hash = 'b'.repeat(64); },
    run: (options = {}) => refreshRecap(client, { ...defaults, ...options }, (stage, data) => progress.push({ stage, data }), local) };
}

test('every recap synchronizes before reading and sends only safe public metadata', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const data = await f.run();
    assert.equal(data.sync.completed, true);
    assert.equal(data.time_basis, 'first_discovered');
  }
  assert.deepEqual(f.calls.map(c => c.id), [
    'local.platform.sync', 'library.activity.record', 'library.recap.get',
    'local.platform.sync', 'library.activity.record', 'library.recap.get',
  ]);
  const saved = f.calls[1].input;
  assert.deepEqual(saved, { platform: 'douyin', mode: 'like', items: [{ video_id: '7659724478275947822', title: '作品', author_name: '', caption: '' }] });
  assert.doesNotMatch(JSON.stringify(saved), /secret|source_synced_at|user_id/);
});

test('account switch after collection prevents saving and reading', async () => {
  const f = fixture(), invoke = f.local.invoke;
  f.local.invoke = async (...args) => { const result = await invoke(...args); f.switchAccount(); return result; };
  await assert.rejects(f.run(), { code: 'LOCAL_USER_MISMATCH' });
  assert.deepEqual(f.calls.map(c => c.id), ['local.platform.sync']);
});

test('waiting for verification stops without importing or retrying', async () => {
  const f = fixture();
  let starts = 0;
  f.local.invoke = async () => { starts++; return envelope({ run_id: 'local-wait', status: 'waiting_for_user', message: '请验证' }); };
  await assert.rejects(f.run(), error => error.code === 'WAITING_FOR_USER' && error.details.run_id === 'local-wait');
  assert.equal(starts, 1);
  assert.equal(f.calls.length, 0);
});

test('failed sync never returns cached recap and does not retry the other mode', async () => {
  const f = fixture();
  let starts = 0;
  f.local.invoke = async () => { starts++; throw new CliError('PLATFORM_AUTH_REQUIRED', '请登录'); };
  await assert.rejects(f.run({ mode: 'all' }), { code: 'SYNC_FAILED' });
  assert.equal(starts, 1);
  assert.equal(f.calls.length, 0);
});

test('one failed platform reports partial sync instead of universal success', async () => {
  const f = fixture(), invoke = f.local.invoke;
  f.local.invoke = async (action, input) => {
    if (input.platform === 'bilibili') throw new CliError('PLATFORM_AUTH_REQUIRED', 'B站需要登录');
    return invoke(action, input);
  };
  const data = await f.run({ platform: 'all' });
  assert.equal(data.sync.completed, false);
  assert.equal(data.sync.sources.length, 1);
  assert.equal(data.sync.warnings[0].platform, 'bilibili');
});

test('pending local job is polled locally then ingested', async () => {
  const f = fixture(), complete = f.local.invoke;
  f.local.invoke = async (action, input) => {
    if (action.id === 'local.platform.sync') return envelope({ run_id: 'local-1', status: 'running', message: '同步中' });
    assert.equal(action.id, 'local.platform.status');
    return complete(action, input);
  };
  assert.equal((await f.run()).sync.completed, true);
});

test('strict items projection rejects foreign links and oversized batches', () => {
  assert.deepEqual(collectedItems({ urls: ['https://www.bilibili.com/video/BV1234567890/'] }, 'bilibili', 50), [{ video_id: 'BV1234567890' }]);
  for (const url of ['https://evil.test/video/123456', 'https://user:pass@www.douyin.com/video/123456', 'http://www.douyin.com/video/123456']) {
    assert.throws(() => collectedItems({ urls: [url] }, 'douyin', 50), { code: 'INVALID_OUTPUT' });
  }
  assert.throws(() => collectedItems({ items: [{ videoId: '123456' }, { videoId: '123457' }] }, 'douyin', 1), { code: 'INVALID_OUTPUT' });
});

test('missing published permission requires consent and disabled service cannot sync', async () => {
  await assert.rejects(checkRecapCapabilities({ capabilities: async () => ({ actions: [] }), publicCapabilities: async () => ({ actions }) }), { code: 'SCOPE_DENIED' });
  const f = fixture();
  f.client.capabilities = async () => ({ actions, feature_enabled: false });
  await assert.rejects(f.run(), { code: 'INTERFACE_DISABLED' });
  assert.equal(f.calls.length, 0);
});

test('real CLI rejects invalid recap before network and emits one JSONL error', async (t) => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const server = await startServer((_req, res) => { calls++; json(res, 500, {}); });
  t.after(server.close);
  const result = await runCli(['recap', 'yesterday', '--limit', '101', '--connect', '--jsonl'], { env: credentialEnv(directory, server.url) });
  assert.notEqual(result.code, 0);
  assert.equal(calls, 0);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].terminal, true);
});

test('real CLI completes bridge collection, cloud recording and recap with one terminal event', {
  skip: !['win32', 'darwin'].includes(process.platform),
}, async (t) => {
  const directory = await temporaryDirectory(), calls = [];
  const published = actions.map(a => a.id.startsWith('local.') ? { ...a, execution_location: 'local_windows', available: false, scopes: ['local:invoke'] } : a);
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions: published, user_hash: 'a'.repeat(64) }));
    calls.push(request.url);
    if (request.url.endsWith('/v1/actions/local.platform.sync/invoke')) {
      assert.equal(request.headers.authorization, 'Bearer fixture-bridge-only');
      return json(response, 200, envelope({ run_id: 'local-real-process', status: 'succeeded', result: { success: true, items: [{ videoId: '7659724478275947822', title: '真实流程替身' }] } }));
    }
    assert.equal(request.headers.authorization, 'Bearer fixture-cloud-only');
    if (request.url.endsWith('/actions/library.activity.record/invoke')) return json(response, 200, envelope({ result: { accepted: 1, reused: 1 } }));
    if (request.url.endsWith('/actions/library.recap.get/invoke')) return json(response, 200, envelope({ result: { total: 1, items: [{ title: '回顾清单' }] } }));
    assert.fail(request.url);
  });
  t.after(server.close);
  const descriptor = resolve(directory, 'bridge.json');
  await writeFile(descriptor, JSON.stringify({ api_version: 'v1', url: server.url, token: 'fixture-bridge-only', user_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60000).toISOString() }));
  const env = { ...credentialEnv(directory, server.url), ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR: descriptor };
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], { env, input: 'fixture-cloud-only' })).code, 0);
  const result = await runCli(['recap', 'yesterday', '--platform', 'douyin', '--jsonl'], { env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.terminal).length, 1);
  assert.equal(events.at(-1).event, 'recap.completed');
  assert.equal(events.at(-1).data.total, 1);
  assert.deepEqual(events.map(e => e.sequence), events.map((_, index) => index + 1));
  assert.deepEqual(calls.map(p => p.split('/').at(-2)), ['local.platform.sync', 'library.activity.record', 'library.recap.get']);
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-bridge-only|fixture-cloud-only/);
});
