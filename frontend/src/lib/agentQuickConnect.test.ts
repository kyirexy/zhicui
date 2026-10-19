import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_CORE_HANDOFF_PROMPT, AGENT_HANDOFF_PROMPT, CORE_AGENT_LOGIN_COMMAND, VIDEO_AGENT_LOGIN_COMMAND, VIDEO_AGENT_HANDOFF_PROMPT, DAILY_AGENT_SCOPES, READ_ONLY_AGENT_SCOPES, agentConnectionStep, agentPresetScopes, agentLoginCommand, agentPromptForCommand } from './agentQuickConnect.ts';

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
  assert.match(AGENT_HANDOFF_PROMPT, /由我在知萃确认/);
  assert.doesNotMatch(AGENT_HANDOFF_PROMPT, /npm install|npx |cli-acceptance|Bearer\s+/);
});

test('基础接入提示词允许指定公开链接操作，并要求先取得写入权限', () => {
  for (const action of ['library.import_link', 'library.transcript.generate', 'library.media.download']) {
    assert.ok(AGENT_CORE_HANDOFF_PROMPT.includes(action));
  }
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /抖音、B站公开链接/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /只处理我明确指定的公开链接/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /操作前检查可用能力，并确认已获得 library:write 授权/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /不要自动扩大已有凭据的权限/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /先查询任务进度/);
  assert.doesNotMatch(AGENT_CORE_HANDOFF_PROMPT, /不支持平台同步、链接导入、视频下载、文稿提取|先在知萃客户端完成提取/);
});

test('日常连接一次申请视频和问答需要的权限，能力仍由服务开放情况决定', () => {
  assert.equal(CORE_AGENT_LOGIN_COMMAND, "zhicui auth login --scopes 'account:read,library:read,library:write,creator:read,ask:read,ask:run,local:invoke'");
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /请先只读查看我的资料/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /未开放的平台账号批量同步、本机桥接或视觉自动化不可调用/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /优先复用已有有效连接/);
  assert.match(AGENT_CORE_HANDOFF_PROMPT, /不要读取或展示密码、Cookie、JWT、访问令牌或 API Key/);
});

test('视频与日常连接共用权限预设，优先复用已登录桌面确认同一个授权请求', () => {
  assert.equal(VIDEO_AGENT_LOGIN_COMMAND, CORE_AGENT_LOGIN_COMMAND);
  assert.match(VIDEO_AGENT_HANDOFF_PROMPT, /--connect/);
  assert.match(VIDEO_AGENT_HANDOFF_PROMPT, /未指定视频前不要运行提取/);
  assert.match(VIDEO_AGENT_HANDOFF_PROMPT, /素材就绪不代表复刻视频已经生成/);
  for (const prompt of [AGENT_HANDOFF_PROMPT, AGENT_CORE_HANDOFF_PROMPT, VIDEO_AGENT_HANDOFF_PROMPT]) {
    assert.match(prompt, /优先使用已登录且支持授权的桌面客户端/);
    assert.match(prompt, /同一个授权请求进入网页/);
    assert.doesNotMatch(prompt, /在浏览器|知萃浏览器页面/);
  }
});

test('日常预设仅申请服务当前可用范围，不自动加入额外写入或管理员权限', () => {
  assert.deepEqual(agentPresetScopes('daily', [...DAILY_AGENT_SCOPES, 'creator:sync', 'models:write', 'admin:users']), [...DAILY_AGENT_SCOPES]);
  const core = ['account:read', 'library:read', 'library:write', 'ask:read', 'ask:run'];
  assert.deepEqual(agentPresetScopes('daily', core), core);
  assert.deepEqual(agentPresetScopes('daily', []), []);
  assert.equal(agentLoginCommand(agentPresetScopes('daily', [])), '');
});

test('显式只读与自定义不会回退为日常权限，已有选择不会被扩大', () => {
  assert.deepEqual(agentPresetScopes('read-only', DAILY_AGENT_SCOPES), [...READ_ONLY_AGENT_SCOPES]);
  assert.deepEqual(agentPresetScopes('custom', DAILY_AGENT_SCOPES, ['library:read']), ['library:read']);
  assert.deepEqual(agentPresetScopes('custom', DAILY_AGENT_SCOPES, []), []);
  assert.deepEqual(agentPresetScopes('custom', ['library:read'], ['library:read', 'library:write']), ['library:read']);
  const readOnlyCommand = agentLoginCommand(agentPresetScopes('read-only', DAILY_AGENT_SCOPES));
  assert.doesNotMatch(readOnlyCommand, /library:write|ask:run|local:invoke/);
  const prompt = agentPromptForCommand(VIDEO_AGENT_HANDOFF_PROMPT, readOnlyCommand, 'read-only');
  assert.ok(prompt.includes(readOnlyCommand));
  assert.ok(!prompt.includes(CORE_AGENT_LOGIN_COMMAND));
  assert.match(prompt, /明确选择只读连接/);
});

test('生成命令拒绝非法scope字符，不用空参数触发CLI默认授权', () => {
  assert.equal(agentLoginCommand([]), '');
  assert.equal(agentLoginCommand(["library:read'; echo unexpected", 'library:read', 'library:read']), "zhicui auth login --scopes 'library:read'");
});
