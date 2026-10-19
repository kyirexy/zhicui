import assert from 'node:assert/strict';
import test from 'node:test';
import { creatorCompletionTitle, isCreatorCatalogOnly } from './creatorRunPresentation.ts';

test('近期目录成功只表示清单更新，失败与取消不会显示成功', () => {
  const run = { operation: 'catalog_recent' as const, auto_transcribe: false };
  assert.equal(isCreatorCatalogOnly({ ...run, status: 'succeeded' }), true);
  for (const [status, expected] of [['succeeded', '已更新'], ['failed', '未完成'], ['partial', '部分完成'], ['cancelled', '任务已取消']] as const) {
    assert.equal(creatorCompletionTitle({ ...run, status }), `博主作品清单${expected}`);
  }
});

test('开启转写的全量任务保留文稿语义', () => {
  const run = { operation: 'catalog_all' as const, auto_transcribe: true, status: 'succeeded' as const };
  assert.equal(isCreatorCatalogOnly(run), false);
  assert.equal(creatorCompletionTitle(run), '博主文稿已完成');
});
