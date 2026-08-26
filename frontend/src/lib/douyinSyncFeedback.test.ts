import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCollectionSyncMessage,
  formatDouyinSyncError,
  hasDouyinSyncFailureDiagnostic,
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

test('连接器误报成功时仍优先显示明确风控提示', () => {
  const message = formatCollectionSyncMessage({
    status: 'success',
    total: 0,
    success: 0,
    error_code: 'source_blocked',
    retry_after_seconds: 300,
    sourceLabel: '收藏',
    requestedCount: 50,
  });

  assert.match(message, /抖音暂时限制了收藏列表读取/);
  assert.match(message, /约 5 分钟后可再试/);
  assert.doesNotMatch(message, /同步成功/);
});

test('成功状态携带账号验证要求时仍提示用户处理', () => {
  const message = formatCollectionSyncMessage({
    status: 'success',
    error_code: 'verification_required',
    needs_action: true,
    sourceLabel: '喜欢',
    requestedCount: 50,
  });

  assert.match(message, /重新验证账号/);
  assert.equal(hasDouyinSyncFailureDiagnostic({
    error_code: 'verification_required',
    needs_action: true,
  }), true);
});

test('零条且无诊断时不再伪装成同步成功', () => {
  const message = formatCollectionSyncMessage({
    status: 'success',
    total: 0,
    success: 0,
    sourceLabel: '喜欢',
    requestedCount: 50,
  });

  assert.match(message, /不计为同步成功/);
  assert.match(message, /可能是该列表为空/);
  assert.match(message, /抖音暂时限制/);
});
