import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') {
  throw new Error('Mac 安装包需要 macOS。请在 GitHub Actions 的“构建知萃 Mac”工作流运行。');
}
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--signed' && !/^--arch=(arm64|x64)$/.test(arg))) {
  throw new Error('用法：npm run dist:mac -- --arch=arm64 [--signed]');
}
process.env.ZHICUI_MAC_ARCH = args.find(arg => arg.startsWith('--arch='))?.slice(7) || process.arch;
process.env.ZHICUI_MAC_SIGNED = args.includes('--signed') ? '1' : '0';
const require = createRequire(import.meta.url);
// 在安装依赖/生成产物前验证架构和签名凭据。
const config = require('../electron-builder.mac.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const iconset = join(root, 'build', 'mac', 'icon.iconset');
mkdirSync(iconset, { recursive: true });
const source = join(root, '..', 'frontend', 'public', 'icons', 'icon-512.png');
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), source,
      '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'pipe' });
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'mac', 'icon.icns')]);
for (const script of ['prepare:cli', 'build']) {
  execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
}
execFileSync(process.execPath, [join(root, 'node_modules', 'electron-builder', 'cli.js'),
  '--config', 'electron-builder.mac.cjs', '--mac', `--${process.env.ZHICUI_MAC_ARCH}`,
  '--publish', 'never'], { cwd: root, stdio: 'inherit' });
console.log(`Mac 安装包已生成：${config.directories.output}`);
