import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApiClient } from '../dist/api-client.js';
import { CredentialManager } from '../dist/credentials.js';
import { envelope, json, readJsonBody, startServer, temporaryDirectory } from './helpers.mjs';

const initialCredential = {
  kind: 'device',
  access_token: 'access_session_a_test_only',
  refresh_token: 'refresh_session_a_test_only',
  created_at: '2026-01-01T00:00:00.000Z',
};
const mediaBytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);

async function fixture(t, handler) {
  const directory = await temporaryDirectory('zhicui-client-session-');
  const previousRoot = process.env.ZHICUI_CONFIG_HOME;
  const previousFile = process.env.ZHICUI_CREDENTIALS_FILE;
  process.env.ZHICUI_CONFIG_HOME = directory;
  delete process.env.ZHICUI_CREDENTIALS_FILE;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.ZHICUI_CONFIG_HOME;
    else process.env.ZHICUI_CONFIG_HOME = previousRoot;
    if (previousFile === undefined) delete process.env.ZHICUI_CREDENTIALS_FILE;
    else process.env.ZHICUI_CREDENTIALS_FILE = previousFile;
  });
  const server = await startServer(handler);
  t.after(server.close);
  const values = new Map();
  const store = {
    kind: 'isolated-memory',
    async load(profile) { return structuredClone(values.get(profile) ?? null); },
    async save(profile, value) { values.set(profile, structuredClone(value)); },
    async delete(profile) { values.delete(profile); },
  };
  const credentials = new CredentialManager('batch-session-regression', server.url, store);
  await credentials.save(initialCredential);
  const original = new AgentApiClient({ baseUrl: server.url, timeoutMs: 5_000, credentials });
  return { client: await original.bindCurrentSession(), original, credentials };
}

const operations = {
  resolve: (client) => client.invoke('library.media.resolve', { url: 'https://v.douyin.com/test/' }),
  download: (client) => client.downloadLibraryMedia('note-test', async () => {}),
};

for (const [operation, run] of Object.entries(operations)) {
  for (const change of ['new-login', 'kind-change', 'logout']) {
    test(`bound ${operation} rejects ${change} after capabilities before sending a request`, async (t) => {
      const requests = [];
      const { client, original, credentials } = await fixture(t, (request, response) => {
        requests.push({ url: request.url, authorization: request.headers.authorization });
        json(response, 200, envelope({ actions: [] }));
      });
      assert.notEqual(client, original);
      await client.capabilities();
      if (change === 'logout') await credentials.delete();
      else await credentials.save({
        ...initialCredential,
        access_token: 'access_session_b_test_only',
        refresh_token: 'refresh_session_b_test_only',
        kind: change === 'kind-change' ? 'pat' : 'device',
        created_at: change === 'new-login' ? '2026-02-01T00:00:00.000Z' : initialCredential.created_at,
      });
      await assert.rejects(run(client), (error) => {
        assert.equal(error.code, 'AUTH_REQUIRED');
        assert.doesNotMatch(JSON.stringify(error.toPayload()), /access_session|refresh_session/);
        return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(requests[0].authorization, `Bearer ${initialCredential.access_token}`);
      await assert.rejects(client.bindCurrentSession(), { code: 'AUTH_REQUIRED' });
    });
  }

  test(`bound ${operation} allows token refresh within the same login generation`, async (t) => {
    const tokens = [];
    let refreshes = 0;
    const { client, credentials } = await fixture(t, async (request, response) => {
      if (request.url.endsWith('/auth/refresh')) {
        refreshes += 1;
        assert.equal((await readJsonBody(request)).refresh_token, initialCredential.refresh_token);
        return json(response, 200, envelope({
          access_token: 'access_refreshed_same_session',
          refresh_token: 'refresh_rotated_same_session',
          expires_in: 900,
        }));
      }
      tokens.push(request.headers.authorization);
      if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions: [] }));
      if (request.headers.authorization === `Bearer ${initialCredential.access_token}`) {
        return json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
      }
      assert.equal(request.headers.authorization, 'Bearer access_refreshed_same_session');
      if (operation === 'download') {
        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end(mediaBytes);
      } else json(response, 200, envelope({ result: { media_id: 'media-test' } }));
    });
    await client.capabilities();
    await run(client);
    assert.equal(refreshes, 1);
    assert.equal((await credentials.load()).created_at, initialCredential.created_at);
    assert.deepEqual(tokens, [
      `Bearer ${initialCredential.access_token}`,
      `Bearer ${initialCredential.access_token}`,
      'Bearer access_refreshed_same_session',
    ]);
  });

  test(`bound ${operation} rejects a login changed immediately after refresh was saved`, async (t) => {
    const tokens = [];
    const { client, credentials } = await fixture(t, (request, response) => {
      if (request.url.endsWith('/auth/refresh')) return json(response, 200, envelope({
        access_token: 'access_refreshed_same_session', expires_in: 900,
      }));
      tokens.push(request.headers.authorization);
      if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions: [] }));
      json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
    });
    await client.capabilities();
    const saveIfUnchanged = credentials.saveIfUnchanged.bind(credentials);
    credentials.saveIfUnchanged = async (expected, replacement) => {
      const saved = await saveIfUnchanged(expected, replacement);
      if (saved && expected.access_token !== replacement.access_token) {
        await credentials.save({
          ...initialCredential,
          access_token: 'access_session_b_test_only',
          created_at: '2026-02-01T00:00:00.000Z',
        });
      }
      return saved;
    };
    await assert.rejects(run(client), { code: 'AUTH_REQUIRED' });
    assert.deepEqual(tokens, [
      `Bearer ${initialCredential.access_token}`, `Bearer ${initialCredential.access_token}`,
    ]);
    assert.equal((await credentials.load()).access_token, 'access_session_b_test_only');
  });
}

for (const [operation, run] of Object.entries(operations)) {
  test(`${operation} keeps valid body/header rate-limit waits and discards invalid values`, async (t) => {
    let scenario;
    const { client } = await fixture(t, (_request, response) => {
      if (scenario.header !== undefined) response.setHeader('Retry-After', scenario.header);
      const error = { code: 'RATE_LIMITED', message: 'private upstream https://media.invalid/?secret=hidden' };
      if (scenario.body !== undefined) error.retry_after_seconds = scenario.body;
      if (scenario.text) {
        response.writeHead(429, { 'Content-Type': 'text/plain' });
        response.end(error.message);
      } else json(response, scenario.status ?? 429, { error });
    });
    for (scenario of [
      { body: 23, expected: 23 },
      { header: '41', expected: 41 },
      { body: 75, header: '41', expected: 75 },
      { body: 4, header: '41', expected: 41 },
      { body: 0, header: '41', expected: 41 },
      { body: -9, header: '41', expected: 41 },
      { body: NaN, header: '41', expected: 41 },
      { body: '4', header: '41', expected: 41 },
      { body: 23, header: '-1', expected: 23 },
      { body: 23, header: 'NaN', expected: 23 },
      { body: -9, header: '-1', expected: undefined },
      { body: NaN, header: 'NaN', expected: undefined },
      { header: '27', text: true, expected: 27 },
      ...(operation === 'resolve' ? [{ body: 4, header: '41', status: 200, expected: 41 }] : []),
    ]) {
      await assert.rejects(run(client), (error) => {
        assert.equal(error.code, 'RATE_LIMITED');
        assert.equal(error.retryAfterSeconds, scenario.expected, JSON.stringify(scenario));
        assert.equal(error.toPayload().retry_after_seconds, scenario.expected);
        if (operation === 'download') assert.doesNotMatch(JSON.stringify(error.toPayload()), /private upstream|media\.invalid|hidden/);
        return true;
      });
    }
  });

  test(`${operation} honors HTTP-date Retry-After without rounding the required wait down`, async (t) => {
    let body = 2;
    const deadline = Math.floor(Date.now() / 1_000) * 1_000 + 120_000;
    const { client } = await fixture(t, (_request, response) => {
      response.setHeader('Retry-After', new Date(deadline).toUTCString());
      json(response, 429, { error: { code: 'RATE_LIMITED', message: '稍后重试', retry_after_seconds: body } });
    });
    const before = Date.now();
    await assert.rejects(run(client), (error) => {
      const after = Date.now();
      assert.ok(error.retryAfterSeconds >= Math.ceil((deadline - after) / 1_000));
      assert.ok(error.retryAfterSeconds <= Math.ceil((deadline - before) / 1_000));
      return true;
    });
    body = 240;
    await assert.rejects(run(client), (error) => error.retryAfterSeconds === 240);
  });
}
