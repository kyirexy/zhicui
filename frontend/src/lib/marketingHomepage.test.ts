import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LANDING_DEMO } from './landingDemo.ts';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testDirectory, '..');
test('浏览器标签统一使用绿色叶片图标，不再被蓝色文件图标覆盖', () => {
  const layout = readFileSync(resolve(sourceRoot, 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /icons:\s*\{/);
  assert.match(layout, /\/icons\/icon-192\.png\?v=green-leaf-20260907/);
  assert.doesNotMatch(layout, /<link rel="icon"/);
  assert.equal(existsSync(resolve(sourceRoot, 'app', 'icon.svg')), false);
});
const landingPage = readFileSync(
  resolve(sourceRoot, 'components', 'WebLandingPage.tsx'),
  'utf8',
);
const landingStyles = readFileSync(
  resolve(sourceRoot, 'components', 'WebLandingPage.module.css'),
  'utf8',
);

test('官网下载区保留双架构 Mac 测试版', () => {
  assert.match(landingPage, /id="download-mac"/);
  assert.match(landingPage, /下载 Apple Silicon 版/);
  assert.match(landingPage, /下载 Intel 版/);
  assert.match(landingPage, /Zhicui-Mac-Test-1\.1\.0-arm64\.dmg/);
  assert.match(landingPage, /Zhicui-Mac-Test-1\.1\.0-x64\.dmg/);
  assert.match(landingPage, /尚未完成苹果签名公证和真机验收/);
  assert.match(landingPage, /iPhone \/ iPad 版尚未发布/);
});

test('官网用真实能力介绍博主整理和多视频提问', () => {
  assert.match(landingPage, /只整理你关心的博主/);
  assert.match(landingPage, /多选视频，一次问清楚/);
  assert.match(landingPage, /直接准备近期 20\/50\/100 条文稿/);
  assert.match(landingPage, /先刷新全部公开作品清单/);
  assert.match(landingPage, /所有同步都由你手动发起/);
  assert.match(landingPage, /单次最多 50 条/);
  assert.match(landingPage, /回答保留对应视频和原文依据/);
  assert.doesNotMatch(landingPage, /自动追更|自动同步博主全部视频/);
});

test('示例观点和行动引用始终对应可阅读的原文段落', () => {
  assert.ok(LANDING_DEMO.sourceLabel.trim());
  assert.ok(LANDING_DEMO.paragraphs.length > 0);
  assert.ok(LANDING_DEMO.points.length > 0);
  assert.ok(LANDING_DEMO.tasks.length > 0);

  for (const item of [...LANDING_DEMO.points, ...LANDING_DEMO.tasks]) {
    assert.ok(Number.isInteger(item.source), `${item.title} 的来源必须是整数段号`);
    assert.ok(item.source >= 1 && item.source <= LANDING_DEMO.paragraphs.length,
      `${item.title} 的来源段号超出原文范围`);
    assert.ok(LANDING_DEMO.paragraphs[item.source - 1]?.trim(),
      `${item.title} 的原文依据不能为空`);
  }
});

test('示例行动具有独立标识，勾选一项不会同时完成其他任务', () => {
  const taskIds = LANDING_DEMO.tasks.map((task) => task.id);
  assert.equal(new Set(taskIds).size, taskIds.length);
  assert.ok(taskIds.every((id) => id.trim().length > 0));
});

test('演示步骤共用稳定网格，隐藏内容不参与交互', () => {
  const component = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.tsx'), 'utf8');
  const css = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.module.css'), 'utf8');
  for (const step of [0, 1, 2]) {
    assert.ok(component.includes(`aria-hidden={step !== ${step}} inert={step !== ${step}}`));
    assert.ok(!component.includes(`step === ${step} && (`), '步骤不能卸载，否则高度会跳变');
  }
  assert.match(css, /\.panel\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.panel > div\s*\{[^}]*grid-area:\s*1 \/ 1/);
  assert.match(css, /\[aria-hidden='true'\]\s*\{[^}]*visibility:\s*hidden/);
  assert.doesNotMatch(component, /setSource\(null\)/, '切换步骤和播放不应收起原文导致高度改变');
});

test('首屏中文标题收住字号和负字距', () => {
  const heroHeading = landingStyles.slice(
    landingStyles.indexOf('.hero h1 {'),
    landingStyles.indexOf('.hero h1 span {'),
  );
  assert.match(heroHeading, /font-size:\s*clamp\(3rem,\s*4vw,\s*5rem\)/);
  assert.match(heroHeading, /letter-spacing:\s*-0\.04em/);
  assert.doesNotMatch(heroHeading, /5\.7rem|-0\.064em/);
});
