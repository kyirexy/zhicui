import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceCss = readFileSync(
  resolve(testDirectory, '../components/agent/AgentWorkspace.module.css'),
  'utf8',
);
const androidManifest = readFileSync(
  resolve(testDirectory, '../../android/app/src/main/AndroidManifest.xml'),
  'utf8',
);
const activityTimeline = readFileSync(
  resolve(testDirectory, '../components/agent/AgentActivityTimeline.tsx'),
  'utf8',
);
const composer = readFileSync(
  resolve(testDirectory, '../components/agent/AgentComposer.tsx'),
  'utf8',
);
const workspace = readFileSync(
  resolve(testDirectory, '../components/agent/VideoAgentWorkspace.tsx'),
  'utf8',
);
const globalCss = readFileSync(resolve(testDirectory, '../app/globals.css'), 'utf8');

const mobileStart = workspaceCss.indexOf('@media (max-width: 767px)');
const narrowStart = workspaceCss.indexOf('@media (max-width: 420px)', mobileStart);
const mobileCss = workspaceCss.slice(mobileStart, narrowStart);

test('移动端知萃 AI 保留稳定的内部滚动与真实消息高度', () => {
  assert.ok(mobileStart >= 0, '缺少知萃 AI 手机断点');
  assert.match(mobileCss, /\.video-agent-thread[\s\S]*?overscroll-behavior-y:\s*contain/);
  assert.match(mobileCss, /\.video-agent-message:not\(\.is-streaming\)[\s\S]*?content-visibility:\s*visible/);
  assert.match(mobileCss, /\.video-agent-message[\s\S]*?contain:\s*layout style paint/);
});

test('移动端对话移除重复四栏导航并把次级功能收进菜单', () => {
  assert.doesNotMatch(workspace, /className="video-agent-mobile-tabs"/);
  assert.match(workspace, /className="is-icon is-mobile-more"/);
  assert.match(workspace, /className="video-agent-mobile-actions"/);
  assert.match(
    mobileCss,
    /\.video-agent-topbar-actions button\.is-new-chat\)[\s\S]*?\.video-agent-topbar-actions button\.is-mobile-more\)/,
  );
});

test('视频详情里的移动端对话占据稳定视口高度', () => {
  const knowledgeMobileStart = globalCss.indexOf(
    '@media (max-width: 640px)',
    globalCss.indexOf('.video-knowledge-page'),
  );
  const knowledgeMobileCss = globalCss.slice(knowledgeMobileStart);
  assert.ok(knowledgeMobileStart >= 0, '缺少视频详情手机断点');
  assert.match(
    knowledgeMobileCss,
    /\.video-knowledge-panel\s*\{[\s\S]*?height:\s*calc\([\s\S]*?100dvh[\s\S]*?--mobile-nav-height[\s\S]*?min-height:\s*0/,
  );
});

test('移动端发送与停止操作具有 44px 触控区域', () => {
  assert.match(
    mobileCss,
    /\.video-agent-send\),[\s\S]*?\.video-agent-send\.is-stop\)[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px[\s\S]*?min-width:\s*44px[\s\S]*?min-height:\s*44px/,
  );
});

test('移动端回答方式使用原生底部弹层而不是相对按钮的桌面浮层', () => {
  assert.match(composer, /<NativeModal[\s\S]*?title="回答方式"[\s\S]*?variant="sheet"/);
  assert.match(composer, /if \(!optionsOpen \|\| isMobile\) return/);
  assert.match(
    workspaceCss,
    /\.agent-options-menu\.is-sheet\)[\s\S]*?position:\s*static[\s\S]*?width:\s*100%[\s\S]*?max-height:\s*none/,
  );
  assert.match(
    mobileCss,
    /\.video-agent-options-picker\)[\s\S]*?position:\s*static/,
  );
});

test('生成期间只保留输入框方形停止键', () => {
  assert.doesNotMatch(activityTimeline, /video-agent-turn-action|onCancel|canCancel|cancelling/);
  assert.match(composer, /className="video-agent-send is-stop"/);
  assert.match(composer, /aria-label="停止生成"/);
});

test('移动端顶部与抽屉关闭操作具有至少 44px 触控区域', () => {
  assert.match(
    mobileCss,
    /\.video-agent-mobile-close\),[\s\S]*?\.video-agent-topbar-icon\)[\s\S]*?width:\s*44px[\s\S]*?height:\s*44px[\s\S]*?min-width:\s*44px[\s\S]*?min-height:\s*44px/,
  );
  assert.match(
    workspaceCss,
    /\.video-agent-topbar-actions button\)[\s\S]*?min-height:\s*44px/,
  );
});

test('会话和视频选择列表在窄屏使用独立触摸滚动', () => {
  assert.match(
    mobileCss,
    /\.video-agent-source-list\),[\s\S]*?\.video-agent-history-list\),[\s\S]*?\.video-agent-studio-body\)[\s\S]*?-webkit-overflow-scrolling:\s*touch/,
  );
  assert.match(mobileCss, /\.video-agent-apply-sources[\s\S]*?env\(safe-area-inset-bottom/);
});

test('移动端抽屉与固定操作区完整避让系统手势区', () => {
  assert.match(
    mobileCss,
    /\.video-agent-history\)[\s\S]*?padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
  );
  assert.match(
    mobileCss,
    /\.video-agent-studio\)[\s\S]*?padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
  );
  assert.match(
    mobileCss,
    /\.video-agent-apply-sources\)[\s\S]*?margin-bottom:\s*calc\(10px\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/,
  );
  assert.match(
    mobileCss,
    /\.video-agent-automation-sheet\)[\s\S]*?padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
  );
  assert.match(
    mobileCss,
    /\.root\.embedded\s+:global\(\.video-agent-studio\)[\s\S]*?\.video-agent-automation-sheet\)[\s\S]*?padding-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
  );
  assert.match(
    mobileCss,
    /\.video-agent-composer-region\)[\s\S]*?calc\(9px\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)/,
  );
});

test('Capacitor Android 键盘缩放内容区而不是遮挡输入框', () => {
  assert.match(androidManifest, /android:windowSoftInputMode="adjustResize"/);
});
