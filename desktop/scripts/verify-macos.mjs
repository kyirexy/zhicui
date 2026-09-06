import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateSchema } = require('app-builder-lib/out/util/config/schemaValidator.js');
const schema = require('app-builder-lib/scheme.json');
const { desktopBridgeDirectory, supportsDesktopBridge } = require('../dist/platform-runtime.js');
const { applyWindowTheme } = require('../dist/window-theme.js');

const backgrounds = [];
const overlays = [];
const macWindow = { setBackgroundColor: (color) => backgrounds.push(color) };
assert.equal(applyWindowTheme('darwin', macWindow, 'dark'), true);
assert.equal(applyWindowTheme('darwin', macWindow, 'light'), true);
assert.deepEqual(backgrounds, ['#111714', '#f5f7f6']);
assert.equal(applyWindowTheme('darwin', macWindow, 'invalid'), false);
assert.equal(backgrounds.length, 2);
const windowWithOverlay = { ...macWindow, setTitleBarOverlay: (options) => overlays.push(options) };
applyWindowTheme('darwin', windowWithOverlay, 'dark');
assert.equal(overlays.length, 0);
applyWindowTheme('win32', windowWithOverlay, 'dark');
assert.deepEqual(overlays, [{ color: '#111714', symbolColor: '#e9efeb', height: 34 }]);

assert.equal(desktopBridgeDirectory('darwin', '/Users/test', 'C:\\ignored'),
  '/Users/test/Library/Application Support/Zhicui');
assert.equal(desktopBridgeDirectory('win32', 'C:\\Users\\test', 'D:\\Local'), 'D:\\Local\\Zhicui');
assert.equal(supportsDesktopBridge('darwin'), true);
assert.equal(supportsDesktopBridge('win32'), true);
assert.equal(supportsDesktopBridge('linux'), false);

const configPath = require.resolve('../electron-builder.mac.cjs');
function config() {
  delete require.cache[configPath];
  return require(configPath);
}
process.env.ZHICUI_MAC_SIGNED = '0';
for (const arch of ['arm64', 'x64']) {
  process.env.ZHICUI_MAC_ARCH = arch;
  const test = config();
  validateSchema(schema, test);
  assert.equal(test.publish, null);
  assert.equal(test.extraMetadata.nativeUpdatesEnabled, false);
  assert.equal(test.mac.identity, '-');
  assert.equal(test.mac.notarize, false);
  assert.deepEqual(test.mac.target.map(t => t.arch), [[arch], [arch]]);
}
process.env.ZHICUI_MAC_SIGNED = '1';
delete process.env.CSC_LINK;
assert.throws(config, /CSC_LINK/);
for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  process.env[key] = 'test-placeholder';
}
const signed = config();
validateSchema(schema, signed);
assert.equal(signed.forceCodeSigning, true);
assert.equal(signed.mac.notarize, true);
assert.equal(signed.mac.hardenedRuntime, true);
assert.equal(signed.extraMetadata.nativeUpdatesEnabled, true);
assert.equal(signed.publish[0].url, 'https://luxai.cn/download/mac/x64/');
process.env.ZHICUI_MAC_ARCH = 'ia32';
assert.throws(config, /架构/);
console.log('Mac 路径、平台支持、双架构与签名发布隔离验证通过');
