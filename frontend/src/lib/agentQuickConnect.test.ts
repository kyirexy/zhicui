import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CORE_HANDOFF_PROMPT, AGENT_HANDOFF_PROMPT, CORE_AGENT_LOGIN_COMMAND, agentConnectionStep } from './agentQuickConnect.ts';

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

test('基础接入提示词允许指定公开链接操作，并要求先取得写入权限', () => {
  for (const action of ['library.import_link', 'library.transcript.generate', 'library.media.download']) {
    assert.ok(AGENT_CORE_HANDOFF_PROMPT.includes(action));
  }
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /抖音、B站公开链接/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /只处理我明确指定的公开链接/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /操作前检查可用能力，并确认已获得 library:write 授权/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /不要自动扩大默认权限/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /先查询任务进度/);
  assert.doesNotMatch(AGENT_CORE_HANDOFF_PROMPT, /不支持平台同步、链接导入、视频下载、文稿提取|先在知萃客户端完成提取/);
});

test('基础接入默认命令不包含写入权限，平台批量同步和本机自动化仍未开放', () => {
  assert.equal(CORE_AGENT_LOGIN_COMMAND, 'zhicui auth login --scopes account:read,library:read,ask:read,ask:run');
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /请先只读查看我的资料/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /仍不开放平台账号批量同步、本机桥接（bridge）或视觉自动化/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /不要读取或展示密码、Cookie、JWT、访问令牌或 API Key/);
});
