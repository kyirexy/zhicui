import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isCommunityInviteExpired } from './community.ts';
import { resolveClientAuthPolicy } from './clientAuthPolicy.ts';

test('北京时间有效期边界与无效时间默认拒绝展示旧码', () => {
  assert.equal(isCommunityInviteExpired(Date.parse('2026-09-13T23:59:59+08:00')), false);
  assert.equal(isCommunityInviteExpired(Date.parse('2026-09-14T00:00:00+08:00')), true);
  assert.equal(isCommunityInviteExpired(Date.parse('2026-09-15T00:00:00+08:00')), true);
  assert.equal(isCommunityInviteExpired(NaN), true);
});
test('官网、桌面、移动首页和反馈均有公共加群入口', () => {
  for (const file of ['AppHeader', 'AppFooter', 'DesktopAppFrame', 'WorkspaceActionHome', 'FeedbackButton']) {
    assert.match(readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), 'utf8'), /href="\/community"/);
  }
  assert.match(readFileSync(new URL('../app/support/page.tsx', import.meta.url), 'utf8'), /id: 'community'/);
  assert.match(readFileSync(new URL('../components/WebLandingPage.tsx', import.meta.url), 'utf8'), /<CommunityPanel/);
});
test('未登录的网页与客户端都能打开加群页面', () => {
  for (const desktop of [true, false]) for (const nativeMobile of [true, false]) {
    const policy = resolveClientAuthPolicy('/community', { desktop, nativeMobile, development: false });
    assert.equal(policy.publicRoute, true);
    assert.equal(policy.browserClientGate, false);
  }
});
