#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const downloadRoot = resolve(root, 'frontend/public/download');
const durableDownloadRoot = process.env.ZHICUI_DOWNLOAD_ROOT
  ? resolve(process.env.ZHICUI_DOWNLOAD_ROOT)
  : null;
const channelPaths = [
  'releases/android/beta.json',
  'releases/android/stable.json',
  'releases/windows/beta.json',
  'releases/windows/stable.json',
];
const shaPattern = /^[0-9a-f]{64}$/i;
const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

function sourcePath(relative) {
  if (durableDownloadRoot && relative.startsWith('releases/windows/')) {
    return resolve(durableDownloadRoot, relative);
  }
  return resolve(downloadRoot, relative);
}

async function readJson(relative) {
  return JSON.parse(await readFile(sourcePath(relative), 'utf8'));
}

async function sha256(path) {
  const content = await readFile(path);
  return createHash('sha256').update(content).digest('hex');
}

function validateAvailableManifest(manifest, path) {
  assert(manifest.availability === 'available', `${path}: availability 无效`);
  assert(versionPattern.test(manifest.version || ''), `${path}: version 无效`);
  assert(Number.isInteger(manifest.size_bytes) && manifest.size_bytes > 0, `${path}: size_bytes 无效`);
  assert(shaPattern.test(manifest.sha256 || ''), `${path}: sha256 无效`);
  assert(typeof manifest.download_url === 'string', `${path}: download_url 缺失`);
  const url = new URL(manifest.download_url);
  assert(url.protocol === 'https:' && url.hostname === 'luxai.cn', `${path}: 下载域名不可信`);
  if (manifest.platform === 'android') {
    assert(Number.isInteger(manifest.build) && manifest.build > 0, `${path}: build 无效`);
    if (manifest.channel === 'stable') {
      assert(manifest.artifact_kind === 'release', `${path}: stable 必须是 release APK`);
      assert(manifest.debuggable === false, `${path}: stable APK 不得 debuggable`);
      assert(manifest.signing?.verified === true, `${path}: stable APK 签名未验证`);
      assert(shaPattern.test(manifest.signing?.certificate_sha256 || ''), `${path}: stable 证书指纹无效`);
    }
  }
  if (manifest.platform === 'windows' && manifest.channel === 'stable') {
    assert(manifest.artifact_kind === 'authenticode', `${path}: stable 必须是 Authenticode`);
    assert(manifest.code_signed === true, `${path}: stable 安装包未签名`);
    assert(manifest.signing?.verified === true, `${path}: stable 签名未验证`);
    assert(Boolean(manifest.signing?.publisher), `${path}: stable 发布者缺失`);
    assert(manifest.signing?.timestamp_verified === true, `${path}: stable 时间戳未验证`);
  }
}

const manifests = new Map();
for (const path of channelPaths) {
  const manifest = await readJson(path);
  const [, platform, channelFile] = path.split('/');
  const channel = channelFile.replace(/\.json$/, '');
  assert(manifest.schema_version === 2, `${path}: schema_version 必须为 2`);
  assert(manifest.platform === platform, `${path}: platform 与路径不一致`);
  assert(manifest.channel === channel, `${path}: channel 与路径不一致`);
  assert(['available', 'unavailable'].includes(manifest.availability), `${path}: availability 无效`);
  if (manifest.availability === 'available') validateAvailableManifest(manifest, path);
  else assert(typeof manifest.reason === 'string' && manifest.reason.length >= 8, `${path}: unavailable 必须说明原因`);
  manifests.set(`${platform}:${channel}`, manifest);
}

// 所有 available Windows 清单都必须能逐字节对应持久二进制与 Electron feed。
for (const channel of ['beta', 'stable']) {
  const manifest = manifests.get(`windows:${channel}`);
  if (manifest.availability !== 'available') continue;
  const artifactName = basename(new URL(manifest.download_url).pathname);
  const releaseDir = resolve(root, `desktop/release-${manifest.version}`);
  const artifactCandidates = durableDownloadRoot
    ? [resolve(durableDownloadRoot, 'windows', artifactName)]
    : [resolve(releaseDir, artifactName), resolve(downloadRoot, 'windows', artifactName)];
  const artifactPath = (await Promise.all(artifactCandidates.map(async path => [path, await exists(path)])))
    .find(([, present]) => present)?.[0];
  assert(artifactPath, `Windows ${channel}: available 清单缺少安装包 ${artifactName}`);
  const artifactStat = await stat(artifactPath);
  assert(artifactStat.size === manifest.size_bytes, `Windows ${channel}: size_bytes 与安装包不一致`);
  assert(await sha256(artifactPath) === manifest.sha256.toLowerCase(), `Windows ${channel}: SHA-256 与安装包不一致`);

  const feedCandidates = durableDownloadRoot
    ? [resolve(durableDownloadRoot, 'windows', `${channel}.yml`)]
    : [resolve(releaseDir, `${channel}.yml`), resolve(releaseDir, 'latest.yml')];
  const feedPath = (await Promise.all(feedCandidates.map(async path => [path, await exists(path)])))
    .find(([, present]) => present)?.[0];
  assert(feedPath, `Windows ${channel}: available 清单缺少更新 feed`);
  const feed = await readFile(feedPath, 'utf8');
  const expectedSha512 = createHash('sha512').update(await readFile(artifactPath)).digest('base64');
  assert(new RegExp(`^version:\\s*${manifest.version.replaceAll('.', '\\.')}\\s*$`, 'm').test(feed), `Windows ${channel}: feed 版本不一致`);
  assert(new RegExp(`(?:^|\\s)url:\\s*${artifactName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm').test(feed), `Windows ${channel}: feed 未引用安装包`);
  assert(feed.includes(`sha512: ${expectedSha512}`), `Windows ${channel}: feed SHA-512 不一致`);
}

// 当前仓库内 Android beta 产物必须与清单逐字节一致。
const androidBeta = manifests.get('android:beta');
const apkPath = resolve(downloadRoot, 'zhicui.apk');
const apkStat = await stat(apkPath);
assert(apkStat.size === androidBeta.size_bytes, 'Android beta size_bytes 与 APK 不一致');
assert(await sha256(apkPath) === androidBeta.sha256.toLowerCase(), 'Android beta SHA-256 与 APK 不一致');

// 旧清单是 beta 的兼容别名，禁止误指 stable。
const legacyAndroid = await readJson('latest.json');
const legacyWindows = await readJson('desktop-latest.json');
const compatibilityAliases = [
  [legacyAndroid, androidBeta, 'Android'],
];
// 持久 Windows 通道可独立于 Web runtime 发布；仅本地仓库校验旧 beta 别名。
if (!durableDownloadRoot) compatibilityAliases.push([legacyWindows, manifests.get('windows:beta'), 'Windows']);
for (const [legacy, current, label] of compatibilityAliases) {
  assert(legacy.channel === 'beta', `${label} 旧清单必须明确标记 beta`);
  assert(legacy.version === current.version, `${label} 旧清单版本与 beta 不一致`);
  assert(legacy.download_url === current.download_url, `${label} 旧清单下载地址与 beta 不一致`);
  assert(legacy.sha256?.toLowerCase() === current.sha256.toLowerCase(), `${label} 旧清单哈希与 beta 不一致`);
}

console.log(`发行清单验证通过：${channelPaths.map((path) => basename(path)).join(', ')}；stable 当前安全关闭。`);
