import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebBuildUpdateController, webBuildUpdatePresentation, type WebUpdateBlock } from './webBuildUpdateFlow.ts';
import { beginWebBuildActivity, hasWebBuildActivity, isWebBuildActivitySettling, subscribeWebBuildActivity } from './webBuildActivity.ts';
import { supportsWebBuildRefresh, webBuildAssetUrls } from './webBuildPreload.ts';

const current = { schema_version: 1 as const, build_id: 'current-build-0001', revision: 'abcdef12', version: '1.1.14', built_at: '2026-09-14T12:00:00Z' };
const next = { ...current, build_id: 'next-build-0002', version: '1.1.15' };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let latest = next, clock = 100000, path = '/library', reason: Exclude<WebUpdateBlock, 'paused' | 'already-reloaded'> = '';
  let loadLatest: () => Promise<typeof next> = async () => latest;
  let prepareCalls = 0, latestCalls = 0, reloadCalls = 0, saveAllowed = true;
  let prepare: (signal: AbortSignal, progress: (done: number, total: number) => void) => Promise<void>
    = async (_signal, progress) => { progress(0, 2); progress(1, 2); progress(2, 2); };
  const ledger = new Set<string>(), prepared: { buildId: string; pathname: string }[] = [];
  const controller = createWebBuildUpdateController({
    current, now: () => clock, pathname: () => path,
    latest: async () => { latestCalls++; return loadLatest(); },
    prepare: async (signal, progress, expected) => { prepareCalls++; prepared.push(expected); await prepare(signal, progress); },
    safety: () => reason, wasReloaded: id => ledger.has(id),
    recordReload: id => { if (!saveAllowed) return false; ledger.add(id); return true; },
    reload: () => { reloadCalls++; },
  });
  controller.activate(true);
  return { controller, ledger, prepared, setLatest: (value: typeof next) => { latest = value; },
    setPath: (value: string) => { path = value; }, setLatestLoader: (value: typeof loadLatest) => { loadLatest = value; },
    setReason: (value: typeof reason) => { reason = value; }, setPrepare: (value: typeof prepare) => { prepare = value; },
    noStorage: () => { saveAllowed = false; }, advance: (time: number) => { clock += time; },
    counts: () => ({ prepareCalls, latestCalls, reloadCalls }) };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('共享一次检查和资源准备，全部资源真实完成后才刷新', async () => {
  const f = fixture(), gate = deferred();
  f.setPrepare(async (_signal, progress) => { progress(0, 2); progress(1, 2); await gate.promise; progress(2, 2); });
  const first = f.controller.check(), second = f.controller.check();
  assert.equal(first, second); await flush();
  assert.equal(f.controller.getSnapshot().completed, 1); assert.equal(f.counts().reloadCalls, 0);
  assert.equal(webBuildUpdatePresentation(f.controller.getSnapshot()).description, '已准备 1/2 项资源');
  gate.resolve(); await first;
  assert.equal(f.counts().prepareCalls, 1); assert.equal(f.counts().reloadCalls, 1);
  f.controller.tick(); f.controller.refresh(); await f.controller.check();
  assert.equal(f.counts().reloadCalls, 1);
});

for (const reason of ['task', 'settling', 'input', 'hidden'] as const) {
  test(`${reason} 阻止自动与手动刷新，条件解除后才自动刷新`, async () => {
    const f = fixture(); f.setReason(reason); await f.controller.check();
    assert.equal(f.controller.getSnapshot().phase, 'deferred');
    assert.equal(f.controller.getSnapshot().blocked, reason);
    await f.controller.refresh(); assert.equal(f.counts().reloadCalls, 0);
    f.setReason(''); f.controller.tick(); await flush(); assert.equal(f.counts().reloadCalls, 1);
  });
}

test('刚操作页面时稍候；用户显式点击可跳过空闲等待，不能跳过任务与输入保护', async () => {
  const f = fixture(); f.setReason('interaction'); await f.controller.check();
  assert.equal(f.counts().reloadCalls, 0); await f.controller.refresh(); assert.equal(f.counts().reloadCalls, 1);
});

test('准备期间选择稍后，资源完成后也不会自动刷新', async () => {
  const f = fixture(), gate = deferred(); f.setPrepare(async () => gate.promise);
  const run = f.controller.check(); await flush(); f.controller.pause(); gate.resolve(); await run;
  assert.equal(f.controller.getSnapshot().blocked, 'paused'); assert.equal(f.counts().reloadCalls, 0);
  await f.controller.refresh(); assert.equal(f.counts().reloadCalls, 1);
});

test('同一个 build 不重复自动刷新；重开页面可读持久标记', async () => {
  const f = fixture(); f.ledger.add(next.build_id); await f.controller.check();
  f.controller.tick(); assert.equal(f.counts().reloadCalls, 0);
  assert.equal(f.controller.getSnapshot().blocked, 'already-reloaded');
  await f.controller.refresh(); assert.equal(f.counts().reloadCalls, 1);
});

test('sessionStorage 不可写时禁止自动刷新，显式手动仍可更新', async () => {
  const f = fixture(); f.noStorage(); await f.controller.check();
  assert.equal(f.counts().reloadCalls, 0); await f.controller.refresh(); assert.equal(f.counts().reloadCalls, 1);
});

test('检查到当前 build 时不下载、不刷新', async () => {
  const f = fixture(); f.setLatest(current); await f.controller.check();
  assert.equal(f.controller.getSnapshot().phase, 'idle'); assert.equal(f.counts().prepareCalls, 0);
});

test('准备中发布了另一个版本，绑定新版本重新准备后再更新', async () => {
  const f = fixture(); f.setPrepare(async () => f.setLatest({ ...next, build_id: 'third-build-0003' }));
  await f.controller.check(); assert.equal(f.controller.getSnapshot().phase, 'reloading');
  assert.deepEqual(f.prepared.map(item => item.buildId), [next.build_id, 'third-build-0003']);
  assert.deepEqual([...f.ledger], ['third-build-0003']);
});

test('网络失败仅有限自动重试；不会按轮询无限下载', async () => {
  const f = fixture(); f.setPrepare(async () => { throw new Error('offline'); });
  await f.controller.check(); assert.equal(f.counts().prepareCalls, 1);
  f.controller.tick(); await flush(); assert.equal(f.counts().prepareCalls, 1);
  f.advance(30000); f.controller.tick(); await flush(); assert.equal(f.counts().prepareCalls, 2);
  f.advance(60000); f.controller.tick(); await flush(); await f.controller.check();
  assert.equal(f.counts().prepareCalls, 2); assert.equal(f.counts().reloadCalls, 0);
  f.setPrepare(async (_signal, progress) => progress(2, 2)); await f.controller.retry();
  assert.equal(f.counts().reloadCalls, 1);
});

test('退出或换账号后丢弃旧请求，迟到完成不能自动刷新', async () => {
  const f = fixture(), gate = deferred(); let signal!: AbortSignal;
  f.setPrepare(async (value) => { signal = value; await gate.promise; });
  const run = f.controller.check(); await flush(); f.controller.activate(false);
  assert.equal(signal.aborted, true); f.controller.activate(true); gate.resolve(); await run;
  assert.equal(f.counts().reloadCalls, 0); assert.equal(f.controller.getSnapshot().phase, 'idle');
});

test('多个入口读取相同快照，解除其中一个订阅不影响其余入口', async () => {
  const f = fixture(); f.setReason('task'); let countA = 0, countB = 0;
  const offA = f.controller.subscribe(() => { countA++; });
  f.controller.subscribe(() => { countB++; }); await f.controller.check();
  assert.equal(countA, countB); const previous = countA; offA(); f.setReason(''); f.controller.tick();
  await flush(); assert.equal(countA, previous); assert.ok(countB > previous);
});

test('同名任务独立计数，一个完成不能取消另一个任务的刷新保护', () => {
  const first = beginWebBuildActivity('same'), second = beginWebBuildActivity('same');
  assert.equal(hasWebBuildActivity(), true); first(); first(); assert.equal(hasWebBuildActivity(), true);
  second(); assert.equal(hasWebBuildActivity(), false);
});

test('预载只允许同源Next静态JS/CSS/字体，去重且不访问接口/外域', () => {
  assert.deepEqual(webBuildAssetUrls(['/_next/static/a.js', '/_next/static/a.js', '/_next/static/style.css',
    '/api/auth/me', 'https://other.test/_next/static/a.js', '/_next/static/../../private.js',
    'https://name:pass@luxai.cn/_next/static/a.js', '/_next/static/a.js?x=1'], 'https://luxai.cn'),
  ['https://luxai.cn/_next/static/a.js', 'https://luxai.cn/_next/static/style.css']);
  assert.throws(() => webBuildAssetUrls(['/api/auth/me'], 'https://luxai.cn'));
  assert.throws(() => webBuildAssetUrls(Array.from({ length: 101 }, (_, i) => `/_next/static/${i}.js`), 'https://luxai.cn'));
});

test('本地打包APK不会将刷新误当热更新，桌面远程页面和网页支持', () => {
  assert.equal(supportsWebBuildRefresh({ protocol: 'https:', hostname: 'localhost' }, true), false);
  assert.equal(supportsWebBuildRefresh({ protocol: 'http:', hostname: '127.0.0.1' }, true), false);
  assert.equal(supportsWebBuildRefresh({ protocol: 'capacitor:', hostname: 'localhost' }, true), false);
  assert.equal(supportsWebBuildRefresh({ protocol: 'https:', hostname: 'luxai.cn' }, true), true);
  assert.equal(supportsWebBuildRefresh({ protocol: 'https:', hostname: 'luxai.cn' }, false), true);
  assert.equal(supportsWebBuildRefresh({ protocol: 'http:', hostname: '127.0.0.1' }, false), true);
});

test('等待任务时又发布新版，恢复空闲先确认新marker并重新准备', async () => {
  const f = fixture(); f.setReason('task'); await f.controller.check();
  const newer = { ...next, build_id: 'newer-build-0003' }; f.setLatest(newer);
  const checks = f.counts().latestCalls; f.setReason(''); f.controller.tick(); await flush();
  assert.ok(f.counts().latestCalls > checks);
  assert.deepEqual(f.prepared.map(value => value.buildId), [next.build_id, newer.build_id]);
  assert.deepEqual([...f.ledger], [newer.build_id]); assert.equal(f.counts().reloadCalls, 1);
});

test('等待期间服务器回滚当前版时取消更新，不刷新、不记错版本', async () => {
  const f = fixture(); f.setReason('task'); await f.controller.check();
  f.setLatest(current); f.setReason(''); f.controller.tick(); await flush();
  assert.equal(f.controller.getSnapshot().phase, 'idle');
  assert.equal(f.counts().reloadCalls, 0); assert.equal(f.ledger.size, 0);
});

test('等待期间切换路由，必须准备即将刷新的页面资源', async () => {
  const f = fixture(); f.setReason('task'); await f.controller.check();
  f.setPath('/agent'); f.setReason(''); f.controller.tick(); await flush();
  assert.deepEqual(f.prepared.map(value => value.pathname), ['/library', '/agent']);
  assert.equal(f.counts().reloadCalls, 1);
});

test('应用前确认请求去重，期间开始新任务后最终safety阻止刷新', async () => {
  const f = fixture(), gate = deferred(); f.setReason('task'); await f.controller.check();
  const checks = f.counts().latestCalls;
  f.setLatestLoader(async () => { await gate.promise; return next; });
  f.setReason(''); f.controller.tick(); f.controller.tick(); await flush();
  assert.equal(f.counts().latestCalls, checks + 1);
  f.setReason('task'); gate.resolve(); await flush();
  assert.equal(f.counts().reloadCalls, 0); assert.equal(f.controller.getSnapshot().blocked, 'task');
});

test('显式更新也在异步版本确认后复读输入保护', async () => {
  const f = fixture(), gate = deferred(); f.setReason('interaction'); await f.controller.check();
  f.setLatestLoader(async () => { await gate.promise; return next; });
  const refresh = f.controller.refresh(); await flush(); f.setReason('input'); gate.resolve(); await refresh;
  assert.equal(f.counts().reloadCalls, 0); assert.equal(f.ledger.size, 0);
});

test('确认更新时网络失败，有限自动重试，不沿用旧marker直接刷新', async () => {
  const f = fixture(); f.setReason('task'); await f.controller.check();
  f.setReason(''); f.setLatestLoader(async () => { throw new Error('offline'); });
  f.controller.tick(); await flush(); assert.equal(f.counts().reloadCalls, 0);
  f.advance(30000); f.controller.tick(); await flush();
  const checks = f.counts().latestCalls; f.advance(60000); f.controller.tick(); await flush();
  assert.equal(f.counts().latestCalls, checks); assert.equal(f.counts().reloadCalls, 0);
  f.setLatestLoader(async () => next); await f.controller.retry(); assert.equal(f.counts().reloadCalls, 1);
});

test('连续发布只追赶一次，单次检查不会无限循环下载', async () => {
  const f = fixture(); let index = 2;
  f.setPrepare(async () => f.setLatest({ ...next, build_id: `racing-build-${++index}` }));
  await f.controller.check(); assert.equal(f.counts().prepareCalls, 2);
  assert.equal(f.counts().reloadCalls, 0); assert.equal(f.controller.getSnapshot().phase, 'error');
});

test('旧版重试次数耗尽不占用新发布版本的重试机会', async () => {
  const f = fixture(); f.setPrepare(async () => { throw new Error('offline'); });
  await f.controller.check(); f.advance(30000); f.controller.tick(); await flush();
  assert.equal(f.counts().prepareCalls, 2);
  f.setLatest({ ...next, build_id: 'new-retry-build-0003' }); await f.controller.check();
  assert.equal(f.counts().prepareCalls, 3); f.advance(30000); f.controller.tick(); await flush();
  assert.equal(f.counts().prepareCalls, 4);
});

test('实际活动store的同回合任务交接不会刷新，结束后稳定15秒再检查版本', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 100_000 });
  let clock = Date.now(), reloads = 0, checks = 0;
  const releaseA = beginWebBuildActivity('A');
  const controller = createWebBuildUpdateController({ current, now: () => clock, pathname: () => '/library',
    latest: async () => { checks++; return next; }, prepare: async (_signal, progress) => progress(1, 1),
    safety: () => hasWebBuildActivity() ? 'task' : isWebBuildActivitySettling(clock) ? 'settling' : '',
    wasReloaded: () => false, recordReload: () => true, reload: () => { reloads++; } });
  controller.activate(true); await controller.check();
  const unsubscribe = subscribeWebBuildActivity(() => controller.tick());
  releaseA(); const releaseB = beginWebBuildActivity('B'); await flush();
  assert.equal(reloads, 0); assert.equal(controller.getSnapshot().blocked, 'task');
  releaseB(); clock = Date.now(); await flush();
  assert.equal(controller.getSnapshot().blocked, 'settling');
  const before = checks; clock += 14999; controller.tick(); await flush(); assert.equal(checks, before);
  clock += 1; controller.tick(); await flush(); assert.equal(reloads, 1); assert.equal(checks, before + 1);
  unsubscribe(); controller.activate(false);
});
