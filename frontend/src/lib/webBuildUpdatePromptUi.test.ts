import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('桌面端不显示网页更新角标，仅靠空闲自动刷新', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  // 渲染 gate 包含桌面端判断；桌面端返回 null，网页版照常显示角标。
  assert.match(component, /if \(!enabled \|\| isDesktop \|\| !view\.visible/);
  assert.doesNotMatch(component, /!enabled && !isDesktop/);
  // 驱动（检测、预取与空闲自动重载）在桌面端保持开启，只隐藏 UI。
  assert.match(component, /useWebBuildUpdateDriver\(enabled/);
  assert.doesNotMatch(component, /useWebBuildUpdateDriver\(!isDesktop/);
});

test('网页版角标注明功能归属：解析在网页、同步去桌面客户端', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  assert.match(component, /单链接解析/);
  assert.match(component, /视频同步请在桌面客户端进行/);
  // 桌面端专属能力不再出现在网页提示的行动指令里。
  assert.doesNotMatch(component, /同步视频请在此操作|网页端同步/);
});

test('角标小字沿用玻璃拟态变量且不放大版式', () => {
  const css = read('components/WebBuildUpdatePrompt.module.css');

  assert.match(css, /\.notice \.footnote\s*\{[^}]*var\(--foreground-muted\)/);
  assert.match(css, /\.notice \.footnote\s*\{[^}]*font-size:\s*12px/);
  // 原有描述样式保持不变。
  assert.match(css, /\.notice p \{ margin: 8px 0 12px; color: var\(--foreground-secondary\); font-size: 13px/);
});

test('组件不引入 React 之外的 DOM 所有权操作', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  assert.doesNotMatch(component, /createPortal|appendChild|removeChild/);
});
