import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// 跨平台构建，Windows 不依赖 Bash 环境变量语法；Xcode 编译在 Mac 上完成。
const env = {
  ...process.env,
  CAPACITOR_BUILD: 'true',
  NEXT_PUBLIC_API_URL: 'https://luxai.cn',
};
for (const args of [
  ['scripts/prepare-ios-assets.mjs'],
  ['scripts/generate-build-version.mjs'],
  ['node_modules/next/dist/bin/next', 'build'],
  ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'ios'],
]) {
  if (args[0].includes('@capacitor/cli')) {
    // 仅移除可再生成的静态导出发行目录，不能将 Android APK 递归装进 iOS 包。
    const exportRoot = realpathSync('out');
    const downloads = resolve(exportRoot, 'download');
    if (existsSync(downloads)) {
      if (!realpathSync(downloads).startsWith(`${exportRoot}${sep}`)) {
        throw new Error('发行目录越过静态导出范围，拒绝清理');
      }
      rmSync(downloads, { recursive: true });
    }
  }
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
