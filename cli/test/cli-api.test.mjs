import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  action,
  credentialEnv,
  envelope,
  json,
  readJsonBody,
  runCli,
  startServer,
  temporaryDirectory,
} from './helpers.mjs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('PAT stdin, domain invoke and idempotency header form a clean JSON flow', async (t) => {
  const directory = await temporaryDirectory();
  let idempotency = null;
  let invokeBody = null;
  const actions = [action('library.list')];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ api_version: 'v1', actions }));
    } else if (url.pathname.endsWith('/actions/library.list/invoke')) {
      idempotency = request.headers['idempotency-key'];
      invokeBody = await readJsonBody(request);
      json(response, 200, envelope({ items: [] }, { action: 'library.list' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  const login = await runCli(
    ['auth', 'pat', '--non-interactive', '--json'],
    { env, input: 'zcpat_test_only_token' },
  );
  assert.equal(login.code, 0, login.stderr);
  assert.doesNotMatch(login.stdout, /zcpat_test_only_token/u);
  const result = await runCli(
    ['library', 'list', '--json', '--idempotency-key', 'idem-123'],
    { env },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1);
  assert.equal(JSON.parse(result.stdout).action, 'library.list');
  assert.equal(idempotency, 'idem-123');
  assert.deepEqual(invokeBody, { input: {} });
});

test('JSONL events are ordered, terminal is unique, and resume honors after', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [action('ask.start', { run_type: 'long_task', scopes: ['ask:write'] })];
  const seenAfter = [];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ api_version: 'v1', actions }));
    } else if (url.pathname.endsWith('/actions/ask.start')) {
      json(response, 200, envelope(actions[0]));
    } else if (url.pathname.endsWith('/actions/ask.start/invoke')) {
      await readJsonBody(request);
      json(response, 200, envelope(null, {
        action: 'ask.start', run_id: 'run-1', status: 'running',
      }));
    } else if (url.pathname.endsWith('/runs/run-1/events')) {
      const after = Number(url.searchParams.get('after') || request.headers['last-event-id'] || 0);
      seenAfter.push(after);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (after < 1) response.write(`id: 1\ndata: ${JSON.stringify({ sequence: 1, event: 'progress', status: 'running' })}\n\n`);
      if (after < 2) response.write(`id: 2\ndata: ${JSON.stringify({ sequence: 2, event: 'run.completed', status: 'succeeded', terminal: true })}\n\n`);
      response.end();
    } else if (url.pathname.endsWith('/runs/run-1')) {
      json(response, 200, envelope({ run: { run_id: 'run-1', status: 'succeeded' } }, {
        run_id: 'run-1', status: 'succeeded',
      }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);

  const stream = await runCli(['run', 'ask.start', '--jsonl'], { env });
  assert.equal(stream.code, 0, stream.stderr);
  const events = stream.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(events.map((item) => item.sequence), [1, 2]);
  assert.equal(events.filter((item) => item.terminal).length, 1);

  const resumed = await runCli(['run', 'resume', 'run-1', '--after', '1', '--jsonl'], { env });
  assert.equal(resumed.code, 0, resumed.stderr);
  const resumedEvents = resumed.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(resumedEvents.map((item) => item.sequence), [2]);
  assert.ok(seenAfter.includes(1));
});

test('timeout and local-unavailable use stable exit codes', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [
    action('ask.start', { run_type: 'long_task' }),
    action('local.client.update.check', { execution_location: 'local_windows' }),
  ];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) json(response, 200, envelope({ actions }));
    else if (url.pathname.endsWith('/actions/ask.start')) json(response, 200, envelope(actions[0]));
    else if (url.pathname.endsWith('/actions/local.client.update.check')) json(response, 200, envelope(actions[1]));
    else if (url.pathname.endsWith('/actions/ask.start/invoke')) {
      json(response, 200, envelope(null, { run_id: 'run-timeout', status: 'running' }));
    } else if (url.pathname.endsWith('/runs/run-timeout/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': waiting\n\n');
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);

  const timeout = await runCli(
    ['run', 'ask.start', '--jsonl', '--timeout', '200ms'],
    { env, processTimeoutMs: 5_000 },
  );
  assert.equal(timeout.code, 8);
  assert.equal(JSON.parse(timeout.stdout.trim()).error.code, 'TIMEOUT');

  const local = await runCli(
    ['run', 'local.client.update.check', '--json'],
    { env },
  );
  assert.equal(local.code, 9);
  assert.equal(JSON.parse(local.stdout).error.code, 'DESKTOP_BRIDGE_UNAVAILABLE');
});

test('local aliases keep desktop inputs exact and never poll a local run through cloud APIs', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await temporaryDirectory();
  const bridgeToken = 'desktop_bridge_private_token';
  let cloudRunPolls = 0;
  const localInputs = new Map();
  const actions = [
    action('local.platform.sync', {
      scopes: ['local:invoke'], execution_location: 'local_windows', available: false,
    }),
    action('local.platform.cancel', {
      scopes: ['local:invoke'], execution_location: 'local_windows', available: false,
    }),
    action('local.media.open', {
      scopes: ['local:invoke'], execution_location: 'local_windows', available: false,
    }),
    action('local.media.directory.choose', {
      scopes: ['local:invoke'], execution_location: 'local_windows', available: false,
    }),
  ];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions, user_hash: 'a'.repeat(64) }));
      return;
    }
    if (url.pathname.includes('/api/agent-interface/v1/runs/')) {
      cloudRunPolls += 1;
      json(response, 500, { error: { code: 'WRONG_TRANSPORT', message: 'must stay local' } });
      return;
    }
    const actionMatch = /\/v1\/actions\/(local\.[a-z.]+)\/invoke$/u.exec(url.pathname);
    if (actionMatch) {
      assert.equal(request.headers.authorization, `Bearer ${bridgeToken}`);
      localInputs.set(actionMatch[1], (await readJsonBody(request)).input);
      if (actionMatch[1] === 'local.platform.sync') {
        json(response, 200, envelope(null, {
          action: actionMatch[1], run_id: 'local-run-1', status: 'running',
        }));
      } else if (actionMatch[1] === 'local.platform.cancel') {
        json(response, 200, envelope({ canceled: true }, {
          action: actionMatch[1], run_id: 'local-run-1', status: 'canceled',
        }));
      } else if (actionMatch[1] === 'local.media.directory.choose') {
        json(response, 200, envelope({ directory_configured: true }, {
          action: actionMatch[1], run_id: 'local-ui-run-1', status: 'waiting_for_user',
        }));
      } else {
        json(response, 200, envelope({ opened: true }, { action: actionMatch[1] }));
      }
      return;
    }
    json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const descriptor = resolve(directory, 'desktop-bridge.json');
  await writeFile(descriptor, JSON.stringify({
    api_version: 'v1',
    url: server.url,
    token: bridgeToken,
    user_hash: 'a'.repeat(64),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  const env = {
    ...credentialEnv(directory, server.url),
    ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR: descriptor,
  };
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);

  const started = await runCli([
    'local', 'platform-sync', 'douyin', 'like',
    '--limit', '25', '--wait', '--json',
  ], { env });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).run_id, 'local-run-1');
  assert.match(started.stderr, /local platform-status douyin/u);
  assert.deepEqual(localInputs.get('local.platform.sync'), {
    platform: 'douyin', mode: 'like', limit: 25,
  });
  assert.equal(cloudRunPolls, 0);

  const opened = await runCli(['local', 'media-open', 'aweme_123', '--json'], { env });
  assert.equal(opened.code, 0, opened.stderr);
  assert.deepEqual(localInputs.get('local.media.open'), { aweme_id: 'aweme_123' });

  const choosingDirectory = await runCli([
    'local', 'media-directory', '--json',
  ], { env });
  assert.equal(choosingDirectory.code, 5, choosingDirectory.stderr);
  assert.equal(JSON.parse(choosingDirectory.stdout).run_id, 'local-ui-run-1');
  assert.match(choosingDirectory.stderr, /local status/u);
  assert.deepEqual(localInputs.get('local.media.directory.choose'), {});

  const canceled = await runCli(['local', 'platform-cancel', '--json'], { env });
  assert.equal(canceled.code, 8, canceled.stderr);
  assert.deepEqual(localInputs.get('local.platform.cancel'), {});
  assert.equal(cloudRunPolls, 0);
  assert.doesNotMatch(`${started.stdout}${started.stderr}${opened.stdout}${canceled.stdout}`, new RegExp(bridgeToken));
});

test('local actions reject a desktop bridge bound to another Zhicui account', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await temporaryDirectory();
  let localCalls = 0;
  const actions = [action('local.status', {
    scopes: ['local:invoke'], execution_location: 'local_windows', available: false,
  })];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions, user_hash: 'a'.repeat(64) }));
    } else if (url.pathname.includes('/v1/actions/')) {
      localCalls += 1;
      json(response, 200, envelope({ available: true }));
    } else {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
    }
  });
  t.after(server.close);
  const descriptor = resolve(directory, 'desktop-bridge.json');
  await writeFile(descriptor, JSON.stringify({
    api_version: 'v1',
    url: server.url,
    token: 'desktop_bridge_private_token',
    user_hash: 'b'.repeat(64),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  }));
  const env = {
    ...credentialEnv(directory, server.url),
    ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR: descriptor,
  };
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);

  const result = await runCli(['local', 'status', '--json'], { env });
  assert.equal(result.code, 4, result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'LOCAL_USER_MISMATCH');
  assert.equal(localCalls, 0);
});

test('real v1 nested action detail and enabled positional aliases are normalized', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [
    action('account.me', { scopes: ['account:read'] }),
    action('library.get', {
      scopes: ['library:read'],
      input_schema: {
        type: 'object',
        properties: { note_id: { type: 'string' } },
        required: ['note_id'],
        additionalProperties: false,
      },
    }),
  ];
  let runInput = null;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ interface_version: 'v1', actions }));
    } else if (url.pathname.endsWith('/actions/library.get')) {
      json(response, 200, envelope({ action: actions[1] }, { action: 'actions.get' }));
    } else if (url.pathname.endsWith('/actions/library.get/invoke')) {
      runInput = await readJsonBody(request);
      json(response, 200, envelope({ id: 'note-1' }, { action: 'library.get' }));
    } else if (url.pathname.endsWith('/actions/account.me/invoke')) {
      json(response, 200, envelope({ username: 'tester' }, { action: 'account.me' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);

  const described = await runCli(['run', 'describe', 'library.get', '--json'], { env });
  assert.equal(described.code, 0, described.stderr);
  assert.equal(JSON.parse(described.stdout).id, 'library.get');

  const library = await runCli(['library', 'get', 'note-1', '--json'], { env });
  assert.equal(library.code, 0, library.stderr);
  assert.deepEqual(runInput, { input: { note_id: 'note-1' } });

  const account = await runCli(['account', 'get', '--json'], { env });
  assert.equal(account.code, 0, account.stderr);
  assert.equal(JSON.parse(account.stdout).action, 'account.me');
});

test('device login requests only the server v1 ordinary-user scopes', async (t) => {
  const directory = await temporaryDirectory();
  let requestedScopes = null;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/auth/device')) {
      requestedScopes = (await readJsonBody(request)).scopes;
      json(response, 200, envelope({
        device_code: 'device-test',
        user_code: 'TEST-CODE',
        verification_uri: `${server.url}/verify`,
        expires_in: 60,
        interval: 1,
      }));
    } else if (url.pathname.endsWith('/auth/device/token')) {
      json(response, 200, envelope({
        access_token: 'access_test_device_token',
        refresh_token: 'refresh_test_device_token',
        expires_in: 900,
        credential: { token_prefix: 'access_test', scopes: requestedScopes },
      }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  const result = await runCli([
    'auth', 'login', '--no-open', '--non-interactive', '--json', '--timeout', '3s',
  ], { env, processTimeoutMs: 6_000 });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(requestedScopes, [
    'account:read', 'library:read', 'creator:read', 'ask:read',
    'knowledge:read', 'plan:read', 'automation:read', 'analysis:read',
    'models:read', 'feedback:read',
  ]);
  assert.match(result.stderr, /请求方：知萃 CLI/);
  assert.match(result.stderr, /请求权限：account:read, library:read/);
  assert.match(result.stderr, /验证码：TEST-CODE/);
});

test('JSONL timeout follows progress with a monotonic single terminal error', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [action('ask.start', { run_type: 'long_task', scopes: ['ask:run'] })];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) json(response, 200, envelope({ actions }));
    else if (url.pathname.endsWith('/actions/ask.start')) {
      json(response, 200, envelope({ action: actions[0] }));
    } else if (url.pathname.endsWith('/actions/ask.start/invoke')) {
      json(response, 200, envelope(null, { run_id: 'run-progress-timeout', status: 'running' }));
    } else if (url.pathname.endsWith('/runs/run-progress-timeout/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ sequence: 1, event: 'progress', status: 'running' })}\n\n`);
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);
  const result = await runCli(
    ['run', 'ask.start', '--jsonl', '--timeout', '200ms'],
    { env, processTimeoutMs: 5_000 },
  );
  assert.equal(result.code, 8);
  const messages = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(messages.map((item) => item.sequence), [1, 2]);
  assert.equal(messages.filter((item) => item.terminal).length, 1);
  assert.equal(messages[1].error.code, 'TIMEOUT');
});

test('event stream refreshes an expired access token without leaking either token', async (t) => {
  const directory = await temporaryDirectory();
  const oldToken = 'access_old_private_token';
  const newToken = 'access_new_private_token';
  const refreshToken = 'refresh_private_token';
  const actions = [action('ask.start', { run_type: 'long_task', scopes: ['ask:run'] })];
  let refreshCalls = 0;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const authorization = request.headers.authorization;
    if (url.pathname.endsWith('/actions/ask.start')) {
      json(response, 200, envelope({ action: actions[0] }));
    } else if (url.pathname.endsWith('/actions/ask.start/invoke')) {
      json(response, 200, envelope(null, { run_id: 'run-refresh', status: 'running' }));
    } else if (url.pathname.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      assert.deepEqual(await readJsonBody(request), { refresh_token: refreshToken });
      json(response, 200, envelope({
        access_token: newToken,
        refresh_token: 'refresh_rotated_private_token',
        expires_in: 900,
        credential: { token_prefix: 'access_new', scopes: ['ask:run'] },
      }));
    } else if (url.pathname.endsWith('/runs/run-refresh/events')) {
      if (authorization !== `Bearer ${newToken}`) {
        json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        sequence: 1,
        event: 'run.succeeded',
        status: 'succeeded',
        terminal: true,
      })}\n\n`);
    } else if (url.pathname.endsWith('/runs/run-refresh')) {
      json(response, 200, envelope({ run: { run_id: 'run-refresh', status: 'succeeded' } }, {
        run_id: 'run-refresh', status: 'succeeded',
      }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  await writeFile(resolve(directory, 'credential.json'), JSON.stringify({
    kind: 'device',
    access_token: oldToken,
    refresh_token: refreshToken,
    scopes: ['ask:run'],
    server_origin: server.url,
    created_at: new Date().toISOString(),
  }));
  const result = await runCli(['run', 'ask.start', '--jsonl', '--timeout', '3s'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(refreshCalls, 1);
  assert.equal(result.stdout.trim().split(/\r?\n/u).length, 1);
  for (const secret of [oldToken, newToken, refreshToken]) {
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
  }
});

test('failed and waiting JSONL runs keep one protocol event and stable exit codes', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [
    action('ask.failed', { run_type: 'long_task', scopes: ['ask:run'] }),
    action('ask.waiting', { run_type: 'long_task', scopes: ['ask:run'] }),
  ];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const actionMatch = /\/actions\/(ask\.(?:failed|waiting))$/u.exec(url.pathname);
    if (actionMatch) {
      json(response, 200, envelope({ action: actions.find((item) => item.id === actionMatch[1]) }));
    } else if (url.pathname.endsWith('/actions/ask.failed/invoke')) {
      json(response, 200, envelope(null, { run_id: 'run-failed', status: 'running' }));
    } else if (url.pathname.endsWith('/actions/ask.waiting/invoke')) {
      json(response, 200, envelope(null, { run_id: 'run-waiting', status: 'running' }));
    } else if (url.pathname.endsWith('/runs/run-failed/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        sequence: 1,
        event: 'run.failed',
        status: 'failed',
        error: { code: 'GENERATION_FAILED', message: '生成失败' },
        terminal: true,
      })}\n\n`);
    } else if (url.pathname.endsWith('/runs/run-waiting/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({
        sequence: 1,
        event: 'run.waiting_for_user',
        status: 'waiting_for_user',
        data: { prompt: '请在客户端扫码' },
        terminal: false,
      })}\n\n`);
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  await writeFile(resolve(directory, 'credential.json'), JSON.stringify({
    kind: 'pat',
    access_token: 'zcpat_test_only_token',
    server_origin: server.url,
    created_at: new Date().toISOString(),
  }));

  const failed = await runCli(['run', 'ask.failed', '--jsonl', '--timeout', '2s'], { env });
  assert.equal(failed.code, 7);
  const failedEvents = failed.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].terminal, true);

  const waiting = await runCli(['run', 'ask.waiting', '--jsonl', '--timeout', '2s'], { env });
  assert.equal(waiting.code, 5);
  const waitingEvents = waiting.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(waitingEvents.length, 1);
  assert.equal(waitingEvents[0].status, 'waiting_for_user');
  assert.equal(waitingEvents[0].terminal, false);
});

test('concurrent CLI processes serialize rotating refresh tokens', async (t) => {
  const directory = await temporaryDirectory();
  const actions = [action('library.list')];
  let refreshCalls = 0;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      json(response, 200, envelope({
        access_token: 'access_after_serial_refresh',
        refresh_token: 'refresh_after_serial_refresh',
        expires_in: 900,
        credential: { token_prefix: 'access_after', scopes: ['library:read'] },
      }));
    } else if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions }));
    } else if (url.pathname.endsWith('/actions/library.list/invoke')) {
      json(response, 200, envelope({ items: [] }, { action: 'library.list' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  await writeFile(resolve(directory, 'credential.json'), JSON.stringify({
    kind: 'device',
    access_token: 'access_expired_concurrent',
    refresh_token: 'refresh_initial_concurrent',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
    scopes: ['library:read'],
    server_origin: server.url,
    created_at: new Date().toISOString(),
  }));
  const results = await Promise.all([
    runCli(['library', 'list', '--json', '--timeout', '3s'], { env }),
    runCli(['library', 'list', '--json', '--timeout', '3s'], { env }),
  ]);
  assert.deepEqual(results.map((item) => item.code), [0, 0]);
  assert.equal(refreshCalls, 1);
});
