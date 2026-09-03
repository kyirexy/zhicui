import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('Android 更新提示使用稳定挂载的原生 dialog', () => {
  const component = read('components/AppUpdatePrompt.tsx');

  assert.match(component, /<dialog/);
  assert.match(component, /className=\{styles\.dialog\}/);
  assert.doesNotMatch(component, /createPortal|appendChild|removeChild/);
  assert.match(component, /!isDevelopmentPreview && \(authLoading \|\| !user\)/);
});

test('移动端更新提示以底部面板呈现并适配安全区', () => {
  const css = read('components/AppUpdatePrompt.module.css');

  assert.match(css, /@media \(max-width:\s*640px\)/);
  assert.match(css, /\.dialog\s*\{[\s\S]*?width:\s*100%;[\s\S]*?margin:\s*auto 0 0;/);
  assert.match(css, /border-radius:\s*16px 16px 0 0;/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /\.actions button\s*\{[\s\S]*?min-height:\s*48px;/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test('更新信息聚焦版本变化、更新内容和明确操作', () => {
  const component = read('components/AppUpdatePrompt.tsx');

  assert.match(component, /当前版本/);
  assert.match(component, /最新版本/);
  assert.match(component, /更新内容/);
  assert.match(component, /下载并更新/);
  assert.match(component, /稍后提醒/);
  assert.match(component, /安装包来自 luxai\.cn/);
  assert.doesNotMatch(component, /app-update-meta/);
});

test('强制更新无法通过返回键、遮罩或次级操作绕过', () => {
  const component = read('components/AppUpdatePrompt.tsx');
  const css = read('components/AppUpdatePrompt.module.css');

  assert.match(component, /if \(!available \|\| available\.release\.mandatory\) return/);
  assert.match(component, /!available\?\.release\.mandatory/);
  assert.match(component, /!available\.release\.mandatory && \(/);
  assert.match(component, /styles\.mandatoryActions/);
  assert.match(css, /\.mandatoryActions\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
});
