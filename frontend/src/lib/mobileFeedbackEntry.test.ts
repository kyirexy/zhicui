import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('移动首页提供低强调且可触达的反馈入口', () => {
  const home = read('components/WorkspaceActionHome.tsx');
  const homeCss = read('components/WorkspaceActionHome.module.css');

  assert.match(home, /className=\{styles\.mobileFeedback\}/);
  assert.match(home, /aria-label="意见反馈"/);
  assert.match(home, /zhicui:open-feedback/);
  assert.match(homeCss, /@media \(max-width:\s*767px\)/);
  assert.match(
    homeCss,
    /\.mobileFeedback,\s*\n\s*\.mobileSettings\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/,
  );
  assert.match(homeCss, /\.mobileFeedback\s*\{[\s\S]*?color:\s*var\(--home-faint\)/);
});

test('设置页保留反馈入口并覆盖全部移动端宽度', () => {
  const settings = read('app/settings/page.tsx');
  const settingsCss = read('app/settings/SettingsWorkspace.module.css');

  assert.match(settings, /zhicui:open-feedback/);
  assert.match(settings, /<span>意见反馈<\/span>/);
  assert.match(settingsCss, /@media \(max-width:\s*767px\)[\s\S]*?\.mobileActions\s*\{[\s\S]*?display:\s*grid/);
});

test('移动端复用全局反馈弹窗而不是增加悬浮球或底部导航项', () => {
  const feedback = read('components/FeedbackButton.tsx');
  const globals = read('app/globals.css');
  const navigation = read('lib/productNavigation.ts');

  assert.match(feedback, /addEventListener\('zhicui:open-feedback'/);
  assert.match(feedback, /<dialog/);
  assert.match(globals, /@media \(max-width:\s*767px\)[\s\S]*?\.feedback-launcher\s*\{[\s\S]*?display:\s*none\s*!important/);
  assert.doesNotMatch(navigation, /mobileLabel:\s*'反馈'/);
});
