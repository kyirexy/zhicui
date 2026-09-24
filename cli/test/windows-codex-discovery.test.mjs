import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { findWindowsCodexCommand } from '../dist/agent-manager.js';
import { runCli, temporaryDirectory } from './helpers.mjs';

async function candidate(root, hash, modified, content = 'isolated executable fixture') {
  const command = join(root, 'OpenAI', 'Codex', 'bin', hash, 'codex.exe');
  await mkdir(dirname(command), { recursive: true });
  await writeFile(command, content);
  await utimes(command, modified, modified);
  return command;
}

test('official Codex discovery selects the newest complete executable, not hash or directory order', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = new Date('2025-01-01T00:00:00Z');
  const recent = new Date('2026-01-01T00:00:00Z');
  await candidate(root, 'ffffffffffffffff', old);
  const expected = await candidate(root, '1111111111111111', recent);
  await candidate(root, '2222222222222222', new Date('2027-01-01T00:00:00Z'), '');
  await candidate(root, 'not-an-official-version', new Date('2027-01-01T00:00:00Z'));
  await mkdir(join(root, 'OpenAI', 'Codex', 'bin', 'eeeeeeeeeeeeeeee', 'codex.exe'), { recursive: true });
  await mkdir(join(root, 'OpenAI', 'Codex', 'bin', 'dddddddddddddddd'), { recursive: true });
  // 配置存在与否和其他目录的同名文件，都不构成官方安装证据。
  await mkdir(join(root, '.codex'), { recursive: true });
  await writeFile(join(root, '.codex', 'codex.exe'), 'not an installation');
  assert.equal(await realpath(await findWindowsCodexCommand(root)), await realpath(expected));
  await rm(expected);
  assert.equal(await realpath(await findWindowsCodexCommand(root)),
    await realpath(join(root, 'OpenAI', 'Codex', 'bin', 'ffffffffffffffff', 'codex.exe')));
});

test('official Codex discovery rejects junction escapes, missing executables, relative and network roots', async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'codex.exe'), 'outside executable');
  const local = join(root, 'local');
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  await mkdir(bin, { recursive: true });
  await symlink(outside, join(bin, 'aaaaaaaaaaaaaaaa'), 'junction');
  assert.equal(await findWindowsCodexCommand(local), null);
  const escaped = join(root, 'escaped');
  await mkdir(escaped);
  await symlink(join(local, 'OpenAI'), join(escaped, 'OpenAI'), 'junction');
  assert.equal(await findWindowsCodexCommand(escaped), null);
  assert.equal(await findWindowsCodexCommand(join(root, 'missing')), null);
  assert.equal(await findWindowsCodexCommand('relative/AppData/Local'), null);
  assert.equal(await findWindowsCodexCommand('\\\\server\\share'), null);
});

test('Windows ordinary registered PATH discovers the desktop CLI while honoring explicit and PATH commands', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const powershell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // 从注册环境取 PATH，不能继承测试由 Codex 启动时额外注入的 Codex/bin。
  const registry = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'
      + '([Environment]::GetEnvironmentVariable("Path","Machine")+";"'
      + '+[Environment]::GetEnvironmentVariable("Path","User"))'], { encoding: 'utf8', windowsHide: true });
  assert.equal(registry.status, 0, registry.stderr);
  const registeredPath = registry.stdout.trim();
  const lookup = spawnSync(join(windows, 'System32', 'where.exe'), ['codex'], {
    env: { ...process.env, PATH: registeredPath }, cwd: windows, encoding: 'utf8', windowsHide: true,
  });
  if (lookup.status === 0) {
    t.skip('本机注册 PATH 已有 Codex，另由固定无 Codex PATH 的回归覆盖后备查找');
    return;
  }
  assert.equal(lookup.status, 1, lookup.stderr);
  await exerciseWindowsFallback(root, registeredPath);
});

test('Windows fallback works with an isolated ordinary system PATH even on machines with a registered Codex CLI', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const windows = process.env.SystemRoot || 'C:\\Windows';
  await exerciseWindowsFallback(root, [join(windows, 'System32'), windows,
    join(windows, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'));
});

async function exerciseWindowsFallback(root, desktopPath) {
  const local = join(root, 'Local');
  const config = join(root, '.codex', 'config.toml');
  await mkdir(dirname(config), { recursive: true });
  await mkdir(local);
  await writeFile(config, '# existing configuration does not imply an executable\n');
  const probe = join(root, 'probe.mjs');
  await writeFile(probe, 'if(process.argv.includes("--version")){console.log(process.execPath);process.exit(0)}process.exit(1);\n');
  const env = { PATH: desktopPath, LOCALAPPDATA: local,
    ZHICUI_CODEX_COMMAND: '', ZHICUI_CODEX_COMMAND_ARGS: JSON.stringify([probe]),
    ZHICUI_CODEX_CONFIG: config, ZHICUI_CODEX_SKILLS_DIR: join(root, 'skills') };
  const args = ['agent', 'status', '--client', 'codex', '--json', '--non-interactive'];
  let result = await runCli(args, { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).codex.installed, false);

  const executable = join(local, 'OpenAI', 'Codex', 'bin', '0123456789abcdef', 'codex.exe');
  await mkdir(dirname(executable), { recursive: true });
  // 原生可执行文件实际经 shell:false 启动；不靠返回假 where 输出模拟成功。
  await copyFile(process.execPath, executable);
  result = await runCli(args, { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).codex.installed, true);
  assert.equal(await realpath(JSON.parse(result.stdout).codex.version), await realpath(executable));

  result = await runCli(args, { env: { ...env, ZHICUI_CODEX_COMMAND: process.execPath } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await realpath(JSON.parse(result.stdout).codex.version), await realpath(process.execPath));

  const pathDirectory = join(root, 'path-bin');
  await mkdir(pathDirectory);
  await writeFile(join(pathDirectory, 'codex.cmd'), '@echo off\r\nif "%~1"=="--version" (echo PATH Codex preferred&exit /b 0)\r\nexit /b 1\r\n');
  result = await runCli(args, { env: { ...env, PATH: `${pathDirectory};${desktopPath}`, ZHICUI_CODEX_COMMAND_ARGS: '' } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).codex.version, 'PATH Codex preferred');
}
