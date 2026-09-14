import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { CLI_ENTRY, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory } from './helpers.mjs';

function startPayload(url, extra = {}) {
  return { device_code: 'machine_code_never_public', user_code: 'TEST-CODE',
    verification_uri_complete: `${url}/verify?device_code=machine_code_never_public&user_code=TEST-CODE`,
    expires_in: 60, interval: 1, ...extra };
}

function tokens() {
  return { access_token: 'device_access_never_public', refresh_token: 'device_refresh_never_public',
    expires_in: 900, scopes: ['library:read'] };
}

test('device JSONL emits only safe authorization fields and one terminal success', async (t) => {
  const directory = await temporaryDirectory();
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/auth/device')) return json(response, 200, envelope(startPayload(server.url)));
    assert.equal((await readJsonBody(request)).device_code, 'machine_code_never_public');
    return json(response, 200, envelope(tokens()));
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  const result = await runCli(['auth', 'login', '--jsonl', '--no-open', '--non-interactive', '--timeout', '3s'], { env });
  assert.equal(result.code, 0, result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'device_authorization');
  assert.equal(events[0].status, 'waiting_for_user');
  assert.equal(events[0].user_code, 'TEST-CODE');
  assert.deepEqual([...new URL(events[0].verification_url).searchParams.keys()], ['user_code']);
  assert.equal(events[1].event, 'authorization_complete');
  assert.equal(events[1].authenticated, true);
  assert.equal(events.filter((event) => event.terminal).length, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /machine_code_never_public|device_access_never_public|device_refresh_never_public/u);
  assert.equal(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')).access_token, tokens().access_token);
});

test('device authorization rejects another origin before emitting a URL or polling', async (t) => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const server = await startServer((_request, response) => {
    calls++;
    json(response, 200, envelope(startPayload('https://untrusted.invalid')));
  });
  t.after(server.close);
  const result = await runCli(['auth', 'login', '--jsonl', '--no-open', '--non-interactive'], {
    env: credentialEnv(directory, server.url),
  });
  assert.equal(result.code, 7);
  assert.equal(calls, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /untrusted.invalid|machine_code_never_public/u);
});

for (const change of ['logout', 'new-login']) {
  test(`a pending device authorization cannot overwrite ${change}`, async (t) => {
    const directory = await temporaryDirectory();
    let env;
    const server = await startServer(async (request, response) => {
      if (request.url.endsWith('/auth/device')) return json(response, 200, envelope(startPayload(server.url)));
      if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions: [] }));
      const result = change === 'logout'
        ? await runCli(['auth', 'logout', '--json'], { env })
        : await runCli(['auth', 'pat', '--non-interactive', '--json'], { env, input: 'new_login_must_survive' });
      assert.equal(result.code, 0, result.stderr);
      return json(response, 200, envelope(tokens()));
    });
    t.after(server.close);
    env = credentialEnv(directory, server.url);
    const result = await runCli(['auth', 'login', '--jsonl', '--no-open', '--non-interactive', '--timeout', '4s'], { env });
    assert.equal(result.code, 3, result.stderr);
    const events = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(events.filter((event) => event.terminal).length, 1);
    assert.equal(events.at(-1).error.code, 'AUTH_REQUIRED');
    if (change === 'logout') await assert.rejects(readFile(env.ZHICUI_CREDENTIALS_FILE), { code: 'ENOENT' });
    else assert.equal(JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8')).access_token, 'new_login_must_survive');
  });
}

test('canceling the independent authorization process preserves existing credentials', async (t) => {
  const directory = await temporaryDirectory();
  let polls = 0;
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/auth/device')) return json(response, 200, envelope(startPayload(server.url)));
    polls++;
    return json(response, 200, envelope(tokens()));
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  const original = JSON.stringify({ kind: 'pat', access_token: 'existing_authorization',
    created_at: '2026-01-01T00:00:00Z', server_origin: server.url });
  await writeFile(env.ZHICUI_CREDENTIALS_FILE, original);
  const child = spawn(process.execPath, [CLI_ENTRY, 'auth', 'login', '--jsonl', '--no-open', '--non-interactive'], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => child.kill());
  child.stdin.end();
  let output = '';
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('waiting for device event')), 4000);
    child.on('error', fail);
    child.stdout.on('data', (data) => {
      output += data;
      if (output.includes('\n')) { child.kill(); clearTimeout(timer); done(); }
    });
  });
  await new Promise((done) => child.once('close', done));
  assert.equal(polls, 0);
  assert.equal(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'), original);
});
