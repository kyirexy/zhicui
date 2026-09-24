import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  agentCredentialPrefix,
  canRunLocalAgentActions,
  canShowAgentInstallGuide,
  isActiveAgentConnection,
  resolveAgentAccessPlatform,
  safeAgentScopes,
} from './agentAccessUi.ts';

const directory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(directory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('Windows 才显示本机 Agent 动作，Android 只管理授权', () => {
  assert.equal(resolveAgentAccessPlatform({ desktop: true, android: false }), 'windows');
  assert.equal(resolveAgentAccessPlatform({ desktop: false, android: true }), 'android');
  assert.equal(resolveAgentAccessPlatform({ desktop: false, android: false }), 'web');
  assert.equal(canRunLocalAgentActions('windows'), true);
  assert.equal(canRunLocalAgentActions('web'), false);
  assert.equal(canRunLocalAgentActions('android'), false);
  assert.equal(canShowAgentInstallGuide('android'), false);
  assert.equal(canShowAgentInstallGuide('web'), true);
});

test('Agent scope 在客户端再次过滤管理端和秘密能力', () => {
  assert.deepEqual(
    safeAgentScopes([
      'library:read',
      'creator:sync',
      'library:read',
      'admin:users',
      'shell:exec',
      'cookie:read',
      'api-key:read',
      '',
    ]),
    ['creator:sync', 'library:read'],
  );
});

test('凭证列表只使用非敏感前缀与生命周期元数据', () => {
  assert.equal(agentCredentialPrefix({ token_prefix: 'zc_agent_abcd' }), 'zc_agent_abcd');
  assert.equal(isActiveAgentConnection({ revoked_at: null, expires_at: null }), true);
  assert.equal(isActiveAgentConnection({ revoked_at: '2026-09-01T00:00:00Z', expires_at: null }), false);
  assert.equal(isActiveAgentConnection({ revoked_at: null, expires_at: '2020-01-01T00:00:00Z' }), false);
});

test('接入中心没有网页终端，PAT 仅保存在一次性 UI state', () => {
  const component = read('components/AgentAccessSettingsCard.tsx');
  const css = read('components/AgentAccessSettingsCard.module.css');

  assert.match(component, /推荐使用上方的客户端安装连接/);
  assert.doesNotMatch(component, /npx @zhicui\/cli auth login|npm install -g/);
  assert.match(component, /本地 stdio MCP/);
  assert.doesNotMatch(component, /Beta|@beta/);
  assert.match(component, /codex mcp add zhicui --url https:\/\/luxai\.cn\/mcp --bearer-token-env-var ZHICUI_AGENT_TOKEN/);
  assert.match(component, /Codex 配置只保存变量名，不保存令牌明文/);
  assert.doesNotMatch(component, /Authorization:\s*Bearer|ZHICUI_AGENT_TOKEN=/);
  assert.match(component, /call\.credential_prefix/);
  assert.doesNotMatch(component, /<textarea|contentEditable|xterm|terminal emulator/i);
  assert.match(component, /const \[oneTimeToken, setOneTimeToken\] = useState<string \| null>\(null\)/);
  assert.match(component, /setOneTimeToken\(null\)/);
  assert.match(component, /完整令牌只显示这一次/);
  assert.match(component, /typeof window === 'undefined'/);
  assert.match(component, /确认吊销/);
  assert.match(component, /INTERFACE_DISABLED/);
  assert.match(component, /AgentQuickConnect/);
  assert.match(component, /!interfaceDisabled &&/);
  assert.match(component, /getAgentDeviceAuthorizationRequest/);
  assert.match(component, /submitDeviceApproval\(false\)/);
  assert.match(component, /deviceRequestPreview\.client_name/);
  assert.match(component, /deviceRequestPreview\.scopes\.map/);
  assert.match(component, /待确认的敏感操作/);
  assert.match(component, /getAgentPendingConfirmation/);
  assert.match(component, /approveAgentPendingConfirmation/);
  assert.match(component, /rejectAgentPendingConfirmation/);
  assert.match(component, /不会返回或展示原始输入/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test('Agent API 的列表结构不携带 token，创建结果单独声明一次性 token', () => {
  const api = read('lib/agentInterfaceApi.ts');
  const credentialBlock = api.match(/export interface AgentCredential \{[\s\S]*?\n\}/)?.[0] || '';
  const createBlock = api.match(/export interface AgentPatCreateResult \{[\s\S]*?\n\}/)?.[0] || '';

  assert.doesNotMatch(credentialBlock, /\btoken:\s*string/);
  assert.match(createBlock, /token:\s*string/);
  assert.doesNotMatch(api, /admin\/|shell\.exec|cookie_value|jwt_secret/i);
  const confirmationBlock = api.match(/export interface AgentPendingConfirmation \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(confirmationBlock, /input_hash|raw_input|\binput:/);
  assert.match(api, /INTERFACE_DISABLED/);
});

test('PAT 创建在首屏连接区始终可见，服务关闭时只禁用创建而不隐藏入口', () => {
  const component = read('components/AgentAccessSettingsCard.tsx');
  const patPosition = component.indexOf('id="personal-access-token"');
  assert.ok(patPosition > component.indexOf('<AgentQuickConnect'));
  assert.ok(patPosition < component.indexOf('aria-labelledby="device-authorization-title"'));
  assert.doesNotMatch(component, /高级接入：个人访问令牌/);
  assert.match(component, /disabled=\{creating \|\| loading \|\| interfaceDisabled \|\| Boolean\(oneTimeToken\)\}/);
  assert.match(component, /当前环境的 Agent 接口尚未启用/);
  assert.doesNotMatch(component, /localStorage\.setItem|sessionStorage\.setItem|console\.log/);
});

test('独立授权页与旧设置入口衔接，网页不再只能下载客户端', () => {
  const page = read('app/agent-access/page.tsx');
  const settings = read('app/settings/page.tsx');
  const quickConnect = read('components/AgentQuickConnect.tsx');
  const guard = read('components/AuthGuard.tsx');
  assert.match(page, /AgentAccessSettingsCard/);
  assert.match(settings, /router\.push\('\/agent-access'\)/);
  assert.match(guard, /pathname === '\/settings' && params\.get\('section'\) === 'agent'/);
  assert.match(quickConnect, /<code>\{loginCommand\}<\/code>/);
  assert.match(quickConnect, /输入设备授权码/);
});

test('基础接入提示公开链接能力和按需写入授权，默认权限保持不变', () => {
  const component = read('components/AgentAccessSettingsCard.tsx');
  const quickConnect = read('components/AgentQuickConnect.tsx');
  const prompt = read('lib/agentQuickConnect.ts');
  assert.match(component, /capabilities\?\.release_profile === 'core'/);
  assert.match(component, /capabilities \? capabilities\.scopes : FALLBACK_SCOPES/);
  assert.match(component, /基础接入 · 公开链接提取、资料问答、知识与计划/);
  assert.match(component, /默认只读查看资料/);
  assert.match(component, /获得“整理资料（library:write）”授权后/);
  assert.match(component, /你指定的抖音\/B站公开链接导入资料、提取文稿和下载视频/);
  assert.match(component, /暂不开放平台账号批量同步、本机桥接或视觉自动化/);
  assert.match(component, /useState<string\[\]>\(\['library:read'\]\)/);
  assert.doesNotMatch(component, /平台同步、视频下载和新文稿提取请先在知萃客户端完成/);
  assert.match(quickConnect, /coreAccess \? AGENT_CORE_HANDOFF_PROMPT/);
  assert.match(quickConnect, /导入链接、提取文稿和下载视频前，按需追加 library:write 授权/);
  assert.match(read('components/AgentDeviceAuthorizationCard.tsx'), /整理资料库（导入公开链接、提取文稿和下载视频）/);
  const command = prompt.match(/CORE_AGENT_LOGIN_COMMAND = '([^']+)'/)?.[1] || '';
  assert.match(command, /ask:run/);
  assert.doesNotMatch(command, /creator:sync|library:write|analysis:|local:invoke/);
});

test('桌面网页登录交接保留不透明 Agent 账号标识并立即绑定', () => {
  const runtime = read('lib/desktopRuntime.ts');
  const auth = read('lib/hooks/AuthContext.tsx');

  assert.match(runtime, /interface DesktopZhicuiUser[\s\S]*?agent_profile_key\?: string/);
  assert.match(
    auth,
    /agent_profile_key: session\.user\?\.agent_profile_key \|\| undefined/,
  );
  assert.match(auth, /bridge\.bindAgentUser\(user\?\.agent_profile_key \|\| null\)/);
});
