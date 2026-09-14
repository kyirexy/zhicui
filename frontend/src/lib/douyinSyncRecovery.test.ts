import assert from 'node:assert/strict';
import test from 'node:test';
import { getDouyinSyncRecoveryIssue, updateDouyinSyncRecovery } from './douyinSyncRecovery.ts';

test('旧客户端首屏错误给出当前来源与原数量，不误判为必然验证码', () => {
  const result = getDouyinSyncRecoveryIssue({ mode: 'like', count: 20, phase: 'failed',
    error: '没有读取到抖音官方分类首屏；请确认本人主页和对应标签，完成官方验证后重试' });
  assert.deepEqual(result, { mode: 'like', count: 20, phase: 'failed', reason: 'first-page' });
});

test('新客户端结构化代码不依赖错误文案', () => {
  assert.equal(getDouyinSyncRecoveryIssue({ mode: 'collect', count: 50, phase: 'waiting',
    code: 'DOUYIN_SOURCE_FIRST_PAGE_REQUIRED', error: '等待页面' })?.reason, 'first-page');
});

test('1.1.4 无结构化代码的等待事件也能及时显示引导', () => {
  assert.equal(getDouyinSyncRecoveryIssue({ mode: 'like', count: 50, phase: 'waiting',
    error: '抖音官方页面尚未就绪；请确认已进入本人主页，如有验证请完成，随后会继续读取“喜欢”' })?.reason, 'target-list');
});

test('区分标签、登录与离开本人主页，并排除取消和普通服务器错误', () => {
  const input = { mode: 'like' as const, count: 50, phase: 'failed' as const };
  assert.equal(getDouyinSyncRecoveryIssue({ ...input, error: '没有找到抖音“喜欢”列表' })?.reason, 'target-list');
  assert.equal(getDouyinSyncRecoveryIssue({ ...input, error: '账号登录已失效，请先重新登录' })?.reason, 'login');
  assert.equal(getDouyinSyncRecoveryIssue({ ...input, error: '同步期间离开了本人抖音主页或切换了账号' })?.reason, 'profile');
  assert.equal(getDouyinSyncRecoveryIssue({ ...input, error: '服务器登记失败' }), null);
  assert.equal(getDouyinSyncRecoveryIssue({ ...input, code: 'DOUYIN_SOURCE_FIRST_PAGE_REQUIRED', cancelled: true }), null);
});

test('收藏成功不覆盖喜欢待恢复，重试失败只替换同来源状态', () => {
  const like = getDouyinSyncRecoveryIssue({ mode: 'like', count: 20, phase: 'failed', code: 'DOUYIN_SOURCE_FIRST_PAGE_REQUIRED' })!;
  const collect = { ...like, mode: 'collect' as const, phase: 'waiting' as const };
  assert.deepEqual(updateDouyinSyncRecovery([like, collect], 'collect', null), [like]);
  assert.deepEqual(updateDouyinSyncRecovery([like], 'like', { ...like, phase: 'waiting' }), [{ ...like, phase: 'waiting' }]);
});
