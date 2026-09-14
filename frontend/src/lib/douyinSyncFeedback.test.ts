import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatCollectionSyncMessage,
  createSyncNoticeReporter,
  formatTranscriptPreparationProgress,
  formatDouyinSyncError,
  formatMultiSourceSyncSummary,
  hasDouyinSyncFailureDiagnostic,
} from './douyinSyncFeedback.ts';

test('收藏暂不可同步时保留明确重试时间', () => {
  const message = formatCollectionSyncMessage({
    status: 'failed',
    error: 'source blocked',
    error_code: 'source_blocked',
    retry_after_seconds: 901,
    sourceLabel: '收藏',
    requestedCount: 50,
  });

  assert.match(message, /收藏暂时无法同步/);
  assert.match(message, /约 16 分钟后再试/);
});

test('账号验证提示不伪装成连接器离线', () => {
  const message = formatDouyinSyncError('challenge', '收藏', {
    error_code: 'verification_required',
    needs_action: true,
  });

  assert.match(message, /请在抖音完成验证/);
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

  assert.match(message, /收藏暂时无法同步/);
  assert.match(message, /约 5 分钟后再试/);
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

  assert.match(message, /请在抖音完成验证/);
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

  assert.match(message, /还没有同步到喜欢/);
  assert.match(message, /确认列表后重试/);
  assert.doesNotMatch(message, /同步成功|已同步/);
});

test('收藏缺少最终登录信息时给出简短登录提示', () => {
  const message = formatDouyinSyncError(
    '收藏登录信息不完整，请重新连接抖音账号后再试',
    '收藏',
    {
      error_code: 'argus_uifid_missing',
      needs_action: true,
    },
  );

  assert.match(message, /重新登录抖音后同步收藏/);
  assert.doesNotMatch(message, /UIFID|读取条件|我的作品/);
  assert.doesNotMatch(message, /同步成功/);
});

test('新的结构化风控码保留来源和重试时间', () => {
  const message = formatDouyinSyncError('blocked', '喜欢', {
    error_code: 'risk_controlled',
    retry_after_seconds: 120,
  });

  assert.match(message, /喜欢暂时无法同步/);
  assert.match(message, /约 2 分钟后再试/);
});

test('混合同步只把真实成功来源计入成功数量', () => {
  const message = formatMultiSourceSyncSummary([
    {
      sourceLabel: '喜欢',
      checked: 5,
      newlyVisible: 2,
    },
    {
      sourceLabel: '收藏',
      checked: 0,
      newlyVisible: 0,
      error: '收藏读取条件未完成，请重新连接账号',
    },
  ]);

  assert.match(message, /已同步 5 条/);
  assert.match(message, /新显示 2 条/);
  assert.match(message, /收藏：请重新登录抖音/);
  assert.doesNotMatch(message, /已同步 2 个来源/);
});

test('新版同步反馈使用服务端新增与复用计数，不把重新出现的历史项算新增', () => {
  const message = formatMultiSourceSyncSummary([
    { sourceLabel: '收藏', checked: 10, newlyVisible: 5, created: 1, reused: 9 },
    { sourceLabel: '喜欢', checked: 5, newlyVisible: 3, created: 0, reused: 5 },
  ]);
  assert.match(message, /新增 1 条/);
  assert.match(message, /已有 14 条/);
  assert.doesNotMatch(message, /新显示|复用|历史资料|检查/);
});

test('同步摘要保留新增复用数量，跟随实际后台进度并拒绝过期回调', () => {
  let generation = 1;
  const notices: string[] = [];
  const summary = formatMultiSourceSyncSummary([
    { sourceLabel: '喜欢', checked: 20, newlyVisible: 0, created: 0, reused: 20 },
    { sourceLabel: '收藏', checked: 10, newlyVisible: 10, created: 10, reused: 0 },
  ]);
  const report = createSyncNoticeReporter(summary, () => generation === 1, (message) => notices.push(message));
  report(formatTranscriptPreparationProgress({ status: 'running', total: 10, success: 9, failed: 0, active: 1, queued: 0 }));
  assert.match(notices[0], /新增 10 条/);
  assert.match(notices[0], /已有 20 条/);
  assert.match(notices[0], /文案准备中 · 已完成 9\/10/);
  report('文稿任务未启动：提交失败');
  assert.match(notices[1], /新增 10 条[\s\S]*文稿任务未启动/);
  generation = 2;
  report(formatTranscriptPreparationProgress({ status: 'success', total: 10, success: 10, failed: 0 }));
  assert.equal(notices.length, 2);
});

test('总进度优先，不把4个并发槽显示为待处理总数', () => {
  const message = formatTranscriptPreparationProgress({ status: 'running', total: 50, success: 8, failed: 0, active: 4, queued: 38 });
  assert.equal(message, '文案准备中 · 已完成 8/50');
  assert.doesNotMatch(message, /4|处理中|排队/);
});

test('精简文案仍提示未完成数量及失败后可执行的操作', () => {
  assert.match(formatTranscriptPreparationProgress({ status: 'partial', total: 50, success: 47, failed: 3 }), /47\/50，3 条未完成，可重试/);
  assert.match(formatTranscriptPreparationProgress({ status: 'failed', total: 50, success: 8, failed: 42, error: 'API余额不足' }), /8\/50，请检查可用额度后重试/);
  assert.match(formatDouyinSyncError('RuntimeError: 没有读取到抖音官方分类首屏；需确认可信顺序', '喜欢'), /请打开抖音的“喜欢”/);
  assert.doesNotMatch(formatDouyinSyncError('IPC公开资料校验失败', '收藏'), /IPC|公开资料/);
  assert.equal(formatDouyinSyncError('本机读取已取消', '喜欢'), '已取消同步。');
});
