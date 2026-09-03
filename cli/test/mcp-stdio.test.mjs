import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  action,
  credentialEnv,
  envelope,
  json,
  runCli,
  startServer,
  temporaryDirectory,
} from './helpers.mjs';

test('stdio MCP discovers only safe actions and invokes through the registry', async (t) => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const idempotencyKeys = [];
  const actions = [
    action('library.list'),
    action('admin.users.list'),
    action('internal.research_tool'),
    action('shell.exec'),
    action('users.promote', { scopes: ['account:manage'] }),
    action('models.custom.update', {
      scopes: ['models:write'],
      input_schema: {
        type: 'object',
        properties: { api_key: { type: 'string' } },
        additionalProperties: false,
      },
    }),
    action('library.untrusted', { scopes: ['root:write'] }),
  ];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) json(response, 200, envelope({ actions }));
    else if (url.pathname.endsWith('/actions/library.list/invoke')) {
      calls += 1;
      idempotencyKeys.push(request.headers['idempotency-key']);
      json(response, 200, envelope({ items: [] }, { action: 'library.list' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);
  const input = [
    null,
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'zhicui_library_list', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'zhicui_library_list', arguments: {} } },
  ].map((item) => JSON.stringify(item)).join('\n');
  const result = await runCli(['mcp', 'serve', '--stdio'], { env, input });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].error.code, -32600);
  assert.equal(messages[1].result.protocolVersion, '2025-06-18');
  assert.deepEqual(messages[2].result.tools.map((tool) => tool.name), [
    'zhicui_run_get',
    'zhicui_run_events',
    'zhicui_library_list',
  ]);
  assert.equal(messages[3].result.isError, false);
  assert.equal(messages[4].result.isError, false);
  assert.equal(calls, 2);
  assert.equal(idempotencyKeys.length, 2);
  assert.match(idempotencyKeys[0], /^mcp-[a-f0-9]{64}$/u);
  assert.match(idempotencyKeys[1], /^mcp-[a-f0-9]{64}$/u);
  assert.notEqual(idempotencyKeys[0], idempotencyKeys[1]);
});

test('stdio MCP does not expose or accept run cancellation for a read-only credential', async (t) => {
  const directory = await temporaryDirectory();
  let cancelCalls = 0;
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions: [action('library.list')] }));
    } else if (url.pathname.endsWith('/cancel')) {
      cancelCalls += 1;
      json(response, 200, envelope({}));
    } else {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
    }
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);
  const input = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'zhicui_run_cancel', arguments: { run_id: 'run-owned' } },
  });
  const result = await runCli(['mcp', 'serve', '--stdio'], { env, input });
  assert.equal(result.code, 0, result.stderr);
  const message = JSON.parse(result.stdout.trim());
  assert.equal(message.error.code, -32000);
  assert.equal(message.error.data.code, 'ACTION_NOT_AVAILABLE');
  assert.equal(cancelCalls, 0);
});

test('stdio MCP fixed run tools use the owned-run HTTP endpoints', async (t) => {
  const directory = await temporaryDirectory();
  const calls = [];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions: [action('ask.run', {
        scopes: ['ask:run'],
        run_type: 'long_task',
      })] }));
    } else if (url.pathname.endsWith('/runs/run-owned/events')) {
      calls.push({ method: request.method, path: `${url.pathname}${url.search}`, accept: request.headers.accept });
      json(response, 200, envelope({ events: [{ sequence: 5, event: 'progress' }] }, {
        run_id: 'run-owned', status: 'running',
      }));
    } else if (url.pathname.endsWith('/runs/run-owned/cancel')) {
      calls.push({ method: request.method, path: url.pathname });
      json(response, 200, envelope({ run: { run_id: 'run-owned', status: 'canceled' } }, {
        run_id: 'run-owned', status: 'canceled',
      }));
    } else if (url.pathname.endsWith('/runs/run-owned')) {
      calls.push({ method: request.method, path: url.pathname });
      json(response, 200, envelope({ run: { run_id: 'run-owned', status: 'running' } }, {
        run_id: 'run-owned', status: 'running',
      }));
    } else {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
    }
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'zhicui_run_get', arguments: { run_id: 'run-owned' } },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'zhicui_run_events', arguments: { run_id: 'run-owned', after: 4 } },
    },
    {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'zhicui_run_cancel', arguments: { run_id: 'run-owned' } },
    },
  ].map((item) => JSON.stringify(item)).join('\n');
  const result = await runCli(['mcp', 'serve', '--stdio'], { env, input });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(messages[0].result.tools.slice(0, 3).map((tool) => tool.name), [
    'zhicui_run_get', 'zhicui_run_events', 'zhicui_run_cancel',
  ]);
  assert.deepEqual(messages.slice(1).map((message) => message.result.isError), [false, false, false]);
  assert.deepEqual(calls, [
    { method: 'GET', path: '/api/agent-interface/v1/runs/run-owned' },
    {
      method: 'GET',
      path: '/api/agent-interface/v1/runs/run-owned/events?after=4',
      accept: 'application/json',
    },
    { method: 'POST', path: '/api/agent-interface/v1/runs/run-owned/cancel' },
  ]);
});

test('stdio MCP merges a fixed local action only through a live loopback bridge', async (t) => {
  const directory = await temporaryDirectory();
  const bridgeToken = 'desktop_bridge_private_token';
  let localCalls = 0;
  const actions = [action('local.update.check', {
    scopes: ['local:invoke'],
    execution_location: 'local_windows',
    available: false,
    unavailable_reason: '需要 Windows 客户端',
  })];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions, user_hash: 'a'.repeat(64) }));
    } else if (url.pathname.endsWith('/v1/actions/local.update.check/invoke')) {
      assert.equal(request.headers.authorization, `Bearer ${bridgeToken}`);
      localCalls += 1;
      json(response, 200, envelope({ update_available: false }, { action: 'local.update.check' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
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
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'zhicui_local_update_check', arguments: {} } },
  ].map((item) => JSON.stringify(item)).join('\n');
  const result = await runCli(['mcp', 'serve', '--stdio'], { env, input });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(messages[0].result.tools.map((tool) => tool.name), [
    'zhicui_run_get',
    'zhicui_run_events',
    'zhicui_local_update_check',
  ]);
  assert.ok(messages[1]?.result, JSON.stringify(messages));
  assert.equal(messages[1].result.isError, false);
  assert.equal(localCalls, 1);
  assert.doesNotMatch(result.stdout, new RegExp(bridgeToken));
});

test('stdio MCP publishes trusted local schemas instead of drifting server schemas', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await temporaryDirectory();
  const actions = [
    action('local.platform.collect', {
      scopes: ['local:invoke'],
      execution_location: 'local_windows',
      available: false,
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    }),
    action('local.platform.cancel', {
      scopes: ['local:invoke'],
      execution_location: 'local_windows',
      available: false,
      input_schema: {
        type: 'object', properties: { platform: { type: 'string' } }, required: ['platform'],
      },
    }),
    action('local.media.open', {
      scopes: ['local:invoke'],
      execution_location: 'local_windows',
      available: false,
      input_schema: { type: 'object', additionalProperties: true },
    }),
  ];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions, user_hash: 'b'.repeat(64) }));
    }
    else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
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
  const result = await runCli(['mcp', 'serve', '--stdio'], {
    env,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(result.code, 0, result.stderr);
  const tools = JSON.parse(result.stdout).result.tools;
  const collect = tools.find((item) => item.name === 'zhicui_local_platform_collect');
  const cancel = tools.find((item) => item.name === 'zhicui_local_platform_cancel');
  const media = tools.find((item) => item.name === 'zhicui_local_media_open');
  assert.deepEqual(collect.inputSchema.required, ['platform', 'mode', 'limit']);
  assert.deepEqual(Object.keys(collect.inputSchema.properties), ['platform', 'mode', 'limit']);
  assert.equal(collect.inputSchema.additionalProperties, false);
  assert.deepEqual(cancel.inputSchema, {
    type: 'object', properties: {}, required: [], additionalProperties: false,
  });
  assert.deepEqual(media.inputSchema.required, ['aweme_id']);
  assert.deepEqual(Object.keys(media.inputSchema.properties), ['aweme_id']);
});

test('stdio MCP rejects secret arguments and redacts secret-looking result fields', async (t) => {
  const directory = await temporaryDirectory();
  const secret = 'zhc_pat_never_echo_this';
  let calls = 0;
  const actions = [action('library.list', {
    input_schema: { type: 'object', additionalProperties: true },
  })];
  const server = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) json(response, 200, envelope({ actions }));
    else if (url.pathname.endsWith('/actions/library.list/invoke')) {
      calls += 1;
      json(response, 200, envelope({
        access_token: secret,
        nested: { password: secret },
        message: `Bearer ${secret}`,
      }, { action: 'library.list' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env, input: 'zcpat_test_only_token',
  })).code, 0);
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'zhicui_library_list', arguments: { api_key: secret } },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'zhicui_library_list', arguments: {} },
    },
  ].map((item) => JSON.stringify(item)).join('\n');
  const result = await runCli(['mcp', 'serve', '--stdio'], { env, input });
  assert.equal(result.code, 0, result.stderr);
  const messages = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(messages[1].error.code, -32602);
  assert.equal(messages[1].error.data.code, 'INVALID_INPUT');
  assert.equal(calls, 1);
  assert.equal(messages[2].result.structuredContent.data.access_token, '<redacted>');
  assert.equal(messages[2].result.structuredContent.data.nested.password, '<redacted>');
  assert.equal(messages[2].result.structuredContent.data.message, 'Bearer <redacted>');
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});
