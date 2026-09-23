import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');
const read = (path: string) => readFileSync(resolve(srcRoot, path), 'utf8');

test('网页更新保持静默，仅靠空闲自动刷新', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  // 驱动（检测、预取与空闲自动重载）保持开启，但浏览器不再渲染右下角角标。
  assert.match(component, /useWebBuildUpdateDriver\(enabled/);
  assert.match(component, /return null/);
  assert.doesNotMatch(component, /<aside className=\{styles\.notice\}/);
});

test('静默热更新不引入网页更新操作文案', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  assert.doesNotMatch(component, /现在更新|重试更新|稍后更新页面/);
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

test('服务端持久 job 不再阻塞自动更新', () => {
  const component = read('components/WebBuildUpdatePrompt.tsx');

  // 创作者同步与视频解析是服务端 job，刷新页面不影响执行。
  assert.doesNotMatch(component, /global-creator-sync|global-video-analysis/);
  // 短时前台任务（页面内 SSE 提取、桌面包安装瞬间）仍保持挡刷。
  assert.match(component, /useWebBuildActivity\('global-extraction', extraction\.isLoading\)/);
  assert.match(component, /useWebBuildActivity\('native-install', nativeUpdate\.update\.status === 'installing'\)/);
});

test('可恢复的后台任务不阻塞自动更新', () => {
  const agent = read('components/agent/VideoAgentWorkspace.tsx');
  const knowledge = read('components/VideoKnowledgeWorkspace.tsx');
  const library = read('app/library/page.tsx');

  // 后台线程与 agent 回答由持久 turn + SSE replay 恢复。
  assert.match(agent, /useWebBuildActivity\('video-agent', sending \|\| Boolean\(streamingMessageId\) \|\| queuedQuestions\.length > 0 \|\| Boolean\(studioGeneratingType\)\)/);
  assert.doesNotMatch(agent, /activity\('video-agent'[^)]*backgroundThreadId/);
  assert.match(knowledge, /useWebBuildActivity\('video-knowledge', extracting \|\| initializingAi\)/);
  // 批量转写与等待处理的同步恢复由服务端持久化。
  assert.match(library, /useWebBuildActivity\('library-sync', scanning \|\| refreshing\s*\n?\s*\|\| Boolean\(sourceSyncQueue\)\)/);
  assert.doesNotMatch(library, /activity\('library-sync'[^)]*batchExtracting/);
  assert.doesNotMatch(library, /activity\('library-sync'[^)]*syncRecoveryIssues/);
});
