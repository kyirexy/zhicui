import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createPhoneClaimSecret, parsePhoneLoginQr } from './phoneLogin.ts';

const url = `https://luxai.cn/login#phone-login=pls-${'a'.repeat(32)}.${'b'.repeat(43)}`;
test('手机登录码严格限制来源、路径、凭据种类和长度', () => {
  assert.ok(parsePhoneLoginQr(url));
  for (const invalid of [url.replace('luxai.cn', 'evil.example'), url.replace('/login#', '/login?x=1#'),
    url.replace('phone-login', 'desktop-login'), url.replace('pls-', 'dls-'), url + '.extra', url.slice(0, -1),
    url.replace('https://', 'https://name@')]) assert.equal(parsePhoneLoginQr(invalid), null);
});
test('手机独立生成不可预测的领取凭据', () => {
  const first = createPhoneClaimSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, createPhoneClaimSecret());
});
test('手机登录入口和电脑授权不反向，不保存领取密钥', () => {
  const phone = readFileSync(new URL('../components/PhoneQrLogin.tsx', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../components/DesktopPhoneLoginCard.tsx', import.meta.url), 'utf8');
  assert.match(phone, /扫码登录手机/);
  assert.match(desktop, /确认登录这台手机/);
  assert.doesNotMatch(phone, /localStorage|sessionStorage|createPortal/);
  assert.match(phone, /controller\.abort\(\)/);
  assert.match(desktop, /decision: 'cancel'/);
});
test('帮助邮箱和普通用户管理入口保持正确', () => {
  const support = readFileSync(new URL('../app/support/page.tsx', import.meta.url), 'utf8');
  const header = readFileSync(new URL('../components/AppHeader.tsx', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../app/admin/[section]/page.tsx', import.meta.url), 'utf8');
  assert.match(support, /mailto:1592880030@qq\.com/);
  assert.doesNotMatch(support, /support@luxai\.cn/);
  assert.match(header, /user\.is_admin &&/);
  assert.match(admin, /if \(!user\.is_admin\)/);
});
