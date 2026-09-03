import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialEnv, json, runCli, startServer, temporaryDirectory } from './helpers.mjs';

test('version emits exactly one clean JSON document', async () => {
  const result = await runCli(['version', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).name, '@zhicui/cli');
});

test('usage error uses exit code 2 and protocol JSON without diagnostics on stdout', async () => {
  const result = await runCli(['unknown-domain', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, 'USAGE_ERROR');
});

test('human diagnostics stay on stderr', async () => {
  const result = await runCli(['unknown-domain']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^USAGE_ERROR:/u);
});

test('secrets are rejected in argv and never echoed', async () => {
  const secret = 'zcpat_super_secret_value';
  const result = await runCli(['auth', 'login', '--token', secret, '--json']);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('secret argv aliases stay rejected after the option separator', async () => {
  const secret = 'zcpat_separator_secret';
  const result = await runCli([
    'run', 'models.secret.update', '--', '--api_key', secret, '--json',
  ]);
  assert.equal(result.code, 2);
  assert.doesNotMatch(result.stdout, new RegExp(secret));
  assert.doesNotMatch(result.stderr, new RegExp(secret));
});

test('remote plaintext HTTP cannot be enabled by an environment escape hatch', async () => {
  const result = await runCli(['version', '--json', '--api-url', 'http://example.com'], {
    env: { ZHICUI_ALLOW_INSECURE_HTTP: '1' },
  });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'USAGE_ERROR');
});

test('production credentials are never sent to an overridden origin', async (t) => {
  const directory = await temporaryDirectory();
  let requests = 0;
  const attacker = await startServer((_request, response) => {
    requests += 1;
    json(response, 500, { error: { code: 'UNEXPECTED', message: 'unexpected request' } });
  });
  t.after(attacker.close);
  const env = credentialEnv(directory, attacker.url);
  delete env.ZHICUI_CLI_DEV;
  const result = await runCli(['auth', 'status', '--verify', '--json'], { env });
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).error.code, 'USAGE_ERROR');
  assert.equal(requests, 0);
});

test('development credentials stay bound to the origin that issued them', async (t) => {
  const directory = await temporaryDirectory();
  let targetRequests = 0;
  const issuer = await startServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, {
        api_version: 'v1',
        action: null,
        request_id: 'req-origin-issuer',
        run_id: null,
        status: 'succeeded',
        data: { actions: [] },
        error: null,
        meta: {},
      });
    } else {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
    }
  });
  const target = await startServer((_request, response) => {
    targetRequests += 1;
    json(response, 500, { error: { code: 'UNEXPECTED', message: 'credential leaked' } });
  });
  t.after(issuer.close);
  t.after(target.close);

  const issuerEnv = credentialEnv(directory, issuer.url);
  const authenticated = await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env: issuerEnv,
    input: 'zcpat_origin_bound_token',
  });
  assert.equal(authenticated.code, 0, authenticated.stderr);

  const targetEnv = credentialEnv(directory, target.url);
  const result = await runCli(['auth', 'status', '--verify', '--json'], { env: targetEnv });
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).error.code, 'CREDENTIAL_ORIGIN_MISMATCH');
  assert.equal(targetRequests, 0);
});
