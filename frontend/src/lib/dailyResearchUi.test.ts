import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultResearchSubscription, isResearchRunActive, normalizeResearchTopics, researchCoverageLabel, researchDate, researchDeliveryLabel, researchRunLabel, safeResearchSourceUrl, validateResearchSubscription } from './dailyResearchUi.ts';
import { DESKTOP_PRODUCT_DESTINATIONS, PRODUCT_DESTINATIONS, isDesktopProductDestinationActive } from './productNavigation.ts';

test('新订阅使用每日15:00抖音双来源和两日首次发现，不预填个人偏好', () => {
  const subscription = defaultResearchSubscription('member@example.com');
  assert.equal(subscription.schedule_time, '15:00');
  assert.equal(subscription.timezone, 'Asia/Shanghai');
  assert.deepEqual(subscription.platforms, ['douyin']);
  assert.deepEqual(subscription.source_modes, ['like', 'collect']);
  assert.equal(subscription.window_days, 2);
  assert.equal(subscription.sync_limit, 500);
  assert.equal(subscription.recipient_email, 'member@example.com');
  assert.deepEqual(subscription.focus_topics, []);
  assert.equal(defaultResearchSubscription().recipient_email, '');
});

test('没有邮箱可以保存站内报告，非法时间范围和来源提前阻止', () => {
  const subscription = defaultResearchSubscription();
  assert.equal(validateResearchSubscription(subscription), null);
  assert.match(validateResearchSubscription({ ...subscription, recipient_email: 'not-an-email' })!, /邮箱/);
  assert.match(validateResearchSubscription({ ...subscription, schedule_time: '24:30' })!, /时间/);
  assert.match(validateResearchSubscription({ ...subscription, timezone: 'Mars/Base' })!, /时区/);
  assert.match(validateResearchSubscription({ ...subscription, platforms: ['bilibili'] })!, /仅支持抖音/);
  assert.match(validateResearchSubscription({ ...subscription, source_modes: [] })!, /喜欢或收藏/);
  assert.match(validateResearchSubscription({ ...subscription, window_days: 1 })!, /近 2 日/);
  assert.match(validateResearchSubscription({ ...subscription, sync_limit: 501 })!, /上限/);
  assert.match(validateResearchSubscription({ ...subscription, sync_limit: Number.NaN })!, /上限/);
});

test('等待桌面或平台验证仍是活动运行，投递中不显示完成', () => {
  assert.equal(isResearchRunActive({ status: 'waiting_for_desktop', delivery_status: 'skipped' }), true);
  assert.equal(researchRunLabel({ status: 'syncing', stage: 'waiting_for_user', delivery_status: 'skipped' }), '需要完成平台验证');
  assert.equal(researchRunLabel({ status: 'completed', stage: 'completed', delivery_status: 'delivering' }), '正在投递邮件');
  assert.equal(isResearchRunActive({ status: 'completed', delivery_status: 'delivering' }), true);
  assert.equal(isResearchRunActive({ status: 'partial', delivery_status: 'verification_required' }), false);
  assert.equal(researchRunLabel({ status: 'failed', stage: 'researching', delivery_status: 'skipped' }), '研究失败');
  assert.equal(researchRunLabel({ status: 'new_future_state', stage: 'future_stage', delivery_status: '' }), '状态待确认');
});

test('覆盖上限和邮件未验证不会显示已读完或发送成功', () => {
  assert.equal(researchCoverageLabel('limited'), '已达本次同步上限');
  assert.equal(researchCoverageLabel('partial'), '仅获取部分来源');
  assert.equal(researchDeliveryLabel('verification_required'), '收件邮箱未验证');
  assert.equal(researchDeliveryLabel('not_configured'), '邮件服务未配置');
  assert.equal(researchDeliveryLabel('unknown'), '邮件投递状态待确认');
  assert.equal(researchDeliveryLabel('sent'), '邮件已发送');
});

test('来源链接拒绝脚本协议和含凭证链接', () => {
  assert.equal(safeResearchSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeResearchSourceUrl('data:text/html,hello'), null);
  assert.equal(safeResearchSourceUrl('https://username:secret@example.com/path'), null);
  assert.equal(safeResearchSourceUrl('https://www.douyin.com/video/123456'), 'https://www.douyin.com/video/123456');
});

test('UTC接口时间统一以北京时间展示，主题去重并符合后端数量约束', () => {
  assert.equal(researchDate('2026-10-13T07:00:00'), researchDate('2026-10-13T07:00:00Z'));
  assert.match(researchDate('2026-10-13T07:00:00Z'), /15:00/);
  assert.equal(researchDate('bad-date'), '时间待确认');
  assert.deepEqual(normalizeResearchTopics('拍摄,拍摄，剪辑\n摄影'), ['拍摄', '剪辑', '摄影']);
  assert.equal(normalizeResearchTopics(Array.from({ length: 20 }, (_, index) => `主题${index}`).join(',')).length, 12);
});

test('每日研究有独立桌面入口，移动端仍保留五个主Tab', () => {
  assert.equal(DESKTOP_PRODUCT_DESTINATIONS.find((item) => item.id === 'daily-research')?.href, '/daily-research');
  assert.equal(isDesktopProductDestinationActive('daily-research', '/daily-research'), true);
  assert.equal(isDesktopProductDestinationActive('knowledge', '/daily-research'), false);
  assert.equal(isDesktopProductDestinationActive('daily-research', '/harness'), false);
  assert.equal(PRODUCT_DESTINATIONS.length, 5);
});
