import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { action, credentialEnv, envelope, json, runCli, startServer, temporaryDirectory } from './helpers.mjs';

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

test('reconcile migrates recorded old install paths, updates Skills and preserves unrelated configuration', async (t) => {
  const directory = await temporaryDirectory();
  const previousCli = resolve(directory, 'old-cli');
  await cp(resolve('dist'), resolve(previousCli, 'dist'), { recursive: true });
  await cp(resolve('skills'), resolve(previousCli, 'skills'), { recursive: true });
  await writeFile(resolve(previousCli, 'package.json'), '{"type":"module"}\n');
  const server = await startServer((_request, response) => json(response, 200, { status: 'ok' }));
  t.after(server.close);
  const env = { ...fakeEnv(directory), ...credentialEnv(directory, server.url) };
  await mkdir(dirname(env.ZHICUI_CODEX_CONFIG), { recursive: true });
  const original = 'user_setting="must survive migration"\n';
  await writeFile(env.ZHICUI_CODEX_CONFIG, original);
  const setup = await runCliEntry(resolve(previousCli, 'dist', 'index.js'), ['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  const skill = resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md');
  const custom = (await readFile(skill, 'utf8')) + '\n用户追加的工作流，请保留。\n';
  await writeFile(skill, custom);
  const status = await runCli(['agent', 'status', '--client', 'codex', '--json'], { env });
  assert.equal(JSON.parse(status.stdout).codex.migration_available, true);
  const doctor = await runCli(['agent', 'doctor', '--client', 'codex', '--json'], { env });
  assert.equal(JSON.parse(doctor.stdout).configured, true);
  assert.equal(JSON.parse(doctor.stdout).configuration_ready, false);
  assert.equal(JSON.parse(doctor.stdout).code, 'AGENT_UPDATE_REQUIRED');
  const migrated = await runCli(['agent', 'reconcile', '--client', 'all', '--json'], { env });
  assert.equal(migrated.code, 0, migrated.stderr);
  const data = JSON.parse(migrated.stdout);
  assert.equal(data.codex.migrated, true);
  assert.equal(data.codex.current, true);
  assert.equal(data.claude.skipped, true);
  assert.equal(data.claude.configured, false);
  assert.equal(await readFile(data.codex.skill_backup, 'utf8'), custom);
  const repeated = await runCli(['agent', 'reconcile', '--client', 'all', '--json'], { env });
  assert.equal(JSON.parse(repeated.stdout).codex.changed, false);
  assert.equal(JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8')).add_count, 2);
  const removed = await runCli(['agent', 'uninstall', '--client', 'codex', '--json'], { env });
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), /must survive migration/u);
});

test('reconcile preserves unknown same-name commands instead of executing or replacing them', async () => {
  const directory = await temporaryDirectory();
  const env = fakeEnv(directory);
  await mkdir(dirname(env.ZHICUI_CODEX_CONFIG), { recursive: true });
  await writeFile(env.ZHICUI_CODEX_CONFIG, 'custom=true\n');
  const oldState = { configured: true, add_count: 0, command: process.execPath,
    args: [resolve(directory, 'untrusted', 'dist', 'index.js'), 'mcp', 'serve', '--stdio'] };
  await writeFile(env.FAKE_CODEX_STATE, JSON.stringify(oldState));
  const result = await runCli(['agent', 'reconcile', '--client', 'all', '--json'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).codex.code, 'AGENT_CONFIG_CONFLICT');
  assert.deepEqual(JSON.parse(await readFile(env.FAKE_CODEX_STATE, 'utf8')), oldState);
  assert.equal(await readFile(env.ZHICUI_CODEX_CONFIG, 'utf8'), 'custom=true\n');
});

test('a failed migration restores the old registration, provenance and user Skill', async () => {
  const directory = await temporaryDirectory();
  const oldCli = resolve(directory, 'old-cli');
  await cp(resolve('dist'), resolve(oldCli, 'dist'), { recursive: true });
  await cp(resolve('skills'), resolve(oldCli, 'skills'), { recursive: true });
  await writeFile(resolve(oldCli, 'package.json'), '{"type":"module"}\n');
  const env = fakeEnv(directory);
  const setup = await runCliEntry(resolve(oldCli, 'dist', 'index.js'), ['agent', 'setup', '--client', 'codex', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  const paths = [env.ZHICUI_CODEX_CONFIG, `${env.ZHICUI_CODEX_CONFIG}.zhicui-provenance.json`,
    resolve(directory, 'codex-skills', 'zhicui', 'SKILL.md')];
  const before = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const update = await runCli(['agent', 'update', '--client', 'codex', '--json'], {
    env: { ...env, FAKE_AGENT_FAIL_ADD: 'codex' },
  });
  assert.equal(update.code, 7);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path, 'utf8'))), before);
});

for (const mode of ['missing-auth', 'revoked', 'disabled', 'offline', 'empty-tools', 'unsafe-tools', 'ready']) {
  test(`doctor distinguishes configuration, authorization, Agent availability and MCP tools: ${mode}`, async (t) => {
    const directory = await temporaryDirectory();
    let capabilityCalls = 0;
    const server = await startServer((request, response) => {
      if (request.url === '/api/health') return json(response, mode === 'offline' ? 503 : 200, { status: 'ok' });
      capabilityCalls++;
      if (mode === 'revoked') return json(response, 401, { error: { code: 'TOKEN_REVOKED', message: 'revoked' } });
      if (mode === 'disabled') return json(response, 503, { error: { code: 'INTERFACE_DISABLED', message: 'disabled' } });
      if (mode === 'offline') return json(response, 503, { error: { code: 'HTTP_503', message: 'offline' } });
      return json(response, 200, envelope({ user_hash: 'isolated-doctor-owner',
        actions: mode === 'empty-tools' ? [] : [action(mode === 'unsafe-tools' ? 'shell.exec' : 'library.list')] }));
    });
    t.after(server.close);
    const env = { ...fakeEnv(directory), ...credentialEnv(directory, server.url) };
    if (mode !== 'missing-auth') await writeFile(env.ZHICUI_CREDENTIALS_FILE, JSON.stringify({
      kind: 'pat', access_token: 'isolated_doctor_token', created_at: '2026-01-01T00:00:00Z', server_origin: server.url,
    }));
    assert.equal((await runCli(['agent', 'setup', '--client', 'codex', '--json'], { env })).code, 0);
    const result = await runCli(['agent', 'doctor', '--client', 'codex', '--json', '--timeout', '3s'], { env });
    assert.equal(result.code, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.configured, true);
    assert.equal(data.configuration_ready, true);
    assert.equal(data.ok, mode === 'ready');
    assert.equal(data.ready, mode === 'ready');
    assert.equal(data.authenticated, ['empty-tools', 'unsafe-tools', 'ready'].includes(mode));
    assert.equal(data.cloud_available, ['empty-tools', 'unsafe-tools', 'ready'].includes(mode));
    assert.equal(data.mcp_healthy, mode === 'ready');
    assert.equal(data.checks[0].ready, data.ready);
    assert.equal(data.code, { 'missing-auth': 'AUTH_REQUIRED', revoked: 'TOKEN_REVOKED', disabled: 'INTERFACE_DISABLED',
      offline: 'HTTP_503', 'empty-tools': 'TOOLS_UNAVAILABLE', 'unsafe-tools': 'MCP_UNAVAILABLE', ready: 'READY' }[mode]);
    if (mode === 'missing-auth') assert.equal(capabilityCalls, 0);
    if (mode === 'ready') assert.equal(capabilityCalls, 2); // capabilities + 真正 stdio tools/list
    assert.doesNotMatch(result.stdout + result.stderr, /isolated_doctor_token/u);
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
  // macOS 的 /var 是符号链接，比较实际文件路径，兼容 Node 的路径规范化。
  assert.equal(await realpath(state.args[0]), await realpath(resolve(packagedCli, 'index.js')));
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

test('agent probes honor the user timeout when an installed client hangs', async () => {
  const directory = await temporaryDirectory();
  const scriptPath = resolve(directory, 'hanging-client.mjs');
  await writeFile(scriptPath, 'setTimeout(() => process.exit(0), 15000);\n');
  const started = Date.now();
  const result = await runCli(
    ['agent', 'status', '--client', 'claude', '--timeout', '100ms', '--json'],
    {
      processTimeoutMs: 4000,
      env: {
        ZHICUI_CLAUDE_COMMAND: process.execPath,
        ZHICUI_CLAUDE_COMMAND_ARGS: JSON.stringify([scriptPath]),
        ZHICUI_CLAUDE_CONFIG: resolve(directory, 'claude.json'),
        ZHICUI_CLAUDE_SKILLS_DIR: resolve(directory, 'claude-skills'),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.claude.installed, false);
  assert.match(payload.claude.error, /超时/u);
  assert.ok(Date.now() - started < 3000);
});

test('Claude custom config directory is used for ownership checks and restoration', async () => {
  const directory = await temporaryDirectory();
  const claudeRoot = resolve(directory, 'custom-claude');
  const claudeConfig = resolve(claudeRoot, '.claude.json');
  const original = '{"isolatedCustomConfig":true}\n';
  await mkdir(claudeRoot, { recursive: true });
  await writeFile(claudeConfig, original);
  const env = {
    ...fakeEnv(directory),
    CLAUDE_CONFIG_DIR: claudeRoot,
    ZHICUI_CLAUDE_CONFIG: '',
  };
  const setup = await runCli(['agent', 'setup', '--client', 'claude', '--json'], { env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(JSON.parse(setup.stdout).claude.managed, true);
  const uninstall = await runCli(['agent', 'uninstall', '--client', 'claude', '--json'], { env });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(await readFile(claudeConfig, 'utf8'), original);
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
