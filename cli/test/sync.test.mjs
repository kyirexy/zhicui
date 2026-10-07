import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synchronize } from '../dist/sync.js';
import { CliError } from '../dist/errors.js';

process.env.ZHICUI_CONFIG_HOME = await mkdtemp(join(tmpdir(), 'zhicui-sync-tests-'));
const options = { platform: 'douyin', mode: 'like', limit: 200, timeoutMs: 10000 };
let instance = 0;
function fixture() {
  const state = { captures: 0, batches: [], keys: [], calls: [], lost: false, switched: false };
  const actions = ['library.recap.get', 'library.activity.record', 'library.sync.progress', 'local.platform.status', 'local.platform.sync'].map(id => ({ id }));
  const cache = new Map();
  const client = {
    options: { baseUrl: 'https://luxai.cn', credentials: { profile: `fixture-${++instance}` } },
    capabilities: async () => ({ user_hash: state.switched ? 'other-user' : 'test-user', actions }),
    invoke: async (id, input, key) => {
      state.calls.push(id);
      if (id === 'library.sync.progress') return { status: 'succeeded', data: input };
      assert.equal(id, 'library.activity.record');
      state.keys.push(key);
      if (!cache.has(key)) {
        state.batches.push(input);
        cache.set(key, { status: 'succeeded', data: { result: { accepted: input.items.length, created: input.items.length, reused: 0, sync_run_id: `saved-${state.batches.length}` } } });
      }
      if (state.lost) { state.lost = false; throw new CliError('TIMEOUT', '模拟保存成功但回包丢失'); }
      return cache.get(key);
    },
  };
  const local = {
    ensureConnected: async () => ({ available: true, max_sync_items: 500 }),
    invoke: async (action) => {
      assert.equal(action.id, 'local.platform.sync');
      state.captures++;
      const items = Array.from({ length: 200 }, (_, i) => ({ videoId: String(7690000000000000000n + BigInt(i)), title: `视频 ${i}`, engagement: { likes: i } }));
      items.splice(20, 0, { ...items[2], title: '重复数据不覆盖原顺序' });
      return { status: 'succeeded', data: { run_id: 'local-original', status: 'succeeded', result: {
        success: true, coverage: 'limited', orderReliable: true, items,
      } } };
    },
  };
  return { state, client, local, run: (overrides = {}) => synchronize(client, { ...options, ...overrides }, () => {}, local) };
}

test('200 条按顺序去重并分为两个 100 条批次，互动数据不丢失', async () => {
  const f = fixture(), data = await f.run();
  assert.equal(data.read, 200); assert.equal(data.saved, 200); assert.equal(data.completed, true);
  assert.equal(f.state.captures, 1);
  assert.deepEqual(f.state.batches.map(b => [b.items.length, b.source_rank_offset]), [[100, 0], [100, 100]]);
  assert.equal(new Set(f.state.batches.flatMap(b => b.items.map(i => i.video_id))).size, 200);
  assert.equal(f.state.batches[0].items[2].title, '视频 2');
  assert.deepEqual(f.state.batches[0].items[2].engagement, { likes: 2 });
  assert.equal(f.state.calls.at(-1), 'library.sync.progress');
});

test('保存回包丢失后接续同一任务/批次，不重新采集、不重复新增', async () => {
  const f = fixture(); f.state.lost = true;
  let task;
  await assert.rejects(f.run(), error => { task = error.details.run_id; return error.code === 'TIMEOUT'; });
  const data = await f.run({ resume: task });
  assert.equal(data.run_id, task); assert.equal(data.saved, 200);
  assert.equal(f.state.captures, 1); assert.equal(f.state.batches.length, 2);
  assert.equal(f.state.keys[0], f.state.keys[1]);
});

test('相同请求自动接续；并发调用等待同一任务，不重复采集', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.run(), f.run()]);
  assert.equal(a.run_id, b.run_id); assert.equal(f.state.captures, 1);
});

test('中途切换账号禁止保存旧身份清单', async () => {
  const f = fixture(), invoke = f.local.invoke;
  f.local.invoke = async (...args) => { const result = await invoke(...args); f.state.switched = true; return result; };
  await assert.rejects(f.run(), { code: 'LOCAL_USER_MISMATCH' });
  assert.equal(f.state.batches.length, 0);
});

test('旧桌面客户端不能静默把 200 截为 100', async () => {
  const f = fixture(); f.local.ensureConnected = async () => ({ available: true, max_sync_items: 100 });
  await assert.rejects(f.run(), { code: 'DESKTOP_UPDATE_REQUIRED' });
  assert.equal(f.state.captures, 0);
});

test('读取期间权限撤销会取消对应本机任务，保留检查点且不保存资料', async () => {
  const f = fixture();
  const capabilities = f.client.capabilities;
  let revoked = false, canceled;
  f.client.capabilities = async () => {
    if (revoked) throw new CliError('CREDENTIAL_REVOKED', '已撤销');
    const value = await capabilities();
    return { ...value, actions: [...value.actions, { id: 'local.platform.cancel' }] };
  };
  f.local.invoke = async (action, input) => {
    if (action.id === 'local.platform.cancel') { canceled = input.run_id; return {}; }
    revoked = true;
    return { data: { run_id: 'owned-capture', status: 'running', stage: 'collecting' } };
  };
  await assert.rejects(f.run(), { code: 'CREDENTIAL_REVOKED' });
  assert.equal(canceled, 'owned-capture');
  assert.equal(f.state.batches.length, 0);
});

test('范围不足时如实返回 partial；无结果且未确认结束不能宣称成功', async () => {
  const f = fixture(), invoke = f.local.invoke;
  f.local.invoke = async (...args) => {
    const value = await invoke(...args); value.data.result.coverage = 'partial';
    value.data.result.items = value.data.result.items.slice(0, 12); return value;
  };
  const data = await f.run(); assert.equal(data.completed, false); assert.equal(data.saved, 12);
  const g = fixture();
  g.local.invoke = async () => ({ data: { run_id: 'empty', status: 'succeeded', result: { success: true, items: [], coverage: 'partial' } } });
  await assert.rejects(g.run(), { code: 'EMPTY_SYNC_UNCONFIRMED' });
});
