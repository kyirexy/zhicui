import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { findDesktopExecutable, readWindowsDesktopExecutable } from '../dist/desktop-launch.js';
import { temporaryDirectory } from './helpers.mjs';

test('中文安装记录不丢失路径，且普通发现不会启动客户端', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, '应用 程序');
  await mkdir(directory);
  const executable = join(directory, process.platform === 'win32' ? '知萃.exe' : '知萃');
  await writeFile(executable, 'inert installation fixture');
  await writeFile(join(root, 'desktop-agent-launch.json'), JSON.stringify({
    version: 1, origin: 'https://luxai.cn', executable,
  }));
  assert.equal(await findDesktopExecutable(join(root, 'bridge.json')), executable);
});

test('Windows 首次调用以 Unicode 读取真实协议注册，过期安装记录回退到当前安装', {
  skip: process.platform !== 'win32',
}, async (t) => {
  // 只读现有注册表；不注册测试协议，也不启动或修改实际客户端。
  const registry = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
      + "(Get-Item -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\zhicui\\shell\\open\\command' -ErrorAction Stop).GetValue('')"],
    { windowsHide: true, encoding: 'utf8' });
  if (registry.status !== 0) { t.skip('此环境尚未安装知萃'); return; }
  const expected = /^\s*"([^"]+\.exe)"(?:\s|$)/i.exec(registry.stdout)?.[1];
  assert.ok(expected?.endsWith('知萃.exe') || expected?.endsWith('知萃公测版.exe'));
  assert.equal(await readWindowsDesktopExecutable(), expected);
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await findDesktopExecutable(join(root, 'bridge.json')), expected);
  await writeFile(join(root, 'desktop-agent-launch.json'), JSON.stringify({
    version: 1, origin: 'https://luxai.cn', executable: join(root, '已卸载', '知萃.exe'),
  }));
  assert.equal(await findDesktopExecutable(join(root, 'bridge.json')), expected);
});
