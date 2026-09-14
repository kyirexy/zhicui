import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_HANDOFF_PROMPT, agentConnectionStep } from './agentQuickConnect.ts';

const base = { loading: false, interfaceDisabled: false, supportsAuthorization: true };

test('服务未开放时仍能准备本机安装，但不会误报连接完成', () => {
  const pending = agentConnectionStep({ ...base, interfaceDisabled: true });
  assert.equal(pending.action, 'setup');
  const installed = agentConnectionStep({ ...base, interfaceDisabled: true, status: { configured: true, ready: true } });
  assert.equal(installed.ready, false);
  assert.match(installed.description, /尚未开放/);
});

test('配置成功之后必须独立授权，旧客户端不能调用新授权指令', () => {
  const status = { configured: true, managed: true, authenticated: false };
  assert.equal(agentConnectionStep({ ...base, status }).action, 'authorize');
  const legacy = agentConnectionStep({ ...base, status, supportsAuthorization: false });
  assert.equal(legacy.action, 'doctor');
  assert.match(legacy.description, /更新知萃客户端/);
  const restricted = agentConnectionStep({ ...base, status: { ...status, code: 'ROLLOUT_RESTRICTED' } });
  assert.equal(restricted.action, 'doctor');
  assert.match(restricted.description, /无需重复授权/);
});

test('仅全部检查通过才能显示可用，缺字段或服务失败仍需检查', () => {
  const status = { configured: true, authenticated: true, cloud_available: true, mcp_healthy: true, ready: true };
  assert.equal(agentConnectionStep({ ...base, status }).ready, true);
  for (const key of ['authenticated', 'cloud_available', 'mcp_healthy', 'ready']) {
    assert.equal(agentConnectionStep({ ...base, status: { ...status, [key]: false } }).ready, false);
  }
  assert.equal(agentConnectionStep({ ...base, status: { configured: true } }).ready, false);
});

test('提示词要求真实工具发现和用户授权，不依赖公开npm安装或旧测试路径', () => {
  assert.match(AGENT_HANDOFF_PROMPT, /先检查当前会话/);
  assert.match(AGENT_HANDOFF_PROMPT, /由我在知萃客户端确认/);
  assert.doesNotMatch(AGENT_HANDOFF_PROMPT, /npm install|npx |cli-acceptance|Bearer\s+/);
});
