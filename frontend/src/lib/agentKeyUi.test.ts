import assert from 'node:assert/strict';
import test from 'node:test';
import { agentConnectionUsage, agentCredentialLifetime, agentKeyHandoffPrompt } from './agentKeyUi.ts';

test('密钥交接指定无回显标准输入，命令不包含密钥且不发起设备授权', () => {
  const key = 'synthetic-agent-key-for-test';
  const prompt = agentKeyHandoffPrompt(key);
  assert.equal(prompt.split(key).length - 1, 1);
  const commandLine = prompt.split('\n').find((line) => line.includes('zhicui connect')) || '';
  assert.match(commandLine, /connect --pat-stdin --client codex --non-interactive --json/);
  assert.ok(!commandLine.includes(key));
  assert.match(prompt, /不需要设备授权码/);
  assert.match(prompt, /后续复用已有连接，不要重复登录/);
  assert.match(prompt, /知萃已启动且登录同一账号/);
  assert.doesNotMatch(prompt, /auth login|--force/);
});

test('新建但未用过的连接不会显示已连接，只读连接不被标记可写', () => {
  assert.equal(agentConnectionUsage({ scopes: ['library:read', 'library:write'], last_used_at: null }), '等待 Agent 使用');
  assert.equal(agentConnectionUsage({ scopes: ['library:read', 'library:write'], last_used_at: '2026-10-19T10:00:00Z' }), '已有使用记录');
  assert.equal(agentConnectionUsage({ scopes: ['account:read', 'library:read'], last_used_at: '2026-10-19T10:00:00Z' }), '仅可读取资料');
  assert.equal(agentConnectionUsage({ scopes: ['library:read', 'ask:run'], last_used_at: null }), '等待 Agent 使用');
});

test('只有服务返回滑动期限时才显示自动延续，旧PAT保留固定期限', () => {
  assert.equal(agentCredentialLifetime({ expiry_policy: 'sliding_inactivity', inactivity_days: 365, expires_at: '2027-10-19T10:00:00Z' }), '使用时自动延续，连续 365 天未使用后失效');
  assert.match(agentCredentialLifetime({ expiry_policy: 'fixed', inactivity_days: null, expires_at: '2027-01-17T10:00:00Z' }), /到期$/);
  assert.doesNotMatch(agentCredentialLifetime({ expires_at: '2027-01-17T10:00:00Z' }), /自动延续/);
  assert.equal(agentCredentialLifetime({ expires_at: null }), '以服务端有效期为准');
});
