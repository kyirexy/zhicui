import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { CredentialManager } from '../dist/credentials.js';
import { temporaryDirectory } from './helpers.mjs';

const credentialModule = new URL('../dist/credentials.js', import.meta.url).href;

function isolateCredentials(t, root) {
  const updates = {
    ZHICUI_CREDENTIALS_FILE: resolve(root, 'credential.json'),
    ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS: '1',
  };
  const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
  Object.assign(process.env, updates);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fakeCredential() {
  return {
    kind: 'device',
    access_token: 'fake-process-test-access-token',
    refresh_token: 'fake-process-test-refresh-token',
    created_at: new Date().toISOString(),
  };
}

function startWorker(t, script) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let stderr = '';
  let timedOut = false;
  let spawnError;
  let resolveReady;
  const ready = new Promise((resolveResult) => { resolveReady = resolveResult; });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (value) => { stderr += value; });
  child.on('message', (message) => {
    if (message.ready === true) resolveReady(true);
  });
  child.once('error', (error) => { spawnError = error.message; });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 20_000);
  const completed = new Promise((resolveResult) => {
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveReady(false);
      resolveResult({ code, signal, timedOut, spawnError, stderr });
    });
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await completed;
  });
  return { child, ready, completed };
}

test('an empty v2 refresh gate left during release is recovered with the credential intact', async (t) => {
  const root = await temporaryDirectory('zhicui-refresh-empty-');
  isolateCredentials(t, root);
  const manager = new CredentialManager('process-validation');
  const credential = fakeCredential();
  await manager.save(credential);
  const gate = resolve(root, `refresh-${manager.coordinationProfile}.v2.lock`);
  // 模拟进程删除 owner 后、删除锁目录前退出。
  await mkdir(gate);
  let entered = false;
  await manager.withRefreshLock(async () => {
    entered = true;
    assert.deepEqual(await manager.load(), { ...credential, server_origin: 'https://luxai.cn' });
  }, 1_000);
  assert.equal(entered, true);
  assert.deepEqual((await readdir(root)).sort(), ['credential.json']);
  await manager.delete();
});

test('a refresh gate held by a terminated process is recovered by another process', async (t) => {
  const root = await temporaryDirectory('zhicui-refresh-crash-');
  isolateCredentials(t, root);
  const manager = new CredentialManager('process-validation');
  const credential = fakeCredential();
  await manager.save(credential);
  const script = resolve(root, 'refresh-owner.mjs');
  await writeFile(script, `
    import { CredentialManager } from ${JSON.stringify(credentialModule)};
    const manager = new CredentialManager('process-validation');
    process.on('message', () => {});
    await manager.withRefreshLock(async () => {
      process.send({ ready: true });
      await new Promise(() => {});
    });
  `);
  const worker = startWorker(t, script);
  assert.equal(await worker.ready, true);
  const gate = resolve(root, `refresh-${manager.coordinationProfile}.v2.lock`);
  const owners = await readdir(gate);
  assert.equal(owners.length, 1);
  assert.ok(owners[0].startsWith(`owner-${worker.child.pid}-`));
  worker.child.kill();
  const stopped = await worker.completed;
  assert.equal(stopped.timedOut, false);
  assert.equal(stopped.spawnError, undefined);
  assert.equal(stopped.stderr, '');
  assert.deepEqual(await readdir(gate), owners);
  await manager.withRefreshLock(async () => {
    assert.deepEqual(await manager.load(), { ...credential, server_origin: 'https://luxai.cn' });
  }, 2_000);
  assert.deepEqual((await readdir(root)).sort(), ['credential.json', 'refresh-owner.mjs']);
  await manager.delete();
});

test('four processes serialize every refresh operation without overlapping critical sections', async (t) => {
  const root = await temporaryDirectory('zhicui-refresh-processes-');
  isolateCredentials(t, root);
  const countPath = resolve(root, 'count.txt');
  const markerPath = resolve(root, 'critical-marker');
  const script = resolve(root, 'refresh-contender.mjs');
  await writeFile(countPath, '0');
  await writeFile(script, `
    import { open, readFile, rm, writeFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    import { CredentialManager } from ${JSON.stringify(credentialModule)};
    const manager = new CredentialManager('process-' + process.pid);
    const started = new Promise((resolveStart) => process.once('message', resolveStart));
    process.send({ ready: true });
    await started;
    for (let index = 0; index < 20; index += 1) {
      await manager.withRefreshLock(async () => {
        // 独占创建标记：任何并发进入临界区都会以 EEXIST 失败。
        const marker = await open(${JSON.stringify(markerPath)}, 'wx');
        try {
          const count = Number(await readFile(${JSON.stringify(countPath)}, 'utf8'));
          await delay(3);
          await writeFile(${JSON.stringify(countPath)}, String(count + 1));
        } finally {
          await marker.close();
          await rm(${JSON.stringify(markerPath)});
        }
      });
    }
    process.disconnect();
  `);
  const workers = Array.from({ length: 4 }, () => startWorker(t, script));
  assert.deepEqual(await Promise.all(workers.map(({ ready }) => ready)), [true, true, true, true]);
  for (const { child } of workers) child.send({ start: true });
  const results = await Promise.all(workers.map(({ completed }) => completed));
  for (const result of results) {
    assert.deepEqual(result, { code: 0, signal: null, timedOut: false, spawnError: undefined, stderr: '' });
  }
  assert.equal(await readFile(countPath, 'utf8'), '80');
  assert.deepEqual((await readdir(root)).sort(), ['count.txt', 'refresh-contender.mjs']);
});
