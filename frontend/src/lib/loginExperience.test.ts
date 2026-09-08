import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('账号表单有持久标签、密码可见开关和密码管理器语义', () => {
  const page = read('../app/login/page.tsx');
  assert.match(page, /htmlFor="login-account"/);
  assert.match(page, /htmlFor="login-password"/);
  assert.match(page, /id="login-password"/);
  assert.match(page, /type=\{passwordVisible \? 'text' : 'password'\}/);
  assert.match(page, /aria-pressed=\{passwordVisible\}/);
  assert.match(page, /autoComplete=\{mode === 'login' \? 'current-password' : 'new-password'\}/);
  assert.match(page, /autoCapitalize="none"/);
  assert.match(page, /<PhoneQrLogin variant="login"/);
  assert.match(page, /扫描已登录电脑上的二维码/);
});

test('移动登录不再嵌套大卡片，输入和主要触控保持可读可点', () => {
  const css = read('../app/login/Login.module.css');
  assert.doesNotMatch(css, /blur\(|backdrop-filter/);
  assert.match(css, /\.input \{[^}]*font-size: 16px/);
  assert.match(css, /\.submit \{[^}]*min-height: 54px/);
  assert.match(css, /\.passwordToggle \{[^}]*width: 44px; height: 44px/);
  assert.match(css, /prefers-reduced-motion/);
});

test('所有设置分类共享退出入口，确认退出不是注销账号', () => {
  const page = read('../app/settings/page.tsx');
  assert.match(page, /aria-label="当前账号"/);
  assert.match(page, /<NativeModal open=\{logoutOpen\}/);
  assert.match(page, /云端的视频资料、知识和计划不会删除/);
  assert.match(page, /onClick=\{confirmLogout\}/);
  assert.doesNotMatch(page, /createPortal|removeChild|appendChild/);
});

test('扫码全局透明规则只在相机开启时生效，模块选择器保持局部归属', () => {
  const globalCss = read('../app/globals.css');
  const scannerCss = read('../components/MobileDesktopLoginScanner.module.css');
  assert.match(globalCss, /html\.zhicui-desktop-login-scanner-active,/);
  assert.match(globalCss, /body\.zhicui-desktop-login-scanner-active \{\s*overflow: hidden !important;\s*visibility: hidden;/);
  assert.match(scannerCss, /:global\(body\.zhicui-desktop-login-scanner-active\) \.overlayOpen/);
  assert.doesNotMatch(scannerCss, /:global\(html\.zhicui-desktop-login-scanner-active\),/);
});
