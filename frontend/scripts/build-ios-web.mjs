import { spawnSync } from 'node:child_process';

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
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
