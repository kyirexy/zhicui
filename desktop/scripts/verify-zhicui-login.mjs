import assert from 'node:assert/strict';
import { ZhicuiWebLogin } from '../dist/zhicui-login.js';
const session = { token: 'test-handoff', user: { id: 'one' } };
const stages = [];
let polls = 0, saves = 0, persisted = false;
const login = new ZhicuiWebLogin(() => 'https://luxai.cn', status => {
  if (status.stage === 'success') assert(persisted, '持久化前不能声称成功');
  stages.push(status.stage);
}, async received => {
  assert.equal(received.token, session.token);
  if (++saves === 1) throw new Error('SESSION_TEMPORARY');
  persisted = true;
}, { pollIntervalMs: 1, timeoutMs: 1000, openExternal: async () => {}, fetch: async url => {
  if (url.endsWith('/request')) return Response.json({success:true});
  polls++;
  return Response.json({success:true, data:{status:'success', ...session}});
} });
assert.equal((await login.start()).success, true);
assert.equal(polls, 1, '票据消费后只重试保存，不重新轮询');
assert.equal(saves, 2);
assert.equal(stages.at(-1), 'success');

// 等待期间取消能结束原Promise，不干扰下一次尝试。
let waiting;
const reached = new Promise(resolve => { waiting = resolve; });
const cancellable = new ZhicuiWebLogin(() => 'https://luxai.cn', () => {}, async () => { throw new Error('不应保存'); }, {
  pollIntervalMs: 1000, openExternal: async () => {}, fetch: async url => {
    if (url.endsWith('/request')) return Response.json({success:true});
    waiting(); return Response.json({success:true, data:{status:'pending'}});
  },
});
const pending = cancellable.start();
await reached;
await cancellable.cancel();
const cancelled = await pending;
assert.equal(cancelled.cancelled, true);
console.log('网页登录：持久化确认、原凭据重试、取消唤醒全部通过');
