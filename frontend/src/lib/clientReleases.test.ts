import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CLIENT_RELEASE_FALLBACKS, countedClientDownloadUrl, formatReleaseSize,
  loadClientReleaseCatalog, parseClientRelease, toAbsoluteDownloadUrl,
} from './clientReleases.ts';

const windows = {
  schema_version: 2, platform: 'windows', channel: 'beta', availability: 'available',
  architecture: 'x64', version: '1.1.9', size_bytes: 93600448,
  published_at: '2026-09-14T10:29:04.488Z', sha256: 'a'.repeat(64), code_signed: false,
  download_url: 'https://luxai.cn/download/windows/Zhicui-Setup-1.1.9-x64.exe',
};
const android = {
  schema_version: 2, platform: 'android', channel: 'beta', availability: 'available',
  version: '1.3.7', build: 29, size_bytes: 34416262,
  published_at: '2026-09-10T02:36:06.276Z', sha256: 'b'.repeat(64),
  download_url: 'https://luxai.cn/download/android/Zhicui-1.3.7-29.apk',
};

test('可信 Windows 版本化清单保留真实版本、文件大小和未签名状态', () => {
  const release = parseClientRelease(windows, 'windows', 'beta');
  assert.equal(release?.version, '1.1.9');
  assert.equal(release?.sizeBytes, windows.size_bytes);
  assert.equal(release?.downloadUrl, windows.download_url);
  assert.equal(release?.codeSigned, false);
});

test('任意 HTTPS、同域旧包、可变 latest 及 URL 混淆不能绑定新版标签', () => {
  for (const download_url of [
    'https://example.com/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    'https://luxai.cn.evil.test/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    'http://luxai.cn/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    'https://luxai.cn/download/windows/Zhicui-Setup-1.0.9-x64.exe',
    'https://luxai.cn/download/windows/Zhicui-Setup-latest-x64.exe',
    '/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    'https://user@luxai.cn/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    windows.download_url + '?version=1.1.9', windows.download_url + '#download',
    'https://luxai.cn:443/download/windows/Zhicui-Setup-1.1.9-x64.exe',
    'https://luxai.cn/download/other/../windows/Zhicui-Setup-1.1.9-x64.exe',
  ]) assert.equal(parseClientRelease({ ...windows, download_url }, 'windows', 'beta'), null, download_url);
});

test('平台、渠道、架构、清单版本与开放状态都必须匹配', () => {
  for (const patch of [
    { platform: 'android' }, { channel: 'stable' }, { channel: undefined },
    { architecture: 'arm64' }, { availability: 'unavailable' }, { schema_version: 1 },
  ]) assert.equal(parseClientRelease({ ...windows, ...patch }, 'windows', 'beta'), null);
  assert.equal(parseClientRelease(windows, 'windows', 'stable'), null);
});

test('畸形版本、大小、日期和摘要不能被部分解析为可用版本', () => {
  for (const patch of [
    { version: 'latest' }, { version: '01.1.9' }, { version: '../1.1.9' },
    { size_bytes: 0 }, { size_bytes: Infinity }, { size_bytes: 2.5 }, { size_bytes: '93600448' },
    { published_at: 'yesterday' }, { sha256: 'not-a-digest' }, { download_url: null },
  ]) assert.equal(parseClientRelease({ ...windows, ...patch }, 'windows', 'beta'), null);
});

test('稳定渠道必须明确签名，不能接受 Beta 或未知签名状态', () => {
  assert.equal(parseClientRelease({ ...windows, channel: 'stable' }, 'windows', 'stable'), null);
  assert.equal(parseClientRelease({ ...windows, channel: 'stable', code_signed: undefined }, 'windows', 'stable'), null);
  const stable = parseClientRelease({ ...windows, channel: 'stable', code_signed: true }, 'windows', 'stable');
  assert.equal(stable?.releaseStatus, 'stable_download');
});

test('Android 版本化路径同时绑定 version 和 build', () => {
  assert.equal(parseClientRelease(android, 'android', 'beta')?.build, 29);
  for (const patch of [
    { build: 28 }, { version: '1.3.6' }, { build: 1.5 },
    { download_url: 'https://luxai.cn/download/zhicui.apk' },
    { download_url: 'https://example.com/app.apk' },
  ]) assert.equal(parseClientRelease({ ...android, ...patch }, 'android', 'beta'), null);
});

test('当前实际 Windows 发行可识别，Android 可变 APK 不冒充版本锁定', () => {
  const read = (platform: string) => JSON.parse(readFileSync(new URL(`../../public/download/releases/${platform}/beta.json`, import.meta.url), 'utf8'));
  const currentWindows = read('windows');
  assert.equal(parseClientRelease(currentWindows, 'windows', 'beta')?.version, currentWindows.version);
  const currentAndroid = read('android');
  if (currentAndroid.download_url === 'https://luxai.cn/download/zhicui.apk') {
    assert.equal(parseClientRelease(currentAndroid, 'android', 'beta'), null);
  } else assert.equal(parseClientRelease(currentAndroid, 'android', 'beta')?.version, currentAndroid.version);
});

async function withFetch<T>(run: () => Promise<T>, implementation: typeof fetch): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('网络失败仅提供官方计数入口，不读取 legacy、不编造旧版本', async () => {
  const requests: string[] = [];
  const catalog = await withFetch(() => loadClientReleaseCatalog(), async (input, init) => {
    requests.push(String(input));
    assert.equal(init?.cache, 'no-store');
    assert.equal(init?.credentials, 'omit');
    assert.ok(init?.signal);
    throw new Error('offline');
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((path) => /^\/download\/releases\/(android|windows)\/beta\.json\?ts=\d+$/.test(path)));
  for (const platform of ['android', 'windows'] as const) {
    assert.equal(catalog[platform].version, null);
    assert.equal(catalog[platform].sizeBytes, null);
    assert.equal(catalog[platform].publishedAt, null);
    assert.equal(catalog[platform].downloadUrl, `https://luxai.cn/api/client-downloads/${platform}`);
  }
});

test('清单无效或只有一个平台失败时独立降为未知，不污染另一平台', async () => {
  const catalog = await withFetch(() => loadClientReleaseCatalog(), async (input) => {
    const value = String(input).includes('/windows/') ? windows : { ...android, download_url: 'https://evil.test/app.apk' };
    return Response.json(value);
  });
  assert.equal(catalog.windows.version, '1.1.9');
  assert.equal(catalog.android.version, null);
  assert.equal(catalog.android.downloadUrl, 'https://luxai.cn/api/client-downloads/android');
});

test('稳定清单不完整时明确拒绝，绝不退回 Beta 计数入口', async () => {
  await assert.rejects(withFetch(() => loadClientReleaseCatalog(undefined, 'stable'), async () => {
    return Response.json({ availability: 'unavailable' });
  }), /拒绝回退到公测安装包/);
});

test('加载前显示未知，格式化无效大小不会显示伪造文件信息', () => {
  assert.equal(CLIENT_RELEASE_FALLBACKS.windows.version, null);
  assert.equal(CLIENT_RELEASE_FALLBACKS.android.version, null);
  for (const size of [null, 0, NaN, Infinity, -1]) assert.equal(formatReleaseSize(size), '');
  assert.match(formatReleaseSize(1024 * 1024), /1\.0 MB/);
});

test('二维码始终走官方计数入口，预览域名和任意地址不成为下载来源', () => {
  assert.equal(countedClientDownloadUrl('windows'), '/api/client-downloads/windows');
  assert.equal(toAbsoluteDownloadUrl('/api/client-downloads/android', 'http://localhost:3000'), 'https://luxai.cn/api/client-downloads/android');
  assert.equal(toAbsoluteDownloadUrl('https://luxai.cn/api/client-downloads/windows', 'https://evil.test'), 'https://luxai.cn/api/client-downloads/windows');
  for (const value of ['https://evil.test/install.exe', '//evil.test/install', '/download/zhicui.apk', 'javascript:alert(1)']) {
    assert.equal(toAbsoluteDownloadUrl(value), 'https://luxai.cn/api/client-downloads/android');
  }
});
