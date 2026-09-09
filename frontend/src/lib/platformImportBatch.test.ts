import assert from 'node:assert/strict';
import test from 'node:test';
import { importPlatformBatches, platformImportBatchBody } from './platformImportBatch.ts';
import { platformSyncWarning, withPlatformSyncWarning } from './platformSyncFeedback.ts';
import { capturePlatformSyncSnapshot } from './platformSyncSnapshot.ts';
import { readFileSync } from 'node:fs';

const urls = (count: number) => Array.from({ length: count }, (_, index) => `https://www.bilibili.com/video/BVtest${index}`);

test('50/100条同步按10条分批全部上传，rank偏移连续而不是静默截断', async () => {
  for (const count of [1, 25, 50, 100]) {
    const input = urls(count);
    const batches: { urls: string[]; sourceRankOffset: number }[] = [];
    const result = await importPlatformBatches(input, async (batch) => {
      batches.push(batch);
      return { success: true, data: {
        items: batch.urls.map((input) => ({ input, success: true, status: 'reused' as const })),
        total: batch.urls.length, success: batch.urls.length, failed: 0,
      } };
    });
    assert.deepEqual(batches.flatMap((batch) => batch.urls), input);
    assert.deepEqual(batches.map((batch) => batch.sourceRankOffset), Array.from({ length: Math.ceil(count / 10) }, (_, index) => index * 10));
    assert.equal(result.data?.success, count);
    assert.equal(result.data?.failed, 0);
  }
});

test('中途断线保留已成功项，其余明确标记可重试，不假报全部同步', async () => {
  let requests = 0;
  const result = await importPlatformBatches(urls(25), async (batch) => {
    requests += 1;
    if (requests === 2) throw new Error('网络连接中断');
    return { success: true, data: {
      items: batch.urls.map((input) => ({ input, success: true, status: 'imported' as const })),
      total: 10, success: 10, failed: 0,
    } };
  });
  assert.equal(requests, 2);
  assert.equal(result.data?.success, 10);
  assert.equal(result.data?.failed, 0);
  assert.equal(result.data?.pending, 15);
  assert.equal(result.data?.items.filter((item) => item.status === 'pending').length, 15);
  assert.deepEqual(result.data?.items.map((item) => item.input), urls(25));
});

test('来源完整性警告保留，旧桌面不凭空声明已经校准顺序', () => {
  assert.equal(platformSyncWarning({}), '');
  assert.equal(platformSyncWarning({ coverage: 'complete', orderReliable: true }), '');
  assert.match(platformSyncWarning({ coverage: 'limited' }), /未扫描全部/);
  assert.match(platformSyncWarning({ coverage: 'partial' }), /部分/);
  assert.match(platformSyncWarning({ orderReliable: false }), /顺序/);
  assert.equal(platformSyncWarning({ warning: '收藏夹缺少时间，顺序不能确认' }), '收藏夹缺少时间，顺序不能确认');
  const warning = platformSyncWarning({ coverage: 'limited' });
  assert.match(withPlatformSyncWarning('10 条文案已就绪', warning), /未扫描全部/);
  assert.equal(withPlatformSyncWarning(warning, warning), warning);
  const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /withPlatformSyncWarning\(sourceManagerNotice, sourceSyncWarning\)/);
  assert.match(page, /withPlatformSyncWarning\(notice, showDouyinItems \? sourceSyncWarning : ''\)/);
});

test('同步快照固定为开始采集的时间，分批和重试不会生成新时间', async () => {
  const startedAt = '2026-09-08T01:00:00.000Z';
  const snapshot = capturePlatformSyncSnapshot({ coverage: 'limited', orderReliable: true }, startedAt);
  const submittedSnapshots: string[] = [];
  await importPlatformBatches(urls(25), async (batch) => {
    submittedSnapshots.push(snapshot.sourceSyncedAt);
    return { success: true, data: {
      items: batch.urls.map((input) => ({ input, success: true, status: 'reused' as const })),
      total: batch.urls.length, success: batch.urls.length, failed: 0,
    } };
  });
  assert.deepEqual(submittedSnapshots, [startedAt, startedAt, startedAt]);
  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
  assert.match(api, /source_synced_at: snapshot\.sourceSyncedAt/);
  const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /const sourceSyncedAt = new Date\(\)\.toISOString\(\);\s+const collected = await bridge\.collectPlatformAccount/);
});

test('重复链接只登记首次位置，每批snapshot_size都使用去重总数', async () => {
  const input = urls(12);
  const snapshot = capturePlatformSyncSnapshot({ coverage: 'complete', orderReliable: true }, '2026-09-08T01:00:00Z');
  const bodies: ReturnType<typeof platformImportBatchBody>[] = [];
  const progress: number[][] = [];
  const result = await importPlatformBatches([
    ...input.slice(0, 8), input[0], ` ${input[1]} `, '', ...input.slice(8), input[11],
  ], async (batch) => {
    bodies.push(platformImportBatchBody(batch, snapshot.sourceSyncedAt, 'collect', snapshot));
    return { success: true, data: {
      items: batch.urls.map((input) => ({ input, success: true, status: 'reused' as const })),
      total: batch.urls.length, success: batch.urls.length, failed: 0,
    } };
  }, (completed, total) => progress.push([completed, total]));
  assert.deepEqual(bodies.flatMap((body) => body.urls), input);
  assert.deepEqual(bodies.map((body) => body.source_snapshot_size), [12, 12]);
  assert.deepEqual(bodies.map((body) => body.source_rank_offset), [0, 10]);
  assert.deepEqual(progress, [[10, 12], [12, 12]]);
  assert.equal(result.data?.total, 12);
  assert.equal(result.data?.success, 12);
});

test('普通导入同样发送固定快照与连续offset，但不发送分类完成大小', () => {
  const sourceSyncedAt = '2026-09-08T01:00:00Z';
  const bodies = [0, 10].map((sourceRankOffset) => platformImportBatchBody({
    urls: urls(12).slice(sourceRankOffset, sourceRankOffset + 10),
    sourceRankOffset,
    sourceSnapshotSize: 12,
  }, sourceSyncedAt));
  assert.deepEqual(bodies.map((body) => body.source_rank_offset), [0, 10]);
  assert.deepEqual(bodies.map((body) => body.source_synced_at), [sourceSyncedAt, sourceSyncedAt]);
  assert.ok(bodies.every((body) => !('source_snapshot_size' in body) && !('source_mode' in body)));
});
