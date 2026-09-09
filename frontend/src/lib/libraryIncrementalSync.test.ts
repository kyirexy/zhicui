import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSyncedItems, platformImportSummary } from './libraryIncrementalSync.ts';
import { importPlatformBatches } from './platformImportBatch.ts';

test('增量前缀更新去重后保留历史尾部，不把100条已存资料缩成10条', () => {
  const previous = Array.from({ length: 100 }, (_, id) => ({ id: String(id), title: '旧标题' }));
  const incoming = [{ id: 'new', title: '新视频' }, { id: '20', title: '校准标题' }];
  const merged = mergeSyncedItems(previous, incoming, (item) => item.id);
  assert.equal(merged.length, 101);
  assert.deepEqual(merged.slice(0, 2), incoming);
  assert.equal(merged.filter((item) => item.id === '20').length, 1);
  assert.equal(previous[20].title, '旧标题');
});

test('复用、过期跳过和真实失败分别反馈，过期项不算失败或新增', async () => {
  const result = await importPlatformBatches(['one', 'two', 'three', 'four'], async () => ({
    success: true, data: { total: 4, success: 2, failed: 1, skipped: 1, items: [
      { input: 'one', success: true, status: 'imported' },
      { input: 'two', success: true, status: 'reused' },
      { input: 'three', success: false, status: 'skipped', item: null },
      { input: 'four', success: false, status: 'failed', error: '网络失败' },
    ] },
  }));
  assert.equal(result.data?.success, 2);
  assert.equal(result.data?.failed, 1);
  assert.equal(result.data?.skipped, 1);
  assert.equal(platformImportSummary(result.data!.items), '新增 1 条，复用 1 条，1 条需要重试，跳过 1 条过期结果；历史资料已保留');
});

test('服务端遗漏结果只记待确认，保留已复用结果且不计失败', async () => {
  const result = await importPlatformBatches(['one', 'two'], async () => ({
    success: true, data: { total: 2, success: 1, failed: 0, items: [
      { input: 'one', success: true, status: 'reused' },
    ] },
  }));
  assert.equal(result.data?.failed, 0);
  assert.equal(result.data?.pending, 1);
  assert.equal(platformImportSummary(result.data!.items), '新增 0 条，复用 1 条，1 条待确认，可重试；历史资料已保留');
});
