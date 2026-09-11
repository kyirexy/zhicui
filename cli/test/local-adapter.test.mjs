import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { RestrictedLocalAdapter } from '../dist/local-adapter.js';
import { action, envelope, json, startServer, temporaryDirectory } from './helpers.mjs';

const enabled = ['win32', 'darwin'].includes(process.platform);
const userHash = 'a'.repeat(64);

async function descriptor(t, overrides = {}) {
  const root = await temporaryDirectory();
  const path = resolve(root, 'bridge.json');
  const original = process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR;
  process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR = path;
  t.after(() => {
    if (original === undefined) delete process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR;
    else process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR = original;
  });
  await writeFile(path, JSON.stringify({
    api_version: 'v1',
    url: 'http://127.0.0.1:18000',
    token: 'isolated-fake-bridge-token',
    user_hash: userHash,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  }));
  return path;
}

test('invalid descriptor expiration fails closed before contacting the desktop bridge', {
  skip: !enabled,
}, async (t) => {
  const path = await descriptor(t, { expires_at: 'invalid-date' });
  const adapter = new RestrictedLocalAdapter();
  assert.equal((await adapter.status(userHash)).available, false);
  for (const expires_at of ['', 99999999999999, {}, '1970-01-01T00:00:00Z']) {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...raw, expires_at }));
    await assert.rejects(adapter.invoke(action('local.status'), {}, 1000, undefined, userHash), {
      code: 'DESKTOP_BRIDGE_UNAVAILABLE',
    });
  }
});

test('desktop bridge refuses redirect responses without contacting their destination', {
  skip: !enabled,
}, async (t) => {
  let destinationCalls = 0;
  const destination = await startServer((_request, response) => {
    destinationCalls += 1;
    json(response, 200, envelope({ unexpected: true }));
  });
  t.after(destination.close);
  const origin = await startServer((_request, response) => {
    response.writeHead(307, { Location: `${destination.url}/unexpected` });
    response.end();
  });
  t.after(origin.close);
  await descriptor(t, { url: origin.url });
  await assert.rejects(new RestrictedLocalAdapter().invoke(
    action('local.platform.collect'), { platform: 'douyin', mode: 'collect', limit: 1 },
    1000, undefined, userHash,
  ), { code: 'DESKTOP_BRIDGE_UNAVAILABLE' });
  assert.equal(destinationCalls, 0);
});

test('valid desktop bridge invokes the same loopback service with the account bound token', {
  skip: !enabled,
}, async (t) => {
  let calls = 0;
  const server = await startServer((request, response) => {
    assert.equal(request.url, '/v1/actions/local.status/invoke');
    assert.equal(request.headers.authorization, 'Bearer isolated-fake-bridge-token');
    calls += 1;
    json(response, 200, envelope({ available: true }));
  });
  t.after(server.close);
  await descriptor(t, { url: server.url });
  const result = await new RestrictedLocalAdapter().invoke(
    action('local.status'), {}, 1000, undefined, userHash,
  );
  assert.equal(result.data.available, true);
  assert.equal(calls, 1);
});
