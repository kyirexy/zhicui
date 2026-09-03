#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformArgument = process.argv.find((value) => value.startsWith('--platform='));
const requestedPlatform = platformArgument?.slice('--platform='.length) || 'all';
if (!['all', 'android', 'windows'].includes(requestedPlatform)) {
  throw new Error('--platform 仅支持 all、android 或 windows');
}
const verifyAndroidArtifact = requestedPlatform !== 'windows';
const verifyWindowsArtifact = requestedPlatform !== 'android';
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
const commitPattern = /^[0-9a-f]{40}$/i;
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
  assert(
    url.protocol === 'https:' &&
      url.hostname === 'luxai.cn' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '',
    `${path}: 下载地址不可信`,
  );
  assert(commitPattern.test(manifest.source_commit || ''), `${path}: source_commit 无效`);
  assert(Number.isFinite(Date.parse(manifest.published_at || '')), `${path}: published_at 无效`);
  assert(
    Array.isArray(manifest.release_notes) &&
      manifest.release_notes.length >= 1 &&
      manifest.release_notes.length <= 20 &&
      manifest.release_notes.every((note) => typeof note === 'string' && note.trim().length >= 1 && note.trim().length <= 240),
    `${path}: release_notes 无效`,
  );
  if (manifest.platform === 'android') {
    assert(Number.isInteger(manifest.build) && manifest.build > 0, `${path}: build 无效`);
    assert(manifest.signing?.verified === true, `${path}: APK 签名未验证`);
    assert(shaPattern.test(manifest.signing?.certificate_sha256 || ''), `${path}: APK 证书指纹无效`);
    if (manifest.channel === 'stable') {
      assert(manifest.artifact_kind === 'release', `${path}: stable 必须是 release APK`);
      assert(manifest.debuggable === false, `${path}: stable APK 不得 debuggable`);
      assert(
        url.pathname === `/download/android/Zhicui-${manifest.version}-${manifest.build}.apk`,
        `${path}: stable APK 必须使用版本化下载地址`,
      );
    } else {
      assert(manifest.artifact_kind === 'debug', `${path}: beta 必须明确为 debug APK`);
      assert(manifest.debuggable === true, `${path}: beta Debug APK 身份不一致`);
      assert(url.pathname === '/download/zhicui.apk', `${path}: beta APK 下载地址无效`);
    }
  }
  if (manifest.platform === 'windows') {
    assert(manifest.architecture === 'x64', `${path}: Windows 架构必须为 x64`);
    assert(
      url.pathname === `/download/windows/Zhicui-Setup-${manifest.version}-x64.exe`,
      `${path}: Windows 安装包必须使用版本化下载地址`,
    );
    if (manifest.channel === 'stable') {
      assert(manifest.artifact_kind === 'authenticode', `${path}: stable 必须是 Authenticode`);
      assert(manifest.code_signed === true, `${path}: stable 安装包未签名`);
      assert(manifest.release_status === 'stable_download', `${path}: stable 发布状态无效`);
      assert(manifest.signing?.verified === true, `${path}: stable 签名未验证`);
      assert(Boolean(manifest.signing?.publisher), `${path}: stable 发布者缺失`);
      assert(shaPattern.test(manifest.signing?.certificate_sha256 || ''), `${path}: stable 签名证书指纹无效`);
      assert(manifest.signing?.timestamp_verified === true, `${path}: stable 时间戳未验证`);
      assert(shaPattern.test(manifest.signing?.timestamp_certificate_sha256 || ''), `${path}: stable 时间戳证书指纹无效`);
      assert(manifest.blockmap?.name === `${basename(url.pathname)}.blockmap`, `${path}: blockmap 名称无效`);
      assert(shaPattern.test(manifest.blockmap?.sha256 || ''), `${path}: blockmap SHA-256 无效`);
      assert(Number.isInteger(manifest.blockmap?.size_bytes) && manifest.blockmap.size_bytes > 0, `${path}: blockmap 大小无效`);
      assert(manifest.update_feed?.name === 'stable.yml', `${path}: stable feed 名称无效`);
      assert(manifest.update_feed?.download_url === 'https://luxai.cn/download/windows/stable.yml', `${path}: stable feed 地址无效`);
      assert(shaPattern.test(manifest.update_feed?.sha256 || ''), `${path}: stable feed SHA-256 无效`);
      assert(Number.isInteger(manifest.update_feed?.size_bytes) && manifest.update_feed.size_bytes > 0, `${path}: stable feed 大小无效`);
    }
  }
  if (manifest.channel === 'stable') {
    assert(manifest.verification_evidence?.schema_version === 1, `${path}: Stable 缺少客户端验收证据版本`);
    assert(shaPattern.test(manifest.verification_evidence?.sha256 || ''), `${path}: Stable 客户端验收证据 SHA-256 无效`);
    assert(Number.isFinite(Date.parse(manifest.verification_evidence?.completed_at || '')), `${path}: Stable 客户端验收时间无效`);
    assert(shaPattern.test(manifest.verification_evidence?.device_fingerprint_sha256 || ''), `${path}: Stable 脱敏设备指纹无效`);
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
  else {
    assert(typeof manifest.reason === 'string' && manifest.reason.length >= 8, `${path}: unavailable 必须说明原因`);
    for (const forbidden of ['download_url', 'sha256', 'version']) {
      assert(manifest[forbidden] === undefined, `${path}: unavailable 不得携带 ${forbidden}`);
    }
  }
  manifests.set(`${platform}:${channel}`, manifest);
}

// 所有 available Windows 清单都必须能逐字节对应持久二进制与 Electron feed。
for (const channel of verifyWindowsArtifact ? ['beta', 'stable'] : []) {
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

// 所有 available Android 清单都必须与各自 APK 逐字节一致；Stable 只能指向
// 版本化 release APK，绝不能把 beta/debug 兼容文件误当作正式产物。
const androidBeta = manifests.get('android:beta');
const apkPath = resolve(downloadRoot, 'zhicui.apk');
if (verifyAndroidArtifact) {
  for (const channel of ['beta', 'stable']) {
    const manifest = manifests.get(`android:${channel}`);
    if (manifest.availability !== 'available') continue;
    const artifactPath = channel === 'beta'
      ? apkPath
      : resolve(downloadRoot, 'android', basename(new URL(manifest.download_url).pathname));
    assert(await exists(artifactPath), `Android ${channel}: available 清单缺少 APK`);
    const apkStat = await stat(artifactPath);
    assert(apkStat.size === manifest.size_bytes, `Android ${channel}: size_bytes 与 APK 不一致`);
    assert(await sha256(artifactPath) === manifest.sha256.toLowerCase(), `Android ${channel}: SHA-256 与 APK 不一致`);
  }
}

// 旧清单是 beta 的兼容别名，禁止误指 stable。
const legacyAndroid = await readJson('latest.json');
const legacyWindows = await readJson('desktop-latest.json');
const compatibilityAliases = verifyAndroidArtifact
  ? [[legacyAndroid, androidBeta, 'Android']]
  : [];
// 持久 Windows 通道可独立于 Web runtime 发布；仅本地仓库校验旧 beta 别名。
if (verifyWindowsArtifact && !durableDownloadRoot) {
  compatibilityAliases.push([legacyWindows, manifests.get('windows:beta'), 'Windows']);
}
for (const [legacy, current, label] of compatibilityAliases) {
  assert(legacy.channel === 'beta', `${label} 旧清单必须明确标记 beta`);
  assert(legacy.version === current.version, `${label} 旧清单版本与 beta 不一致`);
  assert(legacy.download_url === current.download_url, `${label} 旧清单下载地址与 beta 不一致`);
  assert(legacy.sha256?.toLowerCase() === current.sha256.toLowerCase(), `${label} 旧清单哈希与 beta 不一致`);
}

const stableStates = ['android', 'windows']
  .map((platform) => `${platform}=${manifests.get(`${platform}:stable`).availability}`)
  .join(', ');
console.log(`发行清单验证通过：${channelPaths.map((path) => basename(path)).join(', ')}；Stable 状态：${stableStates}。`);
