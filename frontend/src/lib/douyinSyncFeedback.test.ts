import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCollectionSyncMessage,
  formatDouyinSyncError,
} from './douyinSyncFeedback.ts';

test('收藏熔断显示账号仍连接和明确重试时间', () => {
  const message = formatCollectionSyncMessage({
    status: 'failed',
    error: 'source blocked',
    error_code: 'source_blocked',
    retry_after_seconds: 901,
    sourceLabel: '收藏',
    requestedCount: 50,
  });

  assert.match(message, /账号仍保持绑定/);
  assert.match(message, /约 16 分钟后可再试/);
});

test('账号验证提示不伪装成连接器离线', () => {
  const message = formatDouyinSyncError('challenge', '收藏', {
    error_code: 'verification_required',
    needs_action: true,
  });

  assert.match(message, /重新验证账号/);
  assert.doesNotMatch(message, /连接器离线/);
});
