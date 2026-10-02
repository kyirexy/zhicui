import assert from 'node:assert/strict';
import test from 'node:test';
import { watchLibrarySync, captureLabel, syncRunLabel, type LibrarySyncState } from './librarySyncMonitor.ts';
import type { LibrarySyncRun } from './types.ts';
import type { PlatformAccountStatus } from './desktopRuntime.ts';

const run = (values: Partial<LibrarySyncRun> = {}): LibrarySyncRun => ({
  id: 'sync-1', platform: 'douyin', source_mode: 'like', status: 'running', requested_count: 50,
  accepted: 0, created: 0, reused: 0, ready: 0, failed_count: 0, quarantined: 0,
  started_at: '2026-10-02T03:00:01Z', ...values,
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const requests: { signal: AbortSignal; resolve: (runs: LibrarySyncRun[]) => void; reject: (reason: Error) => void }[] = [];
  let capture: ((status: PlatformAccountStatus) => void) | undefined;
  let wake: (() => void) | undefined;
  const timers = new Map<number, () => void>();
  const states: LibrarySyncState[] = [];
  let saved = 0, id = 0, visible = true;
  const stop = watchLibrarySync({
    read: (signal) => new Promise((resolve, reject) => requests.push({ signal, resolve, reject })),
    subscribeCapture: (listener) => { capture = listener; return () => { capture = undefined; }; },
    subscribeWake: (listener) => { wake = listener; return () => { wake = undefined; }; },
    visible: () => visible,
    onState: (state) => states.push(state), onSaved: () => saved++,
    now: () => Date.parse('2026-10-02T03:00:00Z'),
    schedule: (callback) => { const key = ++id; timers.set(key, callback); return key as unknown as ReturnType<typeof setTimeout>; },
    unschedule: ((key: number) => timers.delete(key)) as unknown as typeof clearTimeout,
  });
  return { requests, states, stop, get saved() { return saved; },
    capture: (status: PlatformAccountStatus) => capture?.(status), wake: () => wake?.(),
    visible: (value: boolean) => { visible = value; },
    tick: () => { const next = timers.entries().next().value; if (next) { timers.delete(next[0]); next[1](); } },
  };
}

test('外部同步进度和完成结果均刷新目录，重复轮询不重复刷新', async () => {
  const h = harness();
  try {
    h.requests.shift()!.resolve([run()]); await settle();
    assert.equal(h.saved, 1);
    h.tick(); h.requests.shift()!.resolve([run()]); await settle();
    assert.equal(h.saved, 1);
    h.tick(); h.requests.shift()!.resolve([run({ accepted: 20, created: 20 })]); await settle();
    assert.equal(h.saved, 2);
    h.tick(); h.requests.shift()!.resolve([run({ status: 'partial', accepted: 49, created: 49, failed_count: 1 })]); await settle();
    assert.equal(h.saved, 3);
    assert.equal(syncRunLabel(h.states.at(-1)!.runs[0]), '部分完成');
  } finally { h.stop(); }
});

test('浏览器采集成功不会误报落库成功，只由对应的新云端记录接续', async () => {
  const h = harness();
  try {
    h.requests.shift()!.resolve([]); await settle();
    h.capture({ platform: 'douyin', mode: 'like', stage: 'success', message: 'secret-url-should-not-display' });
    assert.equal(h.states.at(-1)!.capture?.awaitingSave, true);
    assert.match(captureLabel(h.states.at(-1)!.capture!), /等待保存/);
    assert.doesNotMatch(JSON.stringify(h.states), /secret-url/);
    h.requests.shift()!.resolve([run({ started_at: '2026-10-01T03:00:00Z', status: 'succeeded' })]); await settle();
    assert.ok(h.states.at(-1)!.capture);
    h.tick(); h.requests.shift()!.resolve([run()]); await settle();
    assert.equal(h.states.at(-1)!.capture, null);
  } finally { h.stop(); }
});

test('切换账号或卸载后中止读取，迟到结果不能刷新旧账号或显示旧记录', async () => {
  const h = harness();
  const request = h.requests.shift()!;
  h.stop();
  assert.equal(request.signal.aborted, true);
  request.resolve([run({ status: 'succeeded' })]); await settle();
  h.wake(); h.tick();
  assert.deepEqual(h.states, []);
  assert.equal(h.saved, 0);
  assert.equal(h.requests.length, 0);
});

test('断网保留已有结果，连续唤醒不重叠请求，页面隐藏时暂停读取', async () => {
  const h = harness();
  try {
    h.wake(); h.wake(); assert.equal(h.requests.length, 1);
    h.requests.shift()!.resolve([run({ status: 'succeeded' })]); await settle();
    h.tick(); h.requests.shift()!.reject(new Error('offline')); await settle();
    assert.equal(h.states.at(-1)!.runs.length, 1);
    assert.equal(h.states.at(-1)!.offline, true);
    h.visible(false); h.tick(); assert.equal(h.requests.length, 0);
    h.visible(true); h.wake(); assert.equal(h.requests.length, 1);
    h.requests.shift()!.resolve([run({ status: 'succeeded' })]); await settle();
    assert.equal(h.states.at(-1)!.offline, false);
    assert.equal(h.saved, 1);
  } finally { h.stop(); }
});
