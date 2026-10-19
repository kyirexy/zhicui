import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory,
} from './helpers.mjs';

const machineCode = 'auth_recovery_fake_machine_code';
const userCode = 'ABCD-EFGH';
const loginArgs = ['auth', 'login', '--jsonl', '--no-open', '--non-interactive',
  '--scopes', 'library:read', '--timeout', '8s'];
const startPayload = (url) => ({ device_code: machineCode, user_code: userCode,
  verification_uri_complete: `${url}/agent/authorize?user_code=${userCode}`,
  expires_in: 60, interval: 1 });
const tokens = { access_token: 'auth_recovery_fake_access_token', expires_in: 900, scopes: ['library:read'] };
const eventsOf = (result) => result.stdout.trim().split('\n').filter(Boolean).map(JSON.parse);

test('device polling retries a socket reset with the same code and starts authorization only once', async (t) => {
  const directory = await temporaryDirectory('zhicui-auth-recovery-');
  let starts = 0;
  const polledCodes = [];
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/auth/device')) {
      starts += 1;
      assert.deepEqual((await readJsonBody(request)).scopes, ['library:read']);
      return json(response, 200, envelope(startPayload(server.url)));
    }
    assert.ok(request.url.endsWith('/auth/device/token'));
    polledCodes.push((await readJsonBody(request)).device_code);
    if (polledCodes.length === 1) {
      request.socket.destroy();
      return;
    }
    return json(response, 200, envelope(tokens));
  });
  t.after(server.close);
  const result = await runCli(loginArgs, { processTimeoutMs: 12_000,
    env: { ...credentialEnv(directory, server.url), ZHICUI_CONFIG_HOME: directory } });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(starts, 1);
  assert.deepEqual(polledCodes, [machineCode, machineCode]);
  const events = eventsOf(result);
  assert.deepEqual(events.map(event => event.event), ['device_authorization', 'authorization_complete']);
  assert.equal(events.filter(event => event.terminal).length, 1);
  assert.equal(events.at(-1).authenticated, true);
  assert.deepEqual(events.at(-1).scopes, ['library:read']);
  assert.equal(events.at(-1).scopes_source, 'server');
  assert.equal(events.at(-1).scopes_complete, true);
  assert.match(result.stderr, /无需重新打开授权页/u);
  assert.doesNotMatch(result.stdout + result.stderr, /auth_recovery_fake_machine_code|auth_recovery_fake_access_token/u);
});

test('device polling fails on malformed JSON instead of retrying protocol errors', async (t) => {
  const directory = await temporaryDirectory('zhicui-auth-malformed-');
  let starts = 0;
  let polls = 0;
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/auth/device')) {
      starts += 1;
      return json(response, 200, envelope(startPayload(server.url)));
    }
    assert.ok(request.url.endsWith('/auth/device/token'));
    polls += 1;
    assert.equal((await readJsonBody(request)).device_code, machineCode);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{broken_json');
  });
  t.after(server.close);
  const result = await runCli(loginArgs, {
    env: { ...credentialEnv(directory, server.url), ZHICUI_CONFIG_HOME: directory } });
  assert.equal(result.code, 7, result.stderr);
  assert.equal(starts, 1);
  assert.equal(polls, 1);
  const events = eventsOf(result);
  assert.deepEqual(events.map(event => event.event), ['device_authorization', 'error']);
  assert.equal(events.at(-1).error.code, 'REMOTE_FAILURE');
  assert.equal(events.filter(event => event.terminal).length, 1);
  assert.doesNotMatch(result.stderr, /正在等待授权服务恢复/u);
});

test('a same-origin verification URL with a network-path pathname cannot become an external authorization URL', async (t) => {
  const directory = await temporaryDirectory('zhicui-auth-url-');
  let starts = 0;
  let polls = 0;
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/auth/device')) {
      starts += 1;
      return json(response, 200, envelope({ ...startPayload(server.url),
        verification_uri_complete: `${server.url}//untrusted.invalid/approve?user_code=${userCode}` }));
    }
    polls += 1;
    return json(response, 200, envelope(tokens));
  });
  t.after(server.close);
  const result = await runCli(loginArgs, {
    env: { ...credentialEnv(directory, server.url), ZHICUI_CONFIG_HOME: directory } });
  assert.equal(result.code, 7, result.stderr);
  assert.equal(starts, 1);
  assert.equal(polls, 0);
  const events = eventsOf(result);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'error');
  assert.equal(events[0].error.code, 'REMOTE_FAILURE');
  assert.equal(events[0].terminal, true);
  assert.doesNotMatch(result.stdout + result.stderr, /untrusted\.invalid|verification_url|ABCD-EFGH|auth_recovery_fake_machine_code/u);
});

test('missing token scopes remain unknown in the login result, stored credential and auth status', async (t) => {
  const directory = await temporaryDirectory('zhicui-auth-unknown-scopes-');
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/auth/device')) {
      assert.deepEqual((await readJsonBody(request)).scopes, ['library:read', 'library:write']);
      return json(response, 200, envelope(startPayload(server.url)));
    }
    assert.ok(request.url.endsWith('/auth/device/token'));
    return json(response, 200, envelope({ access_token: tokens.access_token, expires_in: 900 }));
  });
  t.after(server.close);
  const env = { ...credentialEnv(directory, server.url), ZHICUI_CONFIG_HOME: directory };
  const result = await runCli(['auth', 'login', '--jsonl', '--no-open', '--non-interactive',
    '--scopes', 'library:read,library:write', '--timeout', '4s'], { env });
  assert.equal(result.code, 0, result.stderr);
  const completed = eventsOf(result).at(-1);
  assert.equal(completed.authenticated, true);
  assert.equal(completed.scopes, null);
  assert.equal(completed.scopes_source, 'unknown');
  assert.equal(completed.scopes_complete, false);
  const stored = JSON.parse(await readFile(env.ZHICUI_CREDENTIALS_FILE, 'utf8'));
  assert.equal(Object.hasOwn(stored, 'scopes'), false);
  assert.equal(stored.scopes_complete, false);
  const statusResult = await runCli(['auth', 'status', '--json'], { env });
  assert.equal(statusResult.code, 0, statusResult.stderr);
  const status = JSON.parse(statusResult.stdout);
  assert.equal(status.scopes, null);
  assert.equal(status.scopes_source, 'unknown');
  assert.equal(status.scopes_complete, false);
});
