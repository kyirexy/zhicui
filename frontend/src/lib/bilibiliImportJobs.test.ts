import assert from 'node:assert/strict';
import test from 'node:test';
import { bilibiliJobEntries, bilibiliSubmissionKey, hasUnresolvedBilibiliSource, importBilibiliJobs, mergeBilibiliJobResults, watchBilibiliJobs } from './bilibiliImportJobs.ts';
import { platformImportSummary } from './libraryIncrementalSync.ts';
import type { BilibiliImportJob } from './types';

const urls = (count = 20) => Array.from({ length: count }, (_, i) => `https://www.bilibili.com/video/BVtest${i}`);
const queued = (id: string, input: string[]): BilibiliImportJob => ({ id, status: 'queued', total: input.length,
  completed: 0, success: 0, failed: 0, items: input.map((input) => ({ input, platform: 'bilibili', status: 'pending', success: false })) });
const done = (job: BilibiliImportJob): BilibiliImportJob => ({ ...job, status: 'succeeded', completed: job.total,
  success: job.total, items: job.items.map((entry) => ({ ...entry, status: 'imported', success: true })) });

test('20条先全部持久入队再GET确认；排队不算新增，逐批落库才通知进度', async () => {
  const events: string[] = [], progress: number[] = [];
  const jobs = new Map<string, BilibiliImportJob>();
  const result = await importBilibiliJobs(urls(), async (batch) => {
    const job = queued(`job-${batch.sourceRankOffset}`, batch.urls);
    jobs.set(job.id, job); events.push(`POST:${batch.sourceRankOffset}`);
    return { success: true, data: job };
  }, async (id) => { events.push(`GET:${id}`); return { success: true, data: done(jobs.get(id)!) }; }, {
    isCurrent: () => true, onProgress: (completed) => progress.push(completed), wait: async () => {},
  });
  assert.deepEqual(events.slice(0, 2), ['POST:0', 'POST:10']);
  assert.deepEqual(progress, [0, 20]);
  assert.equal(result.data?.success, 20);
  assert.equal(result.data?.pending, 0);
  assert.deepEqual(result.data?.items.map((entry) => entry.input), urls());
});

test('POST响应丢失不自动重发，区分本批未知与尚未提交', async () => {
  let posts = 0, gets = 0;
  const result = await importBilibiliJobs(urls(), async () => { posts += 1; return { success: false, status: 502 }; },
    async () => { gets += 1; return { success: false }; }, { isCurrent: () => true });
  assert.equal(posts, 1); assert.equal(gets, 0);
  assert.equal(result.data?.pending, 10);
  assert.equal(result.data?.not_submitted, 10);
  assert.equal(result.data?.success, 0);
  assert.equal(result.data?.interrupted, true);
  assert.ok(result.data?.items.every((entry) => !entry.background_pending));
});

test('GET断线保留已保存任务，停止等待但不标失败或重发POST', async () => {
  let posts = 0, gets = 0;
  const result = await importBilibiliJobs(urls(), async (batch) => { posts += 1; return { success: true, data: queued(String(posts), batch.urls) }; },
    async () => { gets += 1; return { success: false, status: 502 }; }, { isCurrent: () => true });
  assert.equal(posts, 2); assert.equal(gets, 2);
  assert.equal(result.data?.success, 0); assert.equal(result.data?.failed, 0);
  assert.equal(result.data?.pending, 20); assert.equal(result.data?.interrupted, false);
  assert.ok(result.data?.items.every((entry) => entry.background_pending && entry.job_id));
  assert.match(platformImportSummary(result.data!.items), /20 条后台准备中/);
});

test('账号切换时停止剩余POST和GET，迟到旧账号结果不返回页面', async () => {
  let current = true, posts = 0, gets = 0;
  const result = await importBilibiliJobs(urls(), async (batch) => { posts += 1; current = false; return { success: true, data: queued('old', batch.urls) }; },
    async () => { gets += 1; return { success: false }; }, { isCurrent: () => current });
  assert.equal(posts, 1); assert.equal(gets, 0); assert.equal(result.success, false); assert.equal(result.data, undefined);
});

test('轮询次数有界，服务端终态缺项不伪装成功', async () => {
  let gets = 0;
  const input = urls(2), job = queued('job', input);
  const result = await importBilibiliJobs(input, async () => ({ success: true, data: job }), async () => {
    gets += 1; return { success: true, data: job };
  }, { isCurrent: () => true, maxPolls: 2, wait: async () => {} });
  assert.equal(gets, 2); assert.equal(result.data?.pending, 2); assert.equal(result.data?.success, 0);
  const missing = bilibiliJobEntries({ ...done(job), items: done(job).items.slice(0, 1) }, input);
  assert.equal(missing[0].success, true); assert.equal(missing[1].status, 'pending'); assert.equal(missing[1].background_pending, false);
});

test('重开仅恢复活跃任务，不再次播报历史完成；原快照匹配可确认丢失的POST响应', () => {
  const old = done(queued('old', urls(2)));
  const active = queued('active', urls(3));
  assert.deepEqual(mergeBilibiliJobResults([], [old]), []);
  assert.equal(mergeBilibiliJobResults([], [old, active]).length, 3);
  const job = { ...done(active), source_mode: 'collect', source_synced_at: '2026-09-14T10:00:00Z', source_rank_offset: 0 };
  const uncertain = active.items.map((entry) => ({ ...entry, submission_key: bilibiliSubmissionKey('collect', '2026-09-14T10:00:00.000+00:00', 0) }));
  const confirmed = mergeBilibiliJobResults(uncertain, [old, job]);
  assert.equal(confirmed.length, 3); assert.ok(confirmed.every((entry) => entry.success && entry.job_id === 'active'));
  const unrelated = { ...job, id: 'other', source_synced_at: '2026-09-14T11:00:00Z' };
  assert.equal(mergeBilibiliJobResults(uncertain, [unrelated]), uncertain);
});

test('前台等待用完后仍低频跟进，完成刷新一次并停止；离页/换账号丢弃迟到结果', async () => {
  const job = queued('later', urls(2));
  const initial = await importBilibiliJobs(urls(2), async () => ({ success: true, data: job }), async () => ({ success: true, data: job }),
    { isCurrent: () => true, maxPolls: 15, wait: async () => {} });
  assert.equal(initial.data?.pending, 2);
  let callback = () => {}, reads = 0, updates = 0;
  const stop = watchBilibiliJobs(['later'], async () => { reads += 1; return { success: true, data: done(job) }; }, (jobs) => {
    updates += 1;
    assert.equal(mergeBilibiliJobResults(initial.data!.items, jobs).filter((item) => item.success).length, 2);
  }, { isCurrent: () => true, schedule: (next) => { callback = next; return () => {}; } });
  callback();
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  assert.equal(reads, 1); assert.equal(updates, 1);
  stop(); callback();
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  assert.equal(reads, 1);
  let resolveRead!: (value: { success: boolean; data: BilibiliImportJob }) => void;
  let current = true;
  const cancel = watchBilibiliJobs(['later'], () => new Promise((resolve) => { resolveRead = resolve; }), () => { updates += 1; },
    { isCurrent: () => current, schedule: (next) => { callback = next; return () => {}; } });
  callback(); current = false; resolveRead({ success: true, data: done(job) });
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  assert.equal(updates, 1); cancel();
});

test('同来源仍在后台或提交未知时只允许查看进度，其他来源保持独立', () => {
  const entries = bilibiliJobEntries({ ...queued('active', urls(2)), source_mode: 'collect', source_synced_at: '2026-09-14T10:00:00Z', source_rank_offset: 0 });
  assert.equal(hasUnresolvedBilibiliSource(entries, ['collect']), true);
  assert.equal(hasUnresolvedBilibiliSource(entries, ['like']), false);
  assert.equal(hasUnresolvedBilibiliSource(entries.map((entry) => ({ ...entry, background_pending: false })), ['collect']), true);
  assert.equal(hasUnresolvedBilibiliSource(entries.map((entry) => ({ ...entry, success: true, status: 'reused' })), ['collect']), false);
});

test('真实服务端skipped:true是终态但不算新增；合法BV尾斜杠匹配不误认其他URL', async () => {
  const canonical = 'https://www.bilibili.com/video/BV1test234567';
  const job: BilibiliImportJob = { ...queued('skipped', [canonical]), status: 'succeeded', completed: 1,
    items: [{ input: canonical, platform: 'bilibili', status: 'skipped', success: true }] };
  const entries = bilibiliJobEntries(job, [`${canonical}/`]);
  assert.equal(entries[0].status, 'skipped'); assert.equal(entries[0].success, false);
  assert.equal(hasUnresolvedBilibiliSource(entries, ['collect']), false);
  assert.equal(bilibiliJobEntries(job, [`${canonical}?p=2`])[0].status, 'pending');
  let sent: string[] = [];
  const result = await importBilibiliJobs([canonical, `${canonical}/`], async (batch) => { sent = batch.urls; return { success: true, data: job }; },
    async () => { throw new Error('终态不应该再轮询'); }, { isCurrent: () => true });
  assert.deepEqual(sent, [canonical]); assert.equal(result.data?.skipped, 1); assert.equal(result.data?.success, 0);
});

test('服务端已保存但POST回包丢失，人工原批次重放绑定同一任务且不重复创建', async () => {
  const saved = new Map<string, BilibiliImportJob>();
  const bodies: string[] = [];
  let loseResponse = true;
  const submit = async (batch: { urls: string[]; sourceRankOffset: number; sourceSnapshotSize: number }) => {
    const key = JSON.stringify(batch); bodies.push(key);
    if (!saved.has(key)) saved.set(key, queued(`job-${saved.size}`, batch.urls));
    if (loseResponse) { loseResponse = false; return { success: false, status: 502 }; }
    return { success: true, data: saved.get(key)! };
  };
  const read = async (id: string) => ({ success: true, data: done([...saved.values()].find((job) => job.id === id)!) });
  const first = await importBilibiliJobs(urls(), submit, read, { isCurrent: () => true });
  assert.equal(first.data?.pending, 10); assert.equal(saved.size, 1);
  const retried = await importBilibiliJobs(urls(), submit, read, { isCurrent: () => true });
  assert.equal(saved.size, 2); assert.equal(bodies[0], bodies[1]);
  assert.equal(retried.data?.success, 20); assert.equal(retried.data?.pending, 0);
});
