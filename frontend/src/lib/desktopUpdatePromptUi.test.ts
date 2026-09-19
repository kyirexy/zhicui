import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('桌面端更新入口主动展示弹窗、版本差异与准备进度', () => {
  const component = read('components/DesktopSidebarUpdate.tsx');
  const css = read('components/WebBuildUpdatePrompt.module.css');

  assert.match(component, /<dialog ref=\{dialogRef\}/);
  assert.match(component, /<dialog ref=\{webDialogRef\}/);
  assert.match(component, /currentWebVersion/);
  assert.match(component, /webUpdate\.completed/);
  assert.match(component, /aria-label="新版页面资源准备进度"/);
  assert.match(component, /setOpen\(true\)/);
  assert.match(component, /setWebOpen\(true\)/);
  assert.match(component, /立即更新页面/);
  assert.match(css, /\.updateVersions/);
  assert.match(css, /\.indeterminate/);
});

test('网页更新弹窗不会被当作待输入弹窗阻塞热刷新', () => {
  const hook = read('lib/hooks/useWebBuildUpdate.ts');
  assert.match(hook, /dialog\[open\]:not\(\[data-web-update-dialog\]\)/);
  assert.match(read('components/DesktopSidebarUpdate.tsx'), /data-web-update-dialog/);
});
