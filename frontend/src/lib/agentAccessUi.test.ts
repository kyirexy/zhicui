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

  assert.match(component, /网页只负责授权和配置，不提供命令终端/);
  assert.match(component, /npx @zhicui\/cli auth login/);
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
  assert.match(component, /Agent 接入尚未在当前环境开放/);
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
