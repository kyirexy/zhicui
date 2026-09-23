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

test('官网支持平台条使用真实抖音和 B 站品牌图标', () => {
  assert.match(landingPage, /PlatformBrandIcon platform="douyin"/);
  assert.match(landingPage, /PlatformBrandIcon platform="bilibili"/);
  assert.match(landingStyles, /data-platform-brand='douyin'/);
  assert.match(landingStyles, /data-platform-brand='bilibili'/);
});

test('博主问答演示使用同一博主的示例目录并明确说明演示数据', () => {
  const component = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.tsx'), 'utf8');
  const css = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.module.css'), 'utf8');
  const creatorPanel = component.slice(component.indexOf('博主作品 · 一键提取并提问'));
  assert.match(component, /GGBond的小课堂/);
  assert.match(component, /90 条公开作品/);
  assert.match(component, /快速排序教学/);
  assert.match(component, /客户端流程 · 示例数据/);
  assert.match(component, /示例目录/);
  assert.doesNotMatch(component, /已核验的目录元数据/);
  assert.doesNotMatch(creatorPanel, /知萃精选博主|世界健体第六名|碳循环减脂|珍惜数学/);
  assert.match(css, /\.creatorFacts\s*\{/);
  assert.match(css, /\.creatorVerified\s*\{/);
});

test('同步演示使用真实平台图标并展示批量读取与 AI 全部解析', () => {
  const component = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.tsx'), 'utf8');
  const css = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.module.css'), 'utf8');
  assert.match(component, /PlatformBrandIcon/);
  assert.match(component, /客户端 · 批量读取/);
  assert.match(component, /本次读取范围/);
  assert.match(component, /AI 全部解析/);
  assert.doesNotMatch(component, /className=\{styles\.platformBadge\}>抖|className=\{`\$\{styles\.platformBadge\}[^}]*\}>哔/);
  assert.match(css, /\.scopeChip\s*\{/);
  assert.match(css, /\.analysisSummary\s*\{/);
});

test('官网演示覆盖四条客户端核心流程并自动播放流式问答', () => {
  const component = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.tsx'), 'utf8');
  assert.match(component, /批量同步/);
  assert.match(component, /今日 \/ 昨日回顾/);
  assert.match(component, /视频生成计划/);
  assert.match(component, /博主批量问答/);
  assert.match(component, /useState\(true\)/, '演示应默认自动播放');
  assert.match(component, /streamQuestion/);
  assert.match(component, /streamAnswer/);
  assert.match(component, /一键解析并提问/);
  assert.match(component, /一键提取并提问/);
});

test('演示时间线等待完整回答且点击标签会重新自动播放', () => {
  const component = readFileSync(resolve(sourceRoot, 'components', 'LandingProductDemo.tsx'), 'utf8');
  assert.match(component, /CHAT_START\[mode\] \+ chatDuration\(DIALOGUES\[mode\]\) \+ RESULT_HOLD_MS/);
  assert.match(component, /message\.text\.length \* TYPE_MS \+ MESSAGE_GAP_MS/);
  assert.match(component, /selectMode = .*setMode\(next\); setElapsed\(0\); setPlaying\(true\)/);
  assert.match(component, /if \(!playing \|\| !visible\) return/);
  assert.match(component, /window\.clearInterval\(timer\)/);
  assert.doesNotMatch(component, /4200|setSynced\(true\)/);
  assert.match(component, /elapsed >= PLAN_READY_AT &&/);
  assert.match(component, /PLAN_READY_AT = CHAT_START\[2\] \+ chatDuration\(DIALOGUES\[2\]\.slice\(0, 2\)\)/);
  assert.match(component, /role="progressbar"/);
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
  for (const step of [0, 1, 2, 3]) {
    assert.ok(component.includes(`aria-hidden={mode !== ${step}} inert={mode !== ${step}}`));
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
