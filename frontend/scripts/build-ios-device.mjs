import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iosReleaseConfig } from './ios-release-config.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const options = process.argv.slice(2);
if (options.some((value) => value !== '--signed')) throw new Error('仅支持 --signed 参数');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const config = iosReleaseConfig({ version, buildNumber: process.env.IOS_BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || '1',
  signed: options.includes('--signed'), team: process.env.IOS_TEAM_ID, method: process.env.IOS_EXPORT_METHOD });
if (process.platform !== 'darwin') throw new Error('真机归档需要 macOS 与 Xcode，请运行云端 device 构建');
const output = resolve('ios/releases', `${config.version}-${config.buildNumber}-${config.signed ? 'signed' : 'unsigned'}`);
if (existsSync(output)) throw new Error('该构建目录已存在，请使用新的 IOS_BUILD_NUMBER，避免覆盖归档');
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败，请检查上方输出`);
};
run(process.execPath, ['scripts/build-ios-web.mjs']);
mkdirSync(output, { recursive: true });
const archive = resolve(output, 'Zhicui.xcarchive');
run('xcodebuild', [...config.archiveArgs, '-archivePath', archive, 'archive']);
run('python3', ['scripts/verify-ios-device.py', archive, '--version', config.version, '--build', config.buildNumber,
  '--report', resolve(output, 'verification.json')]);
if (config.signed) {
  const plist = resolve(output, 'ExportOptions.plist');
  writeFileSync(plist, config.exportOptions);
  run('codesign', ['--verify', '--deep', '--strict', resolve(archive, 'Products/Applications/App.app')]);
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportPath', resolve(output, 'export'),
    '-exportOptionsPlist', plist, '-allowProvisioningUpdates']);
  console.log('已完成签名归档与本地导出；未上传 App Store，也未发布安装链接。');
} else {
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', archive, resolve(output, 'zhicui-ios-device-unsigned.zip')]);
  console.log('未签名真机归档已生成，仅用于开发验证，不能直接安装到 iPhone。');
}
