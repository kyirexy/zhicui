import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { runCli, temporaryDirectory } from './helpers.mjs';

function fakeEnv(directory) {
  const fake = resolve('test', 'fake-agent-client.mjs');
  return {
    ZHICUI_CODEX_COMMAND: process.execPath,
    ZHICUI_CODEX_COMMAND_ARGS: JSON.stringify([fake, 'codex']),
    ZHICUI_CLAUDE_COMMAND: process.execPath,
    ZHICUI_CLAUDE_COMMAND_ARGS: JSON.stringify([fake, 'claude']),
    ZHICUI_CODEX_CONFIG: resolve(directory, 'codex', 'config.toml'),
    ZHICUI_CLAUDE_CONFIG: resolve(directory, 'claude.json'),
    ZHICUI_CODEX_SKILLS_DIR: resolve(directory, 'codex-skills'),
    ZHICUI_CLAUDE_SKILLS_DIR: resolve(directory, 'claude-skills'),
    FAKE_CODEX_STATE: resolve(directory, 'codex-state.json'),
    FAKE_CLAUDE_STATE: resolve(directory, 'claude-state.json'),
  };
}

function runCliEntry(entry, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: resolve('.'),
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Packaged CLI test timed out: ${args.join(' ')}`));
    }, options.processTimeoutMs || 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
    child.stdin.end(options.input || '');
  });
}

test('Codex and Claude setup are idempotent and uninstall only managed entries', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'user_setting=true\n');
  await writeFile(env.ZHICUI_CLAUDE_CONFIG, '{"userSetting":true}\n');

  const first = await runCli(['agent', 'setup', '--client', 'all', '--json'], { env });
  assert.equal(first.code, 0, first.stderr);
  const second = await runCli(['agent', 'setup', '--client', 'all', '--json'], { env });
  assert.equal(second.code, 0, second.stderr);
  const codexState = JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8'));
  const claudeState = JSON.parse(await readFile(env.FAKE_CLAUDE_STATE, 'utf8'));
  assert.equal(codexState.add_count, 1);
  assert.equal(claudeState.add_count, 1);
  assert.match(await readFile(resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md'), 'utf8'), /managed-by: @zhicui\/cli/u);

  const removed = await runCli(['agent', 'uninstall', '--client', 'all', '--json'], { env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), /user_setting=true/u);
});

test('setup followed by uninstall restores untouched Codex and Claude configs byte-for-byte', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  const codexOriginal = 'user_setting = "keep spacing"\r\ncustom_flag=true';
  const claudeOriginal = '{\r\n  "userSetting" : { "keep" : true },\r\n  "theme": "dark"\r\n}';
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, codexOriginal);
  await writeFile(env.ZHICUI_CLAUDE_CONFIG, claudeOriginal);

  const setup = await runCli(['agent', 'setup', '--client', 'all', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.notEqual(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), codexOriginal);
  assert.notEqual(await readFile(env.ZHICUI_CLAUDE_CONFIG, 'utf8'), claudeOriginal);

  const uninstall = await runCli(['agent', 'uninstall', '--client', 'all', '--json'], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  const payload = JSON.parse(uninstall.stdout);
  assert.equal(payload.codex.config_restored, true);
  assert.equal(payload.claude.config_restored, true);
  assert.equal(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), codexOriginal);
  assert.equal(await readFile(env.ZHICUI_CLAUDE_CONFIG, 'utf8'), claudeOriginal);
  await assert.rejects(
    readFile(`${env.ZHICUI_CODEX_CONFIG}.zhicui-provenance.json`, 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
  await assert.rejects(
    readFile(`${env.ZHICUI_CLAUDE_CONFIG}.zhicui-provenance.json`, 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
});

test('uninstall preserves legitimate config edits made after setup while removing managed entries', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'user_setting=true\n');
  await writeFile(env.ZHICUI_CLAUDE_CONFIG, '{"userSetting":true}\n');

  const setup = await runCli(['agent', 'setup', '--client', 'all', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  const codexAfterSetup = await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8');
  await writeFile(
    env.ZHICUI_CODEX_CONFIG,
    codexAfterSetup.replace(
      '# zhicui fake managed',
      'user_after_setup="must survive"\n# zhicui fake managed',
    ),
  );
  const claudeAfterSetup = JSON.parse(await readFile(env.ZHICUI_CLAUDE_CONFIG, 'utf8'));
  claudeAfterSetup.userAfterSetup = { mustSurvive: true };
  await writeFile(env.ZHICUI_CLAUDE_CONFIG, `${JSON.stringify(claudeAfterSetup, null, 2)}\n`);

  const uninstall = await runCli(['agent', 'uninstall', '--client', 'all', '--json'], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  const payload = JSON.parse(uninstall.stdout);
  assert.equal(payload.codex.config_restored, false);
  assert.equal(payload.claude.config_restored, false);
  assert.match(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), /user_after_setup="must survive"/u);
  const claudeFinal = JSON.parse(await readFile(env.ZHICUI_CLAUDE_CONFIG, 'utf8'));
  assert.deepEqual(claudeFinal.userAfterSetup, { mustSurvive: true });
  assert.equal(claudeFinal.mcpServers?.zhicui, undefined);
  const codexState = JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8'));
  const claudeState = JSON.parse(await readFile(env.FAKE_CLAUDE_STATE, 'utf8'));
  assert.equal(codexState.configured, false);
  assert.equal(claudeState.configured, false);
});

test('uninstall rejects provenance that points outside the owned config backup namespace', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'user_setting=true\n');
  const setup = await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);

  const provenancePath = `${env.ZHICUI_CODEX_CONFIG}.zhicui-provenance.json`;
  const provenance = JSON.parse(await readFile(provenancePath, 'utf8'));
  const outsideBackup = `${directory}-must-not-be-restored.txt`;
  const outsideContent = 'unowned user file\n';
  await writeFile(outsideBackup, outsideContent);
  provenance.backup_path = outsideBackup;
  provenance.before_sha256 = createHash('sha256').update(outsideContent).digest('hex');
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

  const uninstall = await runCli(['agent', 'uninstall', '--client', 'codex', '--json'], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(JSON.parse(uninstall.stdout).codex.config_restored, false);
  assert.equal(await readFile(outsideBackup, 'utf8'), outsideContent);
});

test('failed setup restores the previous config and returns a stable failure', async () => {
  const directory = await temporaryDirectory();
  const env = { ...fakeEnv(directory), FAKE_AGENT_FAIL_ADD: 'codex' };
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'important_user_setting=true\n');
  const result = await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(result.stdout).error.code, 'AGENT_SETUP_FAILED');
  assert.equal(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), 'important_user_setting=true\n');
});

test('same-name MCP config is never treated as managed from generic words alone', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'important_user_setting=true\n');
  await writeFile(env.FAKE_CODEX_STATE, JSON.stringify({
    configured: true,
    add_count: 0,
    command: 'not-zhicui',
    args: ['mcp', 'serve', '--stdio'],
  }));

  const result = await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).error.code, 'AGENT_CONFIG_CONFLICT');
  const state = JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8'));
  assert.equal(state.add_count, 0);
  assert.equal(state.configured, true);
  assert.equal(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), 'important_user_setting=true\n');
});

test('Claude ownership check rejects a similar command with extra execution semantics', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  const expectedEntry = resolve('dist', 'index.js');
  const adversarialConfig = {
    userSetting: true,
    mcpServers: {
      zhicui: {
        type: 'stdio',
        command: process.execPath,
        args: [expectedEntry, 'mcp', 'serve', '--stdio', '--load-attacker-module'],
      },
    },
  };
  await writeFile(env.ZHICUI_CLAUDE_CONFIG, `${JSON.stringify(adversarialConfig, null, 2)}\n`);
  await writeFile(env.FAKE_CLAUDE_STATE, JSON.stringify({
    configured: true,
    add_count: 0,
    remove_count: 0,
    command: process.execPath,
    args: adversarialConfig.mcpServers.zhicui.args,
  }));

  const setup = await runCli(['agent', 'setup', '--client', 'claude', '--json'], { env });
  assert.equal(setup.code, 4);
  assert.equal(JSON.parse(setup.stdout).error.code, 'AGENT_CONFIG_CONFLICT');

  const uninstall = await runCli(['agent', 'uninstall', '--client', 'claude', '--json'], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(JSON.parse(uninstall.stdout).claude.changed, false);
  assert.deepEqual(
    JSON.parse(await readFile(env.ZHICUI_CLAUDE_CONFIG, 'utf8')),
    adversarialConfig,
  );
  const state = JSON.parse(await readFile(env.FAKE_CLAUDE_STATE, 'utf8'));
  assert.equal(state.add_count, 0);
  assert.equal(state.remove_count, 0);
  assert.equal(state.configured, true);
});

test('post-install verification failure restores both client config and skill', async () => {
  const directory = await temporaryDirectory();
  const env = { ...fakeEnv(directory), FAKE_AGENT_FAIL_GET_AFTER_ADD: 'codex' };
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'important_user_setting=true\n');
  const result = await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(result.code, 7);
  assert.equal(JSON.parse(result.stdout).error.code, 'AGENT_SETUP_FAILED');
  assert.equal(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), 'important_user_setting=true\n');
  await assert.rejects(
    readFile(resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md'), 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
});

test('setup and update refresh outdated managed Skills once without rewriting MCP config', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'important_user_setting=true\n');

  const initial = await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(initial.code, 0, initial.stderr);
  const skillPath = resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md');
  const currentSource = await readFile(resolve('skills', 'zhicui', 'SKILL.md'), 'utf8');

  const oldSetupSkill = '<!-- managed-by: @zhicui/cli -->\n# old setup skill\n';
  await writeFile(skillPath, oldSetupSkill);
  const refreshedBySetup = await runCli(
    ['agent', 'setup', '--client', 'codex', '--json'],
    { env },
  );
  assert.equal(refreshedBySetup.code, 0, refreshedBySetup.stderr);
  assert.equal(await readFile(skillPath, 'utf8'), currentSource);

  const oldUpdateSkill = '<!-- managed-by: @zhicui/cli -->\n# old update skill\n';
  await writeFile(skillPath, oldUpdateSkill);
  const refreshedByUpdate = await runCli(
    ['agent', 'update', '--client', 'codex', '--json'],
    { env },
  );
  assert.equal(refreshedByUpdate.code, 0, refreshedByUpdate.stderr);
  assert.equal(await readFile(skillPath, 'utf8'), currentSource);

  const skillDirectory = dirname(skillPath);
  const backupsBeforeRepeat = (await readdir(skillDirectory))
    .filter((name) => name.startsWith('SKILL.md.zhicui-backup-'));
  assert.equal(backupsBeforeRepeat.length, 2);
  const backupContents = await Promise.all(
    backupsBeforeRepeat.map((name) => readFile(resolve(skillDirectory, name), 'utf8')),
  );
  assert.ok(backupContents.includes(oldSetupSkill));
  assert.ok(backupContents.includes(oldUpdateSkill));

  const repeated = await runCli(['agent', 'update', '--client', 'codex', '--json'], { env });
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).codex.changed, false);
  const backupsAfterRepeat = (await readdir(skillDirectory))
    .filter((name) => name.startsWith('SKILL.md.zhicui-backup-'));
  assert.deepEqual(backupsAfterRepeat.sort(), backupsBeforeRepeat.sort());
  const state = JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8'));
  assert.equal(state.add_count, 1);
});

test('packaged Electron resources/cli layout resolves its adjacent Skill bundle', async () => {
  const directory = await temporaryDirectory();
  const packagedCli = resolve(directory, 'resources', 'cli');
  await cp(resolve('dist'), packagedCli, { recursive: true });
  await cp(resolve('skills'), resolve(packagedCli, 'skills'), { recursive: true });
  await writeFile(resolve(packagedCli, 'package.json'), '{"type":"module"}\n');

  const env = fakeEnv(directory);
  await mkdir(resolve(directory, 'codex'), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'packaged_user_setting=true\n');
  const result = await runCliEntry(
    resolve(packagedCli, 'index.js'),
    ['agent', 'setup', '--client', 'codex', '--json'],
    { env },
  );

  assert.equal(result.code, 0, result.stderr);
  const installed = await readFile(
    resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md'),
    'utf8',
  );
  assert.equal(installed, await readFile(resolve(packagedCli, 'skills', 'zhicui', 'SKILL.md'), 'utf8'));
  const state = JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8'));
  assert.equal(state.command, process.execPath);
  assert.equal(state.args[0], resolve(packagedCli, 'index.js'));
});

test('Windows command discovery skips the extensionless npm shim and launches the cmd shim', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await temporaryDirectory();
  await writeFile(resolve(directory, 'claude'), '#!/bin/sh\nexit 99\n');
  await writeFile(resolve(directory, 'claude.cmd'), [
    '@echo off',
    'if "%~1"=="--version" (',
    '  echo 9.9.9 ^(Claude Code test^)',
    '  exit /b 0',
    ')',
    'exit /b 1',
    '',
  ].join('\r\n'));

  const result = await runCli(
    ['agent', 'status', '--client', 'claude', '--json', '--non-interactive'],
    {
      env: {
        PATH: `${directory};${process.env.PATH || ''}`,
        ZHICUI_CLAUDE_COMMAND: '',
        ZHICUI_CLAUDE_COMMAND_ARGS: '',
        ZHICUI_CLAUDE_CONFIG: resolve(directory, 'claude.json'),
        ZHICUI_CLAUDE_SKILLS_DIR: resolve(directory, 'claude-skills'),
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.claude.installed, true);
  assert.match(payload.claude.version, /9\.9\.9/u);
  assert.equal(payload.claude.configured, false);
});

test('Windows PowerShell client shims receive literal argv through stdin without shell injection or argv disclosure', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await temporaryDirectory();
  const scriptPath = resolve(directory, 'claude client.ps1');
  const capturedArgsPath = resolve(directory, 'captured-args.json');
  const capturedCommandLinePath = resolve(directory, 'captured-command-line.txt');
  const injectionMarkerPath = resolve(directory, 'must-not-exist.txt');
  const secret = 'api_key=SUPERSECRET_AGENT_TEST';
  const hostileArgument = `literal; Set-Content -LiteralPath '${injectionMarkerPath}' injected`;
  await writeFile(scriptPath, [
    '@($args) | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:CAPTURED_ARGS -Encoding utf8',
    '[Environment]::CommandLine | Set-Content -LiteralPath $env:CAPTURED_COMMAND_LINE -Encoding utf8',
    "Write-Output '2.1.259 (Claude Code test)'",
    'if ($args -contains "--version") { exit 0 }',
    'exit 1',
    '',
  ].join('\r\n'));

  const result = await runCli(
    ['agent', 'status', '--client', 'claude', '--json', '--non-interactive'],
    {
      env: {
        ZHICUI_CLAUDE_COMMAND: scriptPath,
        ZHICUI_CLAUDE_COMMAND_ARGS: JSON.stringify([hostileArgument, secret]),
        ZHICUI_CLAUDE_CONFIG: resolve(directory, 'claude.json'),
        ZHICUI_CLAUDE_SKILLS_DIR: resolve(directory, 'claude-skills'),
        CAPTURED_ARGS: capturedArgsPath,
        CAPTURED_COMMAND_LINE: capturedCommandLinePath,
      },
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).claude.installed, true);
  await assert.rejects(
    readFile(injectionMarkerPath, 'utf8'),
    (error) => error?.code === 'ENOENT',
  );
  const capturedArgs = JSON.parse((await readFile(capturedArgsPath, 'utf8')).replace(/^\uFEFF/u, ''));
  assert.deepEqual(capturedArgs, [hostileArgument, secret, 'mcp', 'get', 'zhicui']);
  const commandLine = await readFile(capturedCommandLinePath, 'utf8');
  assert.doesNotMatch(commandLine, /SUPERSECRET_AGENT_TEST/u);
  assert.doesNotMatch(commandLine, /must-not-exist/u);
  assert.doesNotMatch(result.stdout, /SUPERSECRET_AGENT_TEST/u);
  assert.doesNotMatch(result.stderr, /SUPERSECRET_AGENT_TEST/u);
});
