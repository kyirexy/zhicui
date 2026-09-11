import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, rmdir, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { CredentialManager } from '../dist/credentials.js';
import { runCli, temporaryDirectory } from './helpers.mjs';

function isolateEnvironment(t, updates) {
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fakeCredential() {
  return {
    kind: 'pat',
    access_token: 'fake-local-only-no-real-token',
    created_at: new Date().toISOString(),
    scopes: ['library:read', '中文测试'],
  };
}

test('Windows DPAPI encrypts, roundtrips and deletes an isolated credential without plaintext', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await temporaryDirectory('zhicui-dpapi-test-');
  isolateEnvironment(t, {
    ZHICUI_CONFIG_HOME: root,
    ZHICUI_CREDENTIALS_FILE: undefined,
    ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: undefined,
  });
  const credential = fakeCredential();
  const manager = new CredentialManager('isolated-validation');
  await manager.save(credential);
  assert.deepEqual(await manager.load(), { ...credential, server_origin: 'https://luxai.cn' });
  assert.equal(manager.store.kind, 'windows-dpapi-current-user');
  const files = await readdir(root);
  assert.equal(files.length, 1);
  const cipher = await readFile(resolve(root, files[0]), 'utf8');
  assert.ok(!cipher.includes(credential.access_token));
  await manager.delete();
  assert.equal(await manager.load(), null);
});

test('credential replacement never exposes a missing login to concurrent readers', async (t) => {
  const root = await temporaryDirectory();
  isolateEnvironment(t, {
    ZHICUI_CREDENTIALS_FILE: resolve(root, 'credential.json'),
    ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1',
  });
  const manager = new CredentialManager('isolated-validation');
  const credential = fakeCredential();
  await manager.save(credential);
  let reading = true;
  let missing = 0;
  let readError;
  const reader = (async () => {
    while (reading) {
      if (!(await manager.load())) missing += 1;
    }
  })().catch((error) => { readError = error; });
  try {
    for (let index = 0; index < 50; index += 1) await manager.save(credential);
  } finally {
    reading = false;
    await reader;
    await manager.delete();
  }
  assert.equal(readError, undefined);
  assert.equal(missing, 0);
});

test('corrupted stored credentials return a stable error without quoting secret content', async () => {
  const root = await temporaryDirectory();
  const path = resolve(root, 'credential.json');
  const secret = 'PRIVATE_CREDENTIAL_FRAGMENT';
  await writeFile(path, secret);
  const result = await runCli(['auth', 'status', '--json'], {
    env: { ZHICUI_CREDENTIALS_FILE: path },
  });
  assert.equal(JSON.parse(result.stdout).error.code, 'CREDENTIAL_CORRUPTED');
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
});

test('credential replacement makes progress under continuous readers in other processes', async (t) => {
  const root = await temporaryDirectory();
  const path = resolve(root, 'credential.json');
  isolateEnvironment(t, { ZHICUI_CREDENTIALS_FILE: path, ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1' });
  const manager = new CredentialManager('isolated-validation');
  await manager.save(fakeCredential());
  const workerScript = resolve(root, 'credential-reader.mjs');
  const credentialModule = new URL('../dist/credentials.js', import.meta.url).href;
  await writeFile(workerScript, `
    import { CredentialManager } from ${JSON.stringify(credentialModule)};
    const manager = new CredentialManager('isolated-validation');
    let stopped = false;
    process.on('message', () => { stopped = true; });
    let reads = 0;
    try {
      while (!stopped) {
        const credential = await manager.load();
        if (!credential || credential.access_token !== 'fake-local-only-no-real-token') throw new Error('INVALID_READ');
        reads += 1;
        if (reads === 1) process.send({ ready: true });
      }
      process.send({ reads });
      process.disconnect();
    } catch (error) {
      process.send({ error: error.code || error.message });
      process.exit(1);
    }
  `);
  const workers = Array.from({ length: 4 }, () => {
    const child = spawn(process.execPath, [workerScript], {
      env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    const state = { child, ready: false, reads: 0, error: undefined };
    const ready = new Promise((resolveReady, reject) => {
      child.on('message', (message) => {
        if (message.ready) { state.ready = true; resolveReady(); }
        if (message.reads) state.reads = message.reads;
        if (message.error) { state.error = message.error; reject(new Error(message.error)); }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (!state.ready) reject(new Error(`reader exited before ready: ${code}`));
      });
    });
    const completed = new Promise((resolveDone) => child.once('close', (code) => resolveDone(code)));
    return { ...state, ready, completed, state };
  });
  const timer = setTimeout(() => workers.forEach(({ child }) => child.kill()), 20_000);
  try {
    await Promise.all(workers.map(({ ready }) => ready));
    for (let index = 0; index < 100; index += 1) await manager.save(fakeCredential());
    workers.forEach(({ child }) => { if (child.connected) child.send({ stop: true }); });
    const codes = await Promise.all(workers.map(({ completed }) => completed));
    assert.deepEqual(codes, [0, 0, 0, 0]);
    for (const { state } of workers) {
      assert.equal(state.error, undefined);
      assert.ok(state.reads > 1);
    }
  } finally {
    clearTimeout(timer);
    workers.forEach(({ child }) => child.kill());
    await Promise.all(workers.map(({ completed }) => completed));
    await manager.delete();
  }
});

test('an active credential writer expires with the old credential intact', async (t) => {
  const root = await temporaryDirectory();
  const path = resolve(root, 'credential.json');
  isolateEnvironment(t, { ZHICUI_CREDENTIALS_FILE: path, ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1' });
  const manager = new CredentialManager('isolated-validation');
  await manager.save(fakeCredential());
  const before = await readFile(path, 'utf8');
  const gate = `${path}.write-lock`;
  const owner = resolve(gate, `owner-${process.pid}-${randomUUID()}`);
  await mkdir(gate);
  await writeFile(owner, '');
  const started = Date.now();
  try {
    await assert.rejects(manager.save({ ...fakeCredential(), access_token: 'fake-replacement-token' }), {
      code: 'TIMEOUT',
    });
    assert.ok(Date.now() - started < 8_000);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.deepEqual((await readdir(root)).sort(), ['credential.json', 'credential.json.write-lock']);
  } finally {
    await rm(owner, { force: true });
    await rmdir(gate);
    await manager.delete();
  }
});

test('a credential writer from an exited process is recovered without deleting its value', async (t) => {
  const root = await temporaryDirectory();
  const path = resolve(root, 'credential.json');
  isolateEnvironment(t, { ZHICUI_CREDENTIALS_FILE: path, ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1' });
  const manager = new CredentialManager('isolated-validation');
  await manager.save(fakeCredential());
  const gate = `${path}.write-lock`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { mkdir, writeFile } from 'node:fs/promises';
    const gate = ${JSON.stringify(gate)};
    await mkdir(gate);
    await writeFile(gate + '/owner-' + process.pid + '-${randomUUID()}', '');
  `], { stdio: 'ignore', windowsHide: true });
  assert.equal(await new Promise((resolveExit) => child.once('close', resolveExit)), 0);
  assert.equal((await manager.load()).access_token, fakeCredential().access_token);
  await manager.save(fakeCredential());
  assert.equal((await manager.load()).access_token, fakeCredential().access_token);
  await manager.delete();
  assert.deepEqual(await readdir(root), []);
});

test('an old timestamp never steals a rotating refresh lock from its live owner', async (t) => {
  const root = await temporaryDirectory();
  isolateEnvironment(t, { ZHICUI_CREDENTIALS_FILE: resolve(root, 'credential.json') });
  const manager = new CredentialManager('isolated-validation');
  const gate = resolve(root, `refresh-${manager.coordinationProfile}.v2.lock`);
  let release;
  let ready;
  const held = new Promise((resolveHeld) => { release = resolveHeld; });
  const acquired = new Promise((resolveReady) => { ready = resolveReady; });
  let secondEntered = false;
  const first = manager.withRefreshLock(async () => {
    const staleTime = new Date(Date.now() - 120_000);
    await utimes(gate, staleTime, staleTime);
    ready();
    await held;
  });
  try {
    await acquired;
    await assert.rejects(manager.withRefreshLock(async () => { secondEntered = true; }, 150), { code: 'TIMEOUT' });
    assert.equal(secondEntered, false);
  } finally {
    release();
    await first;
  }
  await manager.withRefreshLock(async () => { secondEntered = true; }, 150);
  assert.equal(secondEntered, true);
  const legacyGate = resolve(root, `refresh-${manager.storageProfile}.lock`);
  await mkdir(legacyGate);
  const legacyTime = new Date(Date.now() - 120_000);
  await utimes(legacyGate, legacyTime, legacyTime);
  secondEntered = false;
  try {
    await assert.rejects(manager.withRefreshLock(async () => { secondEntered = true; }, 150), { code: 'TIMEOUT' });
    assert.equal(secondEntered, false);
  } finally {
    await rmdir(legacyGate);
  }
  assert.deepEqual(await readdir(root), []);
});

test('a timed-out system store does not fork credentials into plaintext fallback', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = await temporaryDirectory();
  isolateEnvironment(t, {
    ZHICUI_CONFIG_HOME: root,
    ZHICUI_CREDENTIALS_FILE: undefined,
    ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1',
  });
  const manager = new CredentialManager('isolated-validation');
  await manager.save(fakeCredential());
  const path = resolve(root, `credential-${manager.storageProfile}.dpapi`);
  const before = await readFile(path, 'utf8');
  const gate = `${path}.write-lock`;
  const owner = resolve(gate, `owner-${process.pid}-${randomUUID()}`);
  await mkdir(gate);
  await writeFile(owner, '');
  try {
    await Promise.all([
      assert.rejects(manager.save({ ...fakeCredential(), access_token: 'fake-new-system-token' }), { code: 'TIMEOUT' }),
      assert.rejects(manager.load(), { code: 'TIMEOUT' }),
    ]);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.ok(!(await readdir(root)).some((name) => name.endsWith('.json')));
  } finally {
    await rm(owner, { force: true });
    await rmdir(gate);
    await manager.delete();
  }
});
