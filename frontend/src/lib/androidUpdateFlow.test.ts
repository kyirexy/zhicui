import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const source = readFileSync(new URL('./appUpdate.ts', import.meta.url), 'utf8');
const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const manifest = { schema_version: 2, channel: 'beta', availability: 'available', platform: 'android', artifact_kind: 'debug', version: '1.3.0', build: 30, published_at: '2026-09-14T00:00:00Z', download_url: 'https://luxai.cn/download/android/zhicui-1.3.0.apk', size_bytes: 123456, mandatory: false, release_notes: ['体验优化。'] };
function setup(payload: unknown = manifest) {
  let requests = 0; let opens = 0;
  const exports: Record<string, any> = {};
  let finishOpen: (() => void) | undefined;
  runInNewContext(javascript, {
    exports, URL, Date, AbortSignal, window: {},
    fetch: async () => { requests += 1; return { ok: true, json: async () => payload }; },
    require: (name: string) => {
      if (name === '@capacitor/core') return { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } };
      if (name === '@capacitor/app') return { App: { getInfo: async () => ({ version: '1.2.9', build: '29' }) } };
      if (name === '@capacitor/browser') return { Browser: { open: () => { opens += 1; return new Promise<void>((resolve) => { finishOpen = resolve; }); } } };
      if (name === './api') return { API_BASE: 'https://luxai.cn' };
      if (name === './releaseChannel') return { CLIENT_RELEASE_CHANNEL: 'beta' };
      throw new Error(name);
    },
  });
  return { exports, counts: () => ({ requests, opens }), finishOpen: () => finishOpen?.() };
}

test('安卓设置、前台恢复与弹窗同时检查只读取一次版本清单', async () => {
  const fixture = setup();
  const [first, second] = await Promise.all([fixture.exports.checkAndroidAppUpdate(), fixture.exports.checkAndroidAppUpdate()]);
  assert.equal(first.status, 'update-available'); assert.equal(second.release.version, '1.3.0');
  assert.equal(fixture.counts().requests, 1);
});

test('安卓渠道不可用不为解析 availability 再请求一次，也不泄露内部原因', async () => {
  const fixture = setup({ ...manifest, availability: 'unavailable', reason: 'secret cert path' });
  const result = await fixture.exports.checkAndroidAppUpdate();
  assert.equal(result.status, 'release-unavailable'); assert.equal(fixture.counts().requests, 1);
  assert.doesNotMatch(result.reason, /secret|cert/);
});

test('安卓拒绝不同渠道清单，不自动二次请求或回退旧包', async () => {
  const fixture = setup({ ...manifest, channel: 'stable' });
  await assert.rejects(fixture.exports.checkAndroidAppUpdate());
  assert.equal(fixture.counts().requests, 1);
});

test('安卓多个入口同时打开安装包共享同一个外部浏览器操作', async () => {
  const fixture = setup();
  const one = fixture.exports.openAndroidReleaseDownload(manifest.download_url);
  const two = fixture.exports.openAndroidReleaseDownload(manifest.download_url);
  assert.equal(fixture.counts().opens, 1);
  fixture.finishOpen(); await Promise.all([one, two]);
});
