import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform !== 'win32') {
  process.exit(0);
}

const target = resolve(
  'node_modules',
  'app-builder-lib',
  'out',
  'util',
  'electronGet.js',
);
const source = await readFile(target, 'utf8');
let patched = source;

const tryMarker = `    try {
        // rm + mkdir happen AFTER acquiring the lock`;
const tryReplacement = `    let zhicuiWindowsLockReleased = false;
    try {
        // rm + mkdir happen AFTER acquiring the lock`;
const renameMarker = `        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmpDir, dir);`;
const renameReplacement = `        await fs.rm(dir, { recursive: true, force: true });
        // proper-lockfile keeps an open handle associated with tmpDir on
        // Windows. Release it before the atomic rename or Node returns EPERM.
        await release().catch(err => builder_util_1.log.warn({ err }, "failed to release lockfile"));
        zhicuiWindowsLockReleased = true;
        await fs.rename(tmpDir, dir);`;
const finallyMarker = `        await release().catch(err => builder_util_1.log.warn({ err }, "failed to release lockfile"));
    }
}`;
const finallyReplacement = `        if (!zhicuiWindowsLockReleased) {
            await release().catch(err => builder_util_1.log.warn({ err }, "failed to release lockfile"));
        }
    }
}`;

if (!patched.includes('let zhicuiWindowsLockReleased = false;')) {
  if (
    !patched.includes(tryMarker)
    || !patched.includes(renameMarker)
    || !patched.includes(finallyMarker)
  ) {
    throw new Error(
      'electron-builder 内部结构已变化，请更新 Windows 目录锁兼容补丁。',
    );
  }

  patched = patched
    .replace(tryMarker, tryReplacement)
    .replace(renameMarker, renameReplacement)
    .replace(finallyMarker, finallyReplacement);
}

const singleRename = '        await fs.rename(tmpDir, dir);';
const retryRename = `        for (let renameAttempt = 0; ; renameAttempt += 1) {
            try {
                await fs.rename(tmpDir, dir);
                break;
            }
            catch (error) {
                if (renameAttempt >= 20 || (error === null || error === void 0 ? void 0 : error.code) !== "EPERM") {
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
        }`;

if (!patched.includes('for (let renameAttempt = 0; ; renameAttempt += 1)')) {
  if (!patched.includes(singleRename)) {
    throw new Error('未找到 electron-builder 的 Windows 重命名步骤。');
  }
  patched = patched.replace(singleRename, retryRename);
}

if (patched !== source) {
  await writeFile(target, patched, 'utf8');
}
