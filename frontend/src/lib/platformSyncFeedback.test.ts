import assert from 'node:assert/strict';
import test from 'node:test';
import { formatPlatformSyncError, formatPlatformSyncSourceResults, platformSyncWarning } from './platformSyncFeedback.ts';

test('同步错误移除 Electron 通信包装及重复 Error 前缀', () => {
  assert.equal(formatPlatformSyncError(new Error("Error invoking remote method 'desktop:collect-platform-account': Error: 读取未完成，请稍后重试")), '读取未完成，请稍后重试');
  assert.equal(formatPlatformSyncError('Error: Error: 请完成账号验证后继续同步'), '请完成账号验证后继续同步');
});

test('批次和会话标识错误显示平台通用的刷新提示', () => {
  for (const message of ['抖音同步批次标识无效', '本机账号会话标识无效']) {
    const formatted = formatPlatformSyncError(new Error(`Error invoking remote method 'desktop:collect-platform-account': Error: ${message}`));
    assert.equal(formatted, '同步参数暂不兼容，请刷新页面后重试');
    assert.doesNotMatch(formatted, /抖音|登录/);
  }
});

test('保留可操作的中文登录和读取错误，不添加其他平台名称', () => {
  for (const message of ['账号登录已失效，请先重新登录', '请完成账号验证后继续同步', '没有读取到可同步的 B站作品，请确认账号列表可见']) {
    assert.equal(formatPlatformSyncError(new Error(message)), message);
  }
});

test('英文技术异常及内部地址使用简洁中文兜底', () => {
  for (const error of [new Error('TypeError: Failed to fetch'), 'Error invoking remote method \'desktop:collect-platform-account\': Error: socket hang up', new Error('读取失败 https://internal.example/api'), { message: 'ECONNRESET' }, undefined]) {
    assert.equal(formatPlatformSyncError(error), '同步暂时中断，请稍后重试');
  }
});

test('旧客户端可靠前缀保留各来源数量，并合并相同的部分读取诊断', () => {
  const message = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 20, requestedCount: 50, coverage: 'partial', orderReliable: true, warning: '官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试' },
    { sourceLabel: '收藏', acceptedCount: 10, requestedCount: 50, coverage: 'partial', orderReliable: true, warning: '官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试' },
  ]);
  assert.match(message, /喜欢：已同步 20\/50 条/);
  assert.match(message, /收藏：已同步 10\/50 条/);
  assert.equal(message.match(/剩余视频未同步/g)?.length, 1);
  assert.doesNotMatch(message, /官方列表|顺序|保留/);
});

test('新客户端常规部分读取提示也归并，零条不冒充已完整同步', () => {
  for (const warning of ['已按官方顺序读取前 10 条，其余作品本次未读取；历史资料保留', '官方列表暂未返回可确认顺序的作品；历史资料保留']) {
    const message = formatPlatformSyncSourceResults([
      { sourceLabel: '收藏', acceptedCount: warning.includes('10') ? 10 : 0, requestedCount: 50, coverage: 'partial', orderReliable: true, warning },
    ]);
    assert.equal(message.match(/剩余视频未同步/g)?.length, 1);
    if (!warning.includes('10')) assert.match(message, /尚未同步/);
    assert.doesNotMatch(message, /官方|顺序|保留|已保存全部/);
  }
});

test('正常范围与完整成功由同步摘要展示，不重复追加提示', () => {
  const limited = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 50, requestedCount: 50, coverage: 'limited', orderReliable: true, warning: '本次读取前 50 条，未扫描全部作品' },
  ]);
  assert.equal(limited, '');
  const complete = formatPlatformSyncSourceResults([
    { sourceLabel: '作品', acceptedCount: 3, requestedCount: 50, coverage: 'complete', orderReliable: true },
  ]);
  assert.equal(complete, '');
  assert.equal(platformSyncWarning({ coverage: 'limited', orderReliable: true }), '');
});

test('不可靠来源不声称前N，真实鉴权及风控诊断不能被标准化隐藏', () => {
  const message = formatPlatformSyncSourceResults([
    { sourceLabel: '喜欢', acceptedCount: 5, requestedCount: 50, coverage: 'partial', orderReliable: false, warning: '请重新验证账号' },
    { sourceLabel: '收藏', acceptedCount: 20, requestedCount: 20, coverage: 'limited', orderReliable: true, warning: '风控限制，请等待 5 分钟后重试' },
  ]);
  assert.match(message, /喜欢：已同步 5\/50 条/);
  assert.match(message, /请完成账号验证后继续同步/);
  assert.match(message, /请等待 5 分钟后重试/);
  assert.doesNotMatch(message, /顺序|风控|保留/);
});

test('未确认完成或非标准异常仍显示下一步，不当作普通成功省略', () => {
  assert.match(platformSyncWarning({ coverage: 'complete', orderReliable: false }), /同步还未完成，请重试/);
  assert.match(platformSyncWarning({ coverage: 'complete', orderReliable: true, warning: '登录已失效' }), /重新登录/);
  assert.match(platformSyncWarning({ coverage: 'complete', orderReliable: true, warning: 'IPC公开资料校验失败' }), /未同步，请重试/);
});
