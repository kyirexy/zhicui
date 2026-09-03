import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

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


async function authenticated(directory, serverUrl) {
  const env = credentialEnv(directory, serverUrl);
  const result = await runCli(['auth', 'pat', '--non-interactive', '--json'], {
    env,
    input: 'zcpat_secure_direct_test',
  });
  assert.equal(result.code, 0, result.stderr);
  return env;
}


test('account export accepts password only from secure stdin and never overwrites', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'personal.zip');
  const archive = Buffer.from('PK\x03\x04safe-personal-data', 'binary');
  let exportCalls = 0;
  const actions = [action('account.data.export', {
    scopes: ['account:manage'], secure_direct: true, mcp_exposed: false,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  })];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions }));
    } else if (url.pathname.endsWith('/secure/account/data-export')) {
      exportCalls += 1;
      assert.deepEqual(await readJsonBody(request), { password: 'private-password' });
      response.writeHead(200, { 'Content-Type': 'application/zip' });
      response.end(archive);
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = await authenticated(directory, server.url);

  const result = await runCli([
    'account', 'export', '--output', output, '--non-interactive', '--json',
  ], { env, input: 'private-password\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(output), archive);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private-password/u);
  assert.equal(JSON.parse(result.stdout).output, output);

  const second = await runCli([
    'account', 'export', '--output', output, '--non-interactive', '--json',
  ], { env, input: 'another-password\n' });
  assert.notEqual(second.code, 0);
  assert.equal(JSON.parse(second.stdout).error.code, 'OUTPUT_EXISTS');
  assert.deepEqual(await readFile(output), archive);
  assert.equal(exportCalls, 1);
});


test('account delete keeps password phrase and confirmation token out of protocol output', async (t) => {
  const directory = await temporaryDirectory();
  const token = 'confirmation_token_private_value';
  let confirmed = false;
  const actions = [action('account.delete', {
    scopes: ['account:manage'], secure_direct: true, mcp_exposed: false,
  })];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions }));
    } else if (url.pathname.endsWith('/secure/account/delete/prepare')) {
      assert.deepEqual(await readJsonBody(request), { password: 'delete-password' });
      json(response, 200, envelope({
        confirmation_token: token,
        confirmation_phrase: '永久注销',
      }));
    } else if (url.pathname.endsWith('/secure/account/delete/confirm')) {
      assert.deepEqual(await readJsonBody(request), {
        confirmation_token: token,
        confirmation_phrase: '永久注销',
      });
      confirmed = true;
      json(response, 200, envelope({ deleted: true }, { action: 'account.delete' }));
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = await authenticated(directory, server.url);
  const result = await runCli(['account', 'delete', '--non-interactive', '--json'], {
    env,
    input: 'delete-password\n永久注销\n',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(confirmed, true);
  for (const secret of ['delete-password', '永久注销', token]) {
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, 'u'));
  }
  const status = await runCli(['auth', 'status', '--json'], { env });
  assert.equal(JSON.parse(status.stdout).authenticated, false);
});


test('model secret update accepts one raw stdin line and rejects argv or JSON', async (t) => {
  const directory = await temporaryDirectory();
  let prepareCalls = 0;
  let writeCalls = 0;
  const actions = [action('models.secret.update', {
    scopes: ['models:write'], secure_direct: true, mcp_exposed: false,
  })];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions }));
    } else if (url.pathname.endsWith('/secure/models/secret')) {
      const body = await readJsonBody(request);
      if (!body.confirmation_id) {
        prepareCalls += 1;
        assert.deepEqual(body, { target: 'chat', model_id: 'model-1' });
        json(response, 409, envelope(null, {
          action: 'models.secret.update', status: 'failed',
          error: {
            code: 'CONFIRMATION_REQUIRED', message: '该操作需要用户确认',
            retryable: false, details: { confirmation_id: 'confirm-secret-1' },
          },
        }));
      } else {
        writeCalls += 1;
        assert.deepEqual(body, {
          target: 'chat', model_id: 'model-1',
          confirmation_id: 'confirm-secret-1', api_key: 'sk-private-key',
        });
        json(response, 200, envelope({
          target: 'chat', configuration: { id: 'model-1', api_key_masked: 'sk-••••-key' },
        }, { action: 'models.secret.update' }));
      }
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = await authenticated(directory, server.url);

  const pending = await runCli([
    'models', 'secret-update', '--target', 'chat', '--model-id', 'model-1',
    '--non-interactive', '--json',
  ], { env });
  assert.equal(pending.code, 5, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).error.details.confirmation_id, 'confirm-secret-1');
  assert.equal(prepareCalls, 1);
  assert.equal(writeCalls, 0);

  const ok = await runCli([
    'models', 'secret-update', '--target', 'chat', '--model-id', 'model-1',
    '--confirmation-id', 'confirm-secret-1', '--non-interactive', '--json',
  ], { env, input: 'sk-private-key\n' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(`${ok.stdout}${ok.stderr}`, /sk-private-key/u);
  assert.equal(writeCalls, 1);

  const argv = await runCli([
    'models', 'secret-update', '--target', 'chat', '--model-id', 'model-1',
    '--api-key', 'sk-argv', '--non-interactive', '--json',
  ], { env });
  assert.notEqual(argv.code, 0);
  assert.equal(writeCalls, 1);

  const ordinaryJson = await runCli([
    'models', 'secret-update', '--target', 'chat', '--model-id', 'model-1',
    '--confirmation-id', 'confirm-secret-1', '--non-interactive', '--json',
  ], { env, input: '{"api_key":"sk-json"}' });
  assert.notEqual(ordinaryJson.code, 0);
  assert.equal(writeCalls, 1);
});


test('custom model create keeps API key in no-echo stdin and out of output', async (t) => {
  const directory = await temporaryDirectory();
  let prepareCalls = 0;
  let writeCalls = 0;
  const actions = [action('models.custom.create', {
    scopes: ['models:write'], secure_direct: true, mcp_exposed: false,
  })];
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) {
      json(response, 200, envelope({ actions }));
    } else if (url.pathname.endsWith('/secure/models/custom')) {
      const body = await readJsonBody(request);
      const metadata = {
        name: '工作模型',
        provider_name: 'OpenAI Compatible',
        model: 'gpt-example',
        api_base: 'https://models.example/v1',
        enabled: true,
        select: true,
      };
      if (!body.confirmation_id) {
        prepareCalls += 1;
        assert.deepEqual(body, metadata);
        json(response, 409, envelope(null, {
          action: 'models.custom.create', status: 'failed',
          error: {
            code: 'CONFIRMATION_REQUIRED', message: '该操作需要用户确认',
            retryable: false, details: { confirmation_id: 'confirm-create-1' },
          },
        }));
      } else {
        writeCalls += 1;
        assert.deepEqual(body, {
          ...metadata,
          confirmation_id: 'confirm-create-1',
          api_key: 'sk-create-private',
        });
        json(response, 200, envelope({
          configuration: {
            id: 'model-new', name: '工作模型', api_key_masked: 'sk-••••-vate',
          },
          plaintext_secret_persisted: false,
        }, { action: 'models.custom.create' }));
      }
    } else json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = await authenticated(directory, server.url);

  const pending = await runCli([
    'models', 'custom-create', '--name', '工作模型',
    '--provider-name', 'OpenAI Compatible', '--model', 'gpt-example',
    '--api-base', 'https://models.example/v1', '--select',
    '--non-interactive', '--json',
  ], { env });
  assert.equal(pending.code, 5, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).error.details.confirmation_id, 'confirm-create-1');
  assert.equal(prepareCalls, 1);
  assert.equal(writeCalls, 0);

  const ok = await runCli([
    'models', 'custom-create', '--name', '工作模型',
    '--provider-name', 'OpenAI Compatible', '--model', 'gpt-example',
    '--api-base', 'https://models.example/v1', '--select',
    '--confirmation-id', 'confirm-create-1', '--non-interactive', '--json',
  ], { env, input: 'sk-create-private\n' });
  assert.equal(ok.code, 0, ok.stderr);
  assert.doesNotMatch(`${ok.stdout}${ok.stderr}`, /sk-create-private/u);
  assert.equal(writeCalls, 1);

  const argv = await runCli([
    'models', 'custom-create', '--name', '工作模型',
    '--provider-name', 'OpenAI Compatible', '--model', 'gpt-example',
    '--api-base', 'https://models.example/v1', '--api-key', 'sk-argv',
    '--non-interactive', '--json',
  ], { env });
  assert.notEqual(argv.code, 0);
  assert.equal(writeCalls, 1);

  const ordinaryJson = await runCli([
    'models', 'custom-create', '--name', '工作模型',
    '--provider-name', 'OpenAI Compatible', '--model', 'gpt-example',
    '--api-base', 'https://models.example/v1', '--confirmation-id', 'confirm-create-1',
    '--non-interactive', '--json',
  ], { env, input: '{"api_key":"sk-json"}' });
  assert.notEqual(ordinaryJson.code, 0);
  assert.equal(writeCalls, 1);
});
