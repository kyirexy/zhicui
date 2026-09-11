import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { AgentApiClient } from '../dist/api-client.js';
import { CredentialManager } from '../dist/credentials.js';
import {
  credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory,
} from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function credential(overrides = {}) {
  return {
    kind: 'device',
    access_token: 'access_initial_test_only',
    refresh_token: 'refresh_initial_test_only',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function fixture(t, handler, initial = credential()) {
  const root = await temporaryDirectory('zhicui-auth-refresh-');
  const previous = process.env.ZHICUI_CONFIG_HOME;
  const previousFile = process.env.ZHICUI_CREDENTIALS_FILE;
  process.env.ZHICUI_CONFIG_HOME = root;
  delete process.env.ZHICUI_CREDENTIALS_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.ZHICUI_CONFIG_HOME;
    else process.env.ZHICUI_CONFIG_HOME = previous;
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
  const credentials = new CredentialManager('refresh-regression', server.url, store);
  await credentials.save(initial);
  const client = new AgentApiClient({ baseUrl: server.url, timeoutMs: 5_000, credentials });
  return { client, credentials, store };
}

for (const transport of ['request', 'events']) {
  test(`${transport} ignores a delayed 401 for an access token already refreshed`, async (t) => {
    let initialRequests = 0;
    let refreshedRequests = 0;
    let refreshCalls = 0;
    let secondResponse;
    const { client, credentials } = await fixture(t, async (request, response) => {
      if (request.url.endsWith('/auth/refresh')) {
        refreshCalls += 1;
        const body = await readJsonBody(request);
        assert.equal(body.refresh_token, 'refresh_initial_test_only');
        json(response, 200, envelope({
          access_token: 'access_refreshed_test_only',
          refresh_token: 'refresh_rotated_test_only',
          expires_in: 900,
        }));
      } else if (request.headers.authorization === 'Bearer access_initial_test_only') {
        initialRequests += 1;
        if (initialRequests === 1) {
          secondResponse = response;
        } else {
          json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
        }
      } else {
        assert.equal(request.headers.authorization, 'Bearer access_refreshed_test_only');
        refreshedRequests += 1;
        if (refreshedRequests === 1) {
          json(secondResponse, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
        }
        json(response, 200, envelope(transport === 'events'
          ? { items: [{ sequence: 1, status: 'succeeded', terminal: true }] }
          : { actions: [] }));
      }
    });
    const run = async () => {
      if (transport === 'request') return client.capabilities();
      const events = [];
      for await (const event of client.events('run-delayed')) events.push(event);
      assert.equal(events.length, 1);
    };
    await Promise.all([run(), run()]);
    assert.equal(refreshCalls, 1);
    assert.equal(refreshedRequests, 2);
    assert.equal((await credentials.load()).created_at, credential().created_at);
  });
}

test('concurrent expiry refreshes once when the server keeps the refresh token unchanged', async (t) => {
  let refreshCalls = 0;
  const refreshStarted = deferred();
  const allowRefresh = deferred();
  const { client, credentials } = await fixture(t, async (request, response) => {
    if (request.url.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      refreshStarted.resolve();
      await allowRefresh.promise;
      json(response, 200, envelope({ access_token: 'access_refreshed_test_only', expires_in: 900 }));
    } else {
      assert.equal(request.headers.authorization, 'Bearer access_refreshed_test_only');
      json(response, 200, envelope({ actions: [] }));
    }
  }, credential({ expires_at: '2026-01-01T00:00:00.000Z' }));
  const first = client.capabilities();
  await refreshStarted.promise;
  const secondLoaded = deferred();
  const originalLoad = credentials.load.bind(credentials);
  credentials.load = async () => {
    const result = await originalLoad();
    secondLoaded.resolve();
    return result;
  };
  const second = client.capabilities();
  await secondLoaded.promise;
  allowRefresh.resolve();
  await Promise.all([first, second]);
  assert.equal(refreshCalls, 1);
});

test('queued refresh uses the latest token even when that replacement is already expired', async (t) => {
  const sentRefreshTokens = [];
  const { client, credentials } = await fixture(t, async (request, response) => {
    if (request.url.endsWith('/auth/refresh')) {
      const body = await readJsonBody(request);
      sentRefreshTokens.push(body.refresh_token);
      json(response, 200, envelope({ access_token: 'access_refreshed_test_only', expires_in: 900 }));
    } else json(response, 200, envelope({ actions: [] }));
  }, credential({ expires_at: '2026-01-01T00:00:00.000Z' }));
  const holding = deferred();
  const release = deferred();
  const lock = credentials.withRefreshLock(async () => {
    holding.resolve();
    await release.promise;
  });
  await holding.promise;
  const loaded = deferred();
  const originalLoad = credentials.load.bind(credentials);
  credentials.load = async () => {
    const result = await originalLoad();
    loaded.resolve();
    return result;
  };
  const request = client.capabilities();
  await loaded.promise;
  await credentials.save(credential({
    access_token: 'access_already_rotated_test_only',
    refresh_token: 'refresh_already_rotated_test_only',
    expires_at: '2026-01-01T00:00:00.000Z',
  }));
  release.resolve();
  await Promise.all([lock, request]);
  assert.deepEqual(sentRefreshTokens, ['refresh_already_rotated_test_only']);
});

for (const change of ['logout', 'pat-login', 'device-login']) {
  test(`a pending refresh cannot overwrite ${change}`, async (t) => {
    const started = deferred();
    const release = deferred();
    let authenticatedRequests = 0;
    const { client, credentials } = await fixture(t, async (request, response) => {
      if (request.url.endsWith('/auth/refresh')) {
        started.resolve();
        await release.promise;
        json(response, 200, envelope({
          access_token: 'access_refreshed_test_only',
          refresh_token: 'refresh_rotated_test_only',
          expires_in: 900,
        }));
      } else {
        authenticatedRequests += 1;
        json(response, 200, envelope({ actions: [] }));
      }
    }, credential({ expires_at: '2026-01-01T00:00:00.000Z' }));
    const pending = assert.rejects(client.capabilities(), (error) => error.code === 'AUTH_REQUIRED');
    await started.promise;
    if (change === 'logout') await credentials.delete();
    else await credentials.save(credential({
      kind: change === 'pat-login' ? 'pat' : 'device',
      access_token: 'access_new_login_test_only',
      refresh_token: change === 'pat-login' ? undefined : 'refresh_new_login_test_only',
      created_at: '2026-02-01T00:00:00.000Z',
    }));
    const expected = await credentials.load();
    release.resolve();
    await pending;
    assert.deepEqual(await credentials.load(), expected);
    assert.equal(authenticatedRequests, 0);
  });
}

test('a delayed 401 cannot refresh or replay an action under a new login', async (t) => {
  const received = deferred();
  const release = deferred();
  let refreshCalls = 0;
  let actionCalls = 0;
  const { client, credentials } = await fixture(t, async (request, response) => {
    if (request.url.endsWith('/auth/refresh')) {
      refreshCalls += 1;
      json(response, 200, envelope({ access_token: 'access_unexpected_test_only', expires_in: 900 }));
    } else {
      actionCalls += 1;
      received.resolve();
      await release.promise;
      json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
    }
  });
  const pending = assert.rejects(client.invoke('plan.tasks.add', { title: '测试' }),
    (error) => error.code === 'AUTH_REQUIRED');
  await received.promise;
  await credentials.save(credential({
    access_token: 'access_new_login_test_only',
    refresh_token: 'refresh_new_login_test_only',
    created_at: '2026-02-01T00:00:00.000Z',
  }));
  release.resolve();
  await pending;
  assert.equal(refreshCalls, 0);
  assert.equal(actionCalls, 1);
});

for (const change of ['unchanged', 'logout', 'new-pat']) {
  test(`failed PAT validation preserves the ${change} credential state`, async (t) => {
    const directory = await temporaryDirectory('zhicui-pat-race-');
    const received = deferred();
    const release = deferred();
    const server = await startServer(async (request, response) => {
      if (request.headers.authorization === 'Bearer pat_invalid_test_only') {
        received.resolve();
        await release.promise;
        json(response, 401, { error: { code: 'INVALID_TOKEN', message: 'invalid' } });
      } else {
        assert.equal(request.headers.authorization, 'Bearer pat_new_login_test_only');
        json(response, 200, envelope({ actions: [] }));
      }
    });
    t.after(server.close);
    const env = credentialEnv(directory, server.url);
    const path = resolve(directory, 'credential.json');
    const previous = credential({ server_origin: server.url });
    await writeFile(path, JSON.stringify(previous));
    const pending = runCli(['auth', 'pat', '--non-interactive', '--json'], {
      env, input: 'pat_invalid_test_only',
    });
    await received.promise;
    if (change === 'logout') {
      const result = await runCli(['auth', 'logout', '--json'], { env });
      assert.equal(result.code, 0, result.stderr);
    } else if (change === 'new-pat') {
      const result = await runCli(['auth', 'pat', '--non-interactive', '--json'], {
        env, input: 'pat_new_login_test_only',
      });
      assert.equal(result.code, 0, result.stderr);
    }
    release.resolve();
    const failed = await pending;
    assert.equal(failed.code, 3, failed.stderr);
    if (change === 'logout') {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
    } else {
      const actual = JSON.parse(await readFile(path, 'utf8'));
      if (change === 'unchanged') assert.deepEqual(actual, previous);
      else assert.equal(actual.access_token, 'pat_new_login_test_only');
    }
  });
}

for (const transport of ['request', 'events']) {
  test(`${transport} retries with its refreshed snapshot when another login follows the save`, async (t) => {
    const sentTokens = [];
    const { client, credentials } = await fixture(t, async (request, response) => {
      if (request.url.endsWith('/auth/refresh')) {
        json(response, 200, envelope({
          access_token: 'access_refreshed_test_only',
          refresh_token: 'refresh_rotated_test_only',
          expires_in: 900,
        }));
      } else {
        sentTokens.push(request.headers.authorization);
        if (request.headers.authorization === 'Bearer access_initial_test_only') {
          json(response, 401, { error: { code: 'TOKEN_EXPIRED', message: 'expired' } });
        } else {
          json(response, 200, envelope(transport === 'events'
            ? { items: [{ sequence: 1, status: 'succeeded', terminal: true }] }
            : { actions: [] }));
        }
      }
    });
    const saveIfUnchanged = credentials.saveIfUnchanged.bind(credentials);
    credentials.saveIfUnchanged = async (...args) => {
      const result = await saveIfUnchanged(...args);
      await credentials.save(credential({
        access_token: 'access_new_login_test_only',
        refresh_token: 'refresh_new_login_test_only',
        created_at: '2026-02-01T00:00:00.000Z',
      }));
      return result;
    };
    if (transport === 'request') await client.invoke('plan.tasks.add', { title: '测试' });
    else {
      const events = [];
      for await (const event of client.events('run-snapshot')) events.push(event);
      assert.equal(events.length, 1);
    }
    assert.deepEqual(sentTokens, ['Bearer access_initial_test_only', 'Bearer access_refreshed_test_only']);
    assert.equal((await credentials.load()).access_token, 'access_new_login_test_only');
  });
}
