import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DAILY_AGENT_SCOPES, desktopAuthorizationUrl, grantedScopeSnapshot,
} from '../dist/connection-policy.js';
import { action } from './helpers.mjs';

const origin = 'https://luxai.cn';
const readyDesktop = {
  available: true,
  zhicui_login: 'ready',
  agent_authorization: { supported: true, server_origin: origin },
};

test('日常连接预设只包含约定的七项权限', () => {
  assert.deepEqual(DAILY_AGENT_SCOPES, [
    'account:read', 'library:read', 'library:write', 'creator:read',
    'ask:read', 'ask:run', 'local:invoke',
  ]);
});

test('实际 grants 独立于发布目录，并优先于动作推导', () => {
  const capabilities = {
    api_version: 'v1',
    granted_scopes: ['library:read', 'account:read', 'library:read'],
    scopes: [{ id: 'library:write' }, { id: 'creator:sync' }],
    actions: [action('library.import_link', { scopes: ['library:write'] })],
  };
  assert.deepEqual(grantedScopeSnapshot(capabilities), {
    scopes: ['account:read', 'library:read'], scopes_source: 'server', scopes_complete: true,
  });
  assert.deepEqual(capabilities.granted_scopes, ['library:read', 'account:read', 'library:read']);
});

test('明确的空 grants 是完整空授权，不回退到目录或动作', () => {
  assert.deepEqual(grantedScopeSnapshot({
    api_version: 'v1', granted_scopes: [], scopes: [{ id: 'library:write' }],
    actions: [action('library.list')],
  }), { scopes: [], scopes_source: 'server', scopes_complete: true });
});

for (const granted_scopes of [undefined, null]) {
  test(`旧服务 grants=${granted_scopes} 只能从已授权动作得出已知下界`, () => {
    assert.deepEqual(grantedScopeSnapshot({
      api_version: 'v1', granted_scopes,
      scopes: [{ id: 'library:write' }, { id: 'creator:sync' }],
      actions: [
        action('library.list'),
        action('library.get'),
        action('ask.sources', { scopes: ['ask:read', 'library:read'] }),
      ],
    }), {
      scopes: ['ask:read', 'library:read'], scopes_source: 'authorized_actions', scopes_complete: false,
    });
    assert.deepEqual(grantedScopeSnapshot({
      api_version: 'v1', granted_scopes, actions: [], scopes: [{ id: 'library:write' }],
    }), { scopes: [], scopes_source: 'authorized_actions', scopes_complete: false });
  });
}

test('只有就绪且明确支持当前服务的桌面才能使用授权深链', () => {
  assert.equal(desktopAuthorizationUrl(readyDesktop, origin, 'ABCD-EF23'),
    'zhicui://agent-authorize?user_code=ABCD-EF23');
  assert.equal(desktopAuthorizationUrl(readyDesktop, `${origin}/api`, 'GHJK-LM89'),
    'zhicui://agent-authorize?user_code=GHJK-LM89');
});

test('离线、恢复中、未声明支持或服务不同均保留浏览器授权路线', () => {
  const rejected = [
    {},
    { ...readyDesktop, available: false },
    { ...readyDesktop, available: 'true' },
    { ...readyDesktop, zhicui_login: 'restoring' },
    { ...readyDesktop, zhicui_login: 'not_logged_in' },
    { ...readyDesktop, zhicui_login: undefined },
    { ...readyDesktop, agent_authorization: undefined },
    { ...readyDesktop, agent_authorization: {} },
    { ...readyDesktop, agent_authorization: { supported: false, server_origin: origin } },
    { ...readyDesktop, agent_authorization: { supported: 'true', server_origin: origin } },
    { ...readyDesktop, agent_authorization: { supported: true } },
    ...['https://other.invalid', 'http://luxai.cn', 'https://luxai.cn:8443',
      'https://luxai.cn.attacker.invalid', 'https://luxai.cn@attacker.invalid']
      .map(server_origin => ({ ...readyDesktop, agent_authorization: { supported: true, server_origin } })),
  ];
  for (const status of rejected) {
    assert.equal(desktopAuthorizationUrl(status, origin, 'ABCD-EF23'), null, JSON.stringify(status));
  }
});

test('桌面授权码必须是服务端无歧义字母表的四位加四位', () => {
  for (const code of [
    'ABCI-EF23', 'ABCO-EF23', 'ABCD-EF01', 'abcd-ef23', 'ABC-DEF23',
    'ABCDE-F23', 'ABCDEFGH', 'ABCD--EF23', ' ABCD-EF23', 'ABCD-EF23 ',
    'ABCD-EF23\n', 'ABCD%2DEF23', 'ＡＢＣＤ-EF23', 'ABCD-EF23&redirect=other',
  ]) {
    assert.equal(desktopAuthorizationUrl(readyDesktop, origin, code), null, JSON.stringify(code));
  }
});
