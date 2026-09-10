import assert from 'node:assert/strict';
import test from 'node:test';
import { libraryExtractionHeading, summarizeLibraryExtraction } from './libraryExtractionProgress.ts';
import type { DouyinBatchExtractionJob } from './types';

const job = { operation: 'transcript', status: 'running', total: 10, success: 3, failed: 1,
  active: 4, queued: 2, items: [] } as unknown as DouyinBatchExtractionJob;

test('并发进度显示服务端实际活动数，完成和失败都推进进度', () => {
  assert.deepEqual(summarizeLibraryExtraction(job), {
    total: 10, completed: 3, active: 4, queued: 2, failed: 1, percent: 40,
  });
  assert.equal(libraryExtractionHeading(job), '文案正在并发处理');
});

test('成功、部分失败和结束任务不再显示正在处理', () => {
  assert.equal(libraryExtractionHeading({ ...job, status: 'success' }), '文案已完成');
  assert.equal(libraryExtractionHeading({ ...job, status: 'partial' }), '文案部分完成');
  assert.equal(libraryExtractionHeading({ ...job, status: 'failed' }), '文案处理已结束');
});
