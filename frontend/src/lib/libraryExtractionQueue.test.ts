import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateExtractionJobs, LibraryExtractionBatchTracker, runReservedExtractionBatches } from './libraryExtractionQueue.ts';
import { selectAutomaticTranscriptPreparationTargets } from './libraryTranscriptPreparation.ts';
import type { DouyinBatchExtractionJob, DouyinLibraryItem } from './types.ts';

const item = (id: string, extra: Partial<DouyinLibraryItem> = {}) => ({ aweme_id: id, can_extract: true,
  extracted_note_id: null, transcript_chars: 0, ai_initialized: false, ...extra }) as DouyinLibraryItem;
const job = (id: string, ids: string[], done = false): DouyinBatchExtractionJob => ({
  job_id: id, operation: 'transcript', status: done ? 'success' : 'running', created_at: '', started_at: '',
  concurrency: { asr: 4, llm: 2 }, total: ids.length, success: done ? ids.length : 0, failed: 0,
  active: 0, queued: done ? 0 : ids.length, database_stores_media: false,
  items: ids.map((aweme_id) => ({ aweme_id, state: done ? 'done' : 'queued', error: '', updated_at: '',
    note_id: done ? `note-${aweme_id}` : null, transcript_chars: done ? 100 : 0, ai_initialized: false, already_existed: false })),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let index = 0; index < 24; index += 1) await Promise.resolve(); };

test('跨批次阶段数按去重后的最新条目汇总，不继承首批下载和转写数量', () => {
  const first = job('first', ['a', 'b']);
  first.items[0].state = 'downloading';
  first.items[1].state = 'transcribing';
  Object.assign(first, { downloading: 1, transcribing: 1, analyzing: 0 });
  const second = job('second', ['b', 'c', 'd']);
  second.items[0].state = 'transcribing';
  second.items[1].state = 'downloading';
  second.items[2].state = 'analyzing';
  const result = aggregateExtractionJobs([first, second])!;
  assert.deepEqual([result.total, result.active, result.downloading, result.transcribing, result.analyzing], [4, 4, 2, 1, 1]);
  second.items[0].state = 'done';
  const updated = aggregateExtractionJobs([first, second])!;
  assert.deepEqual([updated.active, updated.downloading, updated.transcribing, updated.analyzing, updated.success], [3, 2, 0, 1, 1]);
});

test('跨来源全部待处理 ID 分块，不在第100条静默截断，已完成/不可用/重复内容排除', () => {
  const tracker = new LibraryExtractionBatchTracker();
  const targets = Array.from({ length: 205 }, (_, index) => item(String(index)));
  const batches = tracker.reserve([...targets, item('0'), item('ready'), item('ready', {
    extracted_note_id: 'note-ready', transcript_chars: 10,
  }), item('unavailable', { can_extract: false })], 'transcript');
  assert.deepEqual(batches.map((batch) => batch.ids.length), [100, 100, 5]);
  assert.equal(tracker.snapshot()?.total, 205);
  assert.equal(tracker.snapshot()?.queued, 205);
  assert.equal(tracker.busy, true);
  assert.deepEqual(tracker.reserve([item('1')], 'full'), [], '其他操作也不能重复提交运行中的同一视频');
  assert.deepEqual(new LibraryExtractionBatchTracker().reserve(targets.slice(0, 101), 'full').map((batch) => batch.ids.length), [50, 50, 1]);
});

test('喜欢和收藏各100条全部提交，总进度显示200条而不是刚完成的4条', () => {
  const liked = Array.from({ length: 100 }, (_, index) => item(`like-${index}`));
  const collected = Array.from({ length: 100 }, (_, index) => item(`collect-${index}`));
  const targets = selectAutomaticTranscriptPreparationTargets([liked, collected].map((items) => ({
    items, syncedVideoIds: items.map((entry) => entry.aweme_id),
  })), Number.MAX_SAFE_INTEGER);
  const tracker = new LibraryExtractionBatchTracker();
  const batches = tracker.reserve(targets, 'transcript');
  assert.deepEqual(batches.map((batch) => batch.ids.length), [100, 100]);
  const partial = job('like', batches[0].ids);
  partial.items.splice(0, 4, ...job('done', batches[0].ids.slice(0, 4), true).items);
  tracker.update(batches[0].key, partial);
  assert.equal(tracker.snapshot()?.total, 200);
  assert.equal(tracker.snapshot()?.success, 4);
  assert.equal(tracker.snapshot()?.queued, 196);
});

test('旧批次完成时新增批次仍在提交，保留观察与聚合总数，迟到提交成功继续轮询', async () => {
  const tracker = new LibraryExtractionBatchTracker();
  const firstDone = deferred<DouyinBatchExtractionJob>();
  const secondSubmit = deferred<DouyinBatchExtractionJob>();
  const secondDone = deferred<DouyinBatchExtractionJob>();
  const seen: Array<{ total: number; success: number; busy: boolean }> = [];
  const onChange = () => { const value = tracker.snapshot()!; seen.push({ total: value.total, success: value.success, busy: tracker.busy }); };
  const first = runReservedExtractionBatches(tracker, tracker.reserve([item('a')], 'transcript'), {
    isCurrent: () => true, submit: async () => job('first', ['a']), observe: async () => firstDone.promise, onChange,
  });
  await flush();
  const secondBatches = tracker.reserve([item('a'), item('b'), item('c')], 'transcript');
  assert.deepEqual(secondBatches.flatMap((batch) => batch.ids), ['b', 'c']);
  const second = runReservedExtractionBatches(tracker, secondBatches, {
    isCurrent: () => true, submit: async () => secondSubmit.promise, observe: async () => secondDone.promise, onChange,
  });
  firstDone.resolve(job('first', ['a'], true));
  assert.equal((await first)?.success, 1);
  assert.equal(tracker.busy, true);
  assert.equal(tracker.snapshot()?.total, 3);
  assert.equal(tracker.snapshot()?.success, 1);
  secondSubmit.resolve(job('second', ['b', 'c']));
  await flush();
  secondDone.resolve(job('second', ['b', 'c'], true));
  assert.equal((await second)?.success, 2);
  assert.equal(tracker.busy, false);
  assert.equal(tracker.snapshot()?.success, 3);
  assert.equal(tracker.snapshot()?.total, 3);
  assert.ok(seen.some((entry) => entry.total === 3 && entry.success === 1 && entry.busy));
  assert.deepEqual(tracker.reserve([item('a')], 'transcript'), [], '旧同步快照不能把本页刚完成的视频再次提交');
  tracker.forget('a');
  assert.equal(tracker.reserve([item('a')], 'transcript').length, 1, '用户明确删除提取结果后允许重做');
});

test('提交并发最多3，服务端接受后立刻提交后续分块，不等待前批文稿完成', async () => {
  const tracker = new LibraryExtractionBatchTracker();
  const requests: Array<{ ids: string[]; response: ReturnType<typeof deferred<DouyinBatchExtractionJob>> }> = [];
  const observed: Array<{ initial: DouyinBatchExtractionJob; done: ReturnType<typeof deferred<DouyinBatchExtractionJob>> }> = [];
  const batches = tracker.reserve(Array.from({ length: 401 }, (_, index) => item(String(index))), 'transcript');
  const task = runReservedExtractionBatches(tracker, batches, {
    isCurrent: () => true,
    submit: async (ids) => { const response = deferred<DouyinBatchExtractionJob>(); requests.push({ ids, response }); return response.promise; },
    observe: async (initial) => { const done = deferred<DouyinBatchExtractionJob>(); observed.push({ initial, done }); return done.promise; },
    onChange: () => {},
  });
  assert.equal(requests.length, 3);
  requests[0].response.resolve(job('j0', requests[0].ids));
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(observed.length, 1, '前批仍在观察时后批已经开始提交');
  requests[1].response.resolve(job('j1', requests[1].ids));
  await flush();
  assert.equal(requests.length, 5);
  for (let index = 2; index < requests.length; index += 1) requests[index].response.resolve(job(`j${index}`, requests[index].ids));
  await flush();
  for (const entry of observed) entry.done.resolve(job(entry.initial.job_id, entry.initial.items.map((value) => value.aweme_id), true));
  assert.equal((await task)?.success, 401);
  assert.equal(tracker.busy, false);
});

test('提交失败和轮询异常都恢复 busy，已接受任务重试时只恢复观察', async () => {
  const tracker = new LibraryExtractionBatchTracker();
  const batches = tracker.reserve(Array.from({ length: 201 }, (_, index) => item(String(index))), 'transcript');
  const result = await runReservedExtractionBatches(tracker, batches, {
    isCurrent: () => true,
    submit: async (ids) => { if (ids[0] === '0') throw new Error('服务端拒绝提交'); return job(ids[0], ids); },
    observe: async (initial) => { if (initial.job_id === '100') throw new Error('进度连接中断'); return job(initial.job_id, initial.items.map((value) => value.aweme_id), true); },
    onChange: () => {},
  });
  assert.equal(tracker.busy, false);
  assert.equal(result?.total, 201);
  assert.equal(result?.failed, 100);
  assert.equal(result?.success, 1);
  assert.equal(result?.status, 'running');
  const retry = tracker.reserve([item('0'), item('100'), item('200')], 'transcript');
  assert.equal(retry.filter((batch) => !batch.initial).flatMap((batch) => batch.ids).length, 1);
  assert.equal(retry.find((batch) => batch.initial)?.initial?.job_id, '100');
  const submitted: string[][] = [];
  const retried = await runReservedExtractionBatches(tracker, retry, {
    isCurrent: () => true,
    submit: async (ids) => { submitted.push(ids); return job('retry', ids); },
    observe: async (initial) => job(initial.job_id, initial.items.map((value) => value.aweme_id), true),
    onChange: () => {},
  });
  assert.deepEqual(submitted, [['0']], '轮询中断的已接受100条不再提交');
  assert.equal(retried?.success, 101);
  assert.equal(tracker.busy, false);
});

test('账号切换/卸载拒绝迟到结果，停止尚未提交的分块，已提交任务不被取消', async () => {
  const tracker = new LibraryExtractionBatchTracker();
  let current = true;
  let changes = 0;
  const requests: Array<{ ids: string[]; response: ReturnType<typeof deferred<DouyinBatchExtractionJob>> }> = [];
  const task = runReservedExtractionBatches(tracker, tracker.reserve(Array.from({ length: 401 }, (_, index) => item(String(index))), 'transcript'), {
    isCurrent: () => current,
    submit: async (ids) => { const response = deferred<DouyinBatchExtractionJob>(); requests.push({ ids, response }); return response.promise; },
    observe: async () => { throw new Error('已切换账号，不得开始观察'); },
    onChange: () => { changes += 1; },
  });
  assert.equal(requests.length, 3);
  current = false;
  requests.forEach(({ ids, response }, index) => response.resolve(job(String(index), ids)));
  assert.equal(await task, null);
  assert.equal(requests.length, 3);
  assert.equal(changes, 0);
});

test('页面离开后已接受任务继续执行，完成结果不更新新页面状态', async () => {
  const tracker = new LibraryExtractionBatchTracker();
  let current = true;
  let changes = 0;
  const done = deferred<DouyinBatchExtractionJob>();
  const task = runReservedExtractionBatches(tracker, tracker.reserve([item('a')], 'transcript'), {
    isCurrent: () => current, submit: async () => job('j', ['a']), observe: async () => done.promise,
    onChange: () => { changes += 1; },
  });
  await flush();
  const before = changes;
  current = false;
  done.resolve(job('j', ['a'], true));
  assert.equal(await task, null);
  assert.equal(changes, before);
});
