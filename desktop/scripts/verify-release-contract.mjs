import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const identityModule = require('../dist/build-identity.js');

const nsis = packageJson.build?.nsis;
assert.equal(
  nsis?.createDesktopShortcut,
  'always',
  'NSIS 必须在覆盖安装时重建桌面快捷方式',
);
assert.equal(nsis?.createStartMenuShortcut, true, 'NSIS 必须创建开始菜单快捷方式');
assert.equal(nsis?.shortcutName, '知萃', '正式快捷方式名称必须稳定为“知萃”');
assert.equal(packageJson.build?.productName, '知萃', '正式产品名必须稳定为“知萃”');

const development = identityModule.desktopBuildIdentity(false);
assert.deepEqual(development, {
  channel: 'development',
  displayName: '知萃开发版',
  windowTitle: '知萃开发版 · 本地调试',
});

const stable = identityModule.desktopBuildIdentity(true);
assert.deepEqual(stable, {
  channel: 'stable',
  displayName: '知萃',
  windowTitle: '知萃',
});

console.log('Windows 发布契约验证通过：快捷方式、开发版与稳定版身份均正确。');
