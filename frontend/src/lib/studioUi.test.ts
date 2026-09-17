import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const componentSource = readFileSync(
  fileURLToPath(new URL('../components/studio/StudioWorkspace.tsx', import.meta.url)),
  'utf8',
);
const pageSource = readFileSync(
  fileURLToPath(new URL('../app/studio/page.tsx', import.meta.url)),
  'utf8',
);

test('studio 页面挂载 StudioWorkspace', () => {
  assert.match(pageSource, /import StudioWorkspace from '@\/components\/studio\/StudioWorkspace'/);
  assert.match(pageSource, /<StudioWorkspace \/>/);
});

test('创作工坊保持桌面两栏:左对话面板 + 右项目面板', () => {
  assert.match(componentSource, /className=\{styles\.workspace\}/);
  assert.match(componentSource, /aria-label="创作对话"/);
  assert.match(componentSource, /aria-label="项目面板"/);
});

test('创作流程调用点齐全:创建、轮询、确认、迭代、取消', () => {
  assert.match(componentSource, /createVideoCreationJob\(/);
  assert.match(componentSource, /getVideoCreationJob\(/);
  assert.match(componentSource, /confirmVideoCreationJob\(/);
  assert.match(componentSource, /iterateVideoCreationJob\(/);
  assert.match(componentSource, /cancelVideoCreationJob\(/);
});

test('活动任务走 2.5 秒轮询且终态自动停止', () => {
  assert.match(componentSource, /2500/);
  assert.match(componentSource, /ACTIVE_STATUSES/);
});

test('确认渲染前展示估价,成品走认证流播放', () => {
  assert.match(componentSource, /确认并开始渲染/);
  assert.match(componentSource, /查看 SVML 脚本/);
  assert.match(componentSource, /\/api\/video-creation\/jobs\/\$\{encodeURIComponent\(activeJob\.id\)\}\/video/);
});

test('状态文案覆盖全部七种 job 状态', () => {
  for (const status of [
    'drafting',
    'draft',
    'queued',
    'rendering',
    'completed',
    'failed',
    'cancelled',
  ]) {
    assert.match(
      componentSource,
      new RegExp(`^  ${status}: '.+',$`, 'm'),
      `STATUS_TEXT 缺少 ${status}`,
    );
  }
});
