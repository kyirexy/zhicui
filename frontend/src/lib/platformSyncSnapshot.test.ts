import assert from 'node:assert/strict';
import test from 'node:test';
import { capturePlatformSyncSnapshot, safeCaptureDiagnostics } from './platformSyncSnapshot.ts';

const diagnostics = {
  version: 1, platform: 'douyin', mode: 'collect',
  capture_started_at: '2026-09-14T01:00:00Z',
  capture_finished_at: '2026-09-14T01:00:06Z',
  fresh_document_committed: true, document_commit_count: 1,
  http_cache_bypassed: true, service_worker_bypassed: true,
  endpoint_path: '/aweme/v1/web/aweme/listcollection/',
  request_methods: ['POST'], first_page_cursor: '0', page_count: 3,
  first_video_ids: ['7604808290219920640', '7566164186134039857', '7596597296789682298'],
};

test('采集诊断只保留安全字段，正文和查询串不进入上传快照', () => {
  const result = safeCaptureDiagnostics({
    ...diagnostics, cookie: 'PRIVATE_COOKIE', url: 'https://www.douyin.com/?token=PRIVATE_TOKEN',
    headers: { Authorization: 'PRIVATE_AUTH' }, postData: 'PRIVATE_BODY',
    first_video_ids: [...diagnostics.first_video_ids, 'PRIVATE_ID'],
    request_methods: ['POST', 'POST', 'PRIVATE_METHOD'],
  });
  assert.ok(result);
  assert.deepEqual(result.request_methods, ['POST']);
  assert.deepEqual(result.first_video_ids, diagnostics.first_video_ids);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(Object.keys(result).length, 14);
});

test('无诊断兼容，错误分类、时间或带凭据路径不能附加诊断', () => {
  for (const value of [undefined, null, [], {}, { ...diagnostics, version: 2 },
    { ...diagnostics, mode: 'like' }, { ...diagnostics, endpoint_path: `${diagnostics.endpoint_path}?token=SECRET` },
    { ...diagnostics, capture_started_at: 'SECRET' },
    { ...diagnostics, capture_finished_at: '2026-09-13T01:00:00Z' }]) {
    assert.equal(safeCaptureDiagnostics(value), undefined);
  }
  assert.deepEqual(capturePlatformSyncSnapshot({ coverage: 'partial', orderReliable: false }, 'fixed'),
    { coverage: 'partial', orderReliable: false, sourceSyncedAt: 'fixed' });
});

test('诊断不能抬高排序可信度或改变原始同步时间，超界内容不能传递', () => {
  const normalized = safeCaptureDiagnostics({ ...diagnostics, page_count: Infinity,
    document_commit_count: 1001, fresh_document_committed: 'true',
    first_video_ids: ['SECRET', '12345', '1'.repeat(33)] });
  assert.ok(normalized);
  assert.equal(normalized.page_count, 0);
  assert.equal(normalized.document_commit_count, 0);
  assert.equal(normalized.fresh_document_committed, false);
  assert.deepEqual(normalized.first_video_ids, ['12345']);
  const snapshot = capturePlatformSyncSnapshot({ coverage: 'partial', orderReliable: false, diagnostics: normalized }, 'fixed');
  assert.equal(snapshot.sourceSyncedAt, 'fixed');
  assert.equal(snapshot.orderReliable, false);
  assert.equal(snapshot.coverage, 'partial');
});
