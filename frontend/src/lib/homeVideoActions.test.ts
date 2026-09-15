import assert from 'node:assert/strict';
import test from 'node:test';
import { createHomeVideoActionsController, homeVideoKey } from './homeVideoActions.ts';
import type { HomeVideoPreference, HomeKnowledgeResult } from './homeVideoActionsApi';
const video = { platform: 'douyin' as const, video_id: '700000000000001', title: '视频 A' };
const pref = (hidden = false): HomeVideoPreference => ({ ...video, hidden, knowledge_entry_id: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function setup(options: Partial<Parameters<typeof createHomeVideoActionsController>[0]> = {}) {
  let current = true; let saves = 0; let hides = 0;
  const controller = createHomeVideoActionsController({ current: () => current, list: async () => [],
    hide: async (identity, hidden) => { hides++; return { ...identity, hidden, knowledge_entry_id: null }; },
    save: async (identity) => { saves++; return { entry: { id: 'knowledge-a' }, created: true, preference: { ...identity, hidden: false, knowledge_entry_id: 'knowledge-a' } } as HomeKnowledgeResult; }, ...options });
  return { controller, switchAccount: () => { current = false; }, counts: () => ({ saves, hides }) };
}
test('偏好确认前不展示，读取失败不冒充空偏好', async () => {
  const read = deferred<HomeVideoPreference[]>(); const fixture = setup({ list: () => read.promise });
  const load = fixture.controller.load(); assert.equal(fixture.controller.getSnapshot().ready, false);
  read.reject(new Error('HTTP 502 internal path')); await load;
  const snapshot = fixture.controller.getSnapshot(); assert.equal(snapshot.ready, false); assert.equal(snapshot.loading, false);
  assert.doesNotMatch(snapshot.error, /502|internal/);
});
test('隐藏仅在服务端成功后改变两处共用的可见状态', async () => {
  const write = deferred<HomeVideoPreference>(); const fixture = setup({ hide: () => write.promise });
  await fixture.controller.load(); const operation = fixture.controller.run(video, 'hide');
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, undefined);
  write.resolve(pref(true)); await operation;
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, true);
  assert.deepEqual(fixture.controller.getSnapshot().notice?.undo, video);
});
test('隐藏失败保留视频，撤销失败保留撤销重试出口', async () => {
  const fixture = setup({ list: async () => [pref(true)], hide: async () => { throw new Error('offline'); } });
  await fixture.controller.load(); await fixture.controller.run(video, 'restore');
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, true);
  assert.deepEqual(fixture.controller.getSnapshot().notice?.undo, video);
  const visible = setup({ hide: async () => { throw new Error('offline'); } });
  await visible.controller.load(); await visible.controller.run(video, 'hide');
  assert.equal(visible.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, undefined);
});
test('同一视频并发保存去重，复用后端的已有知识条目', async () => {
  const save = deferred<HomeKnowledgeResult>(); let calls = 0;
  const fixture = setup({ save: async () => { calls++; return save.promise; } });
  await fixture.controller.load(); const one = fixture.controller.run(video, 'save'); const two = fixture.controller.run(video, 'save');
  assert.equal(one, two); assert.equal(calls, 1);
  save.resolve({ created: false, entry: { id: 'knowledge-existing' }, preference: { ...pref(), knowledge_entry_id: 'knowledge-existing' } } as HomeKnowledgeResult); await one;
  assert.equal(fixture.controller.getSnapshot().notice?.knowledgeId, 'knowledge-existing');
  assert.match(fixture.controller.getSnapshot().notice!.message, /已在/);
});
test('账号切换阻止旧响应回填，也不能发送旧卡片操作', async () => {
  const read = deferred<HomeVideoPreference[]>(); const fixture = setup({ list: () => read.promise });
  const load = fixture.controller.load(); fixture.switchAccount(); read.resolve([pref(true)]); await load;
  assert.equal(fixture.controller.getSnapshot().ready, false);
  await fixture.controller.run(video, 'save'); assert.deepEqual(fixture.counts(), { hides: 0, saves: 0 });
  const write = deferred<HomeVideoPreference>(); const second = setup({ hide: () => write.promise });
  await second.controller.load(); const mutation = second.controller.run(video, 'hide'); second.switchAccount(); write.resolve(pref(true)); await mutation;
  assert.equal(second.controller.getSnapshot().preferences.size, 0);
});
test('晚到的 GET 不覆盖刚确认的隐藏结果', async () => {
  let calls = 0; const stale = deferred<HomeVideoPreference[]>();
  const fixture = setup({ list: async () => ++calls === 1 ? [] : stale.promise });
  await fixture.controller.load(); const refresh = fixture.controller.load(); await fixture.controller.run(video, 'hide');
  stale.resolve([pref(false)]); await refresh;
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, true);
});
test('平台身份独立，撤销不删除其他偏好或历史视频', async () => {
  const bili = { platform: 'bilibili' as const, video_id: video.video_id, title: 'B站视频' };
  const fixture = setup({ list: async () => [{ ...bili, hidden: false, knowledge_entry_id: null }] });
  await fixture.controller.load(); await fixture.controller.run(video, 'hide');
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(bili))?.hidden, false);
  await fixture.controller.run(video, 'restore');
  assert.equal(fixture.controller.getSnapshot().preferences.get(homeVideoKey(video))?.hidden, false);
  assert.equal(fixture.controller.getSnapshot().preferences.size, 2);
});
test('StrictMode 清理后可再激活，旧已取消请求不回填', async () => {
  const first = deferred<HomeVideoPreference[]>(); let calls = 0;
  const fixture = setup({ list: async () => ++calls === 1 ? first.promise : [] });
  const old = fixture.controller.load(); fixture.controller.dispose(); fixture.controller.activate(); await fixture.controller.load();
  first.resolve([pref(true)]); await old;
  assert.equal(fixture.controller.getSnapshot().ready, true); assert.equal(fixture.controller.getSnapshot().preferences.size, 0);
});
