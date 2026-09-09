import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPlatformSyncSourceResults } from './platformSyncFeedback.ts';

test('旧客户端可靠前缀保留各来源数量，并合并相同的部分读取诊断', () => {
  const message = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 20, requestedCount: 50, coverage: 'partial', orderReliable: true, warning: '官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试' },
    { sourceLabel: '收藏', acceptedCount: 10, requestedCount: 50, coverage: 'partial', orderReliable: true, warning: '官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试' },
  ]);
  assert.match(message, /喜欢：已保存前 20\/50 条/);
  assert.match(message, /收藏：已保存前 10\/50 条/);
  assert.equal(message.match(/后续列表未完整读取/g)?.length, 1);
  assert.match(message, /喜欢、收藏：后续列表/);
  assert.doesNotMatch(message, /官方列表尚未完整读取/);
});

test('新客户端常规部分读取提示也归并，零条不冒充已完整同步', () => {
  for (const warning of ['已按官方顺序读取前 10 条，其余作品本次未读取；历史资料保留', '官方列表暂未返回可确认顺序的作品；历史资料保留']) {
    const message = formatPlatformSyncSourceResults([
      { sourceLabel: '收藏', acceptedCount: warning.includes('10') ? 10 : 0, requestedCount: 50, coverage: 'partial', orderReliable: true, warning },
    ]);
    assert.equal(message.match(/后续列表未完整读取/g)?.length, 1);
    assert.doesNotMatch(message, /已按官方顺序读取|暂未返回|已保存全部/);
  }
});

test('limited 是正常读取范围，complete 展示已读取全部的实际数量', () => {
  const limited = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 50, requestedCount: 50, coverage: 'limited', orderReliable: true, warning: '本次读取前 50 条，未扫描全部作品' },
  ]);
  assert.equal(limited, '喜欢：已保存前 50/50 条');
  const complete = formatPlatformSyncSourceResults([
    { sourceLabel: '作品', acceptedCount: 3, requestedCount: 50, coverage: 'complete', orderReliable: true },
  ]);
  assert.equal(complete, '作品：已保存全部 3 条（本次最多 50 条）');
});

test('不可靠来源不声称前N，真实鉴权及风控诊断不能被标准化隐藏', () => {
  const message = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 5, requestedCount: 50, coverage: 'partial', orderReliable: false, warning: '请重新验证账号' },
    { sourceLabel: '收藏', acceptedCount: 20, requestedCount: 20, coverage: 'limited', orderReliable: true, warning: '风控限制，请等待 5 分钟后重试' },
  ]);
  assert.match(message, /喜欢：已保存5\/50 条/);
  assert.match(message, /保留上次已确认顺序/);
  assert.match(message, /请重新验证账号/);
  assert.match(message, /风控限制，请等待 5 分钟后重试/);
});
