import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(testDirectory, '..');
const landingPage = readFileSync(
  resolve(sourceRoot, 'components', 'WebLandingPage.tsx'),
  'utf8',
);
const landingStyles = readFileSync(
  resolve(sourceRoot, 'components', 'WebLandingPage.module.css'),
  'utf8',
);

test('官网首屏和下载区都能找到双架构 Mac 测试版', () => {
  assert.match(landingPage, /href="#download-mac"/);
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

test('演示位可直接替换为低负载带字幕视频', () => {
  assert.match(landingPage, /controls/);
  assert.match(landingPage, /playsInline/);
  assert.match(landingPage, /preload="none"/);
  assert.match(landingPage, /kind="captions"/);
  assert.match(landingPage, /data-static=\{!story\.videoSrc/);
  assert.match(landingPage, /story\.videoSrc \? '功能演示' : '界面示意'/);
  assert.doesNotMatch(landingPage, /demoPlayLabel/);
  assert.match(landingStyles, /\.demoMedia\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9/);
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
