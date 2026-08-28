import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCoverSources, withCoverRetryToken } from './libraryCoverSources.ts';

test('封面候选保留代理与原图并去重', () => {
  assert.deepEqual(
    normalizeCoverSources(' /api/cover?a=1 ', 'https://cdn.example/cover.jpg', '/api/cover?a=1', ''),
    ['/api/cover?a=1', 'https://cdn.example/cover.jpg'],
  );
});

test('重试标记保留签名查询与 hash', () => {
  assert.equal(
    withCoverRetryToken('/api/cover?expires=1&signature=abc#preview', 42),
    '/api/cover?expires=1&signature=abc&zhicui_retry=42#preview',
  );
});
