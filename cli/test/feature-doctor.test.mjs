import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApiClient } from '../dist/api-client.js';
import { CliError } from '../dist/errors.js';
import { diagnoseFeatures } from '../dist/feature-doctor.js';
import { action, envelope, json, startServer } from './helpers.mjs';

function fixture(published, visible = published) {
  const calls = [];
  return {
    calls,
    client: {
      publicCapabilities: async () => { calls.push('public'); return published; },
      capabilities: async () => { calls.push('credential'); return visible; },
      invoke: async () => assert.fail('诊断不能执行 Action'),
      startDeviceAuthorization: async () => assert.fail('诊断不能发起授权'),
    },
  };
}

function findAction(report, id) {
  const found = report.features.flatMap(feature => feature.actions).find(item => item.id === id);
  assert.ok(found, `报告应包含 ${id}`);
  return found;
}

test('core distinguishes published scope gaps from unpublished creator and analysis actions', async () => {
  const library = action('library.list');
  const creator = action('creator.list', { scopes: ['creator:read'] });
  const knowledge = action('knowledge.list', { scopes: ['knowledge:read'] });
  const published = { release_profile: 'core', feature_enabled: true, actions: [library, creator, knowledge] };
  const f = fixture(published, { actions: [library], scopes: [{ id: 'creator:read' }, { id: 'knowledge:read' }] });
  const report = await diagnoseFeatures(f.client);
  assert.equal(report.release_profile, 'core');
  assert.equal(findAction(report, 'library.list').status, 'accessible');
  assert.equal(findAction(report, 'creator.list').status, 'scope_missing');
  assert.deepEqual(findAction(report, 'creator.list').required_scopes, ['creator:read']);
  assert.equal(findAction(report, 'knowledge.list').status, 'scope_missing');
  assert.equal(findAction(report, 'creator.resolve').status, 'not_published');
  assert.equal(findAction(report, 'analysis.run.prepare').status, 'not_published');
  assert.match(findAction(report, 'creator.resolve').next_step, /重复登录不会/);
  assert.deepEqual(f.calls.sort(), ['credential', 'public']);
  assert.equal(report.read_only, true);
  assert.equal(report.execution_verified, false);
  assert.equal(report.connector_health, 'not_checked');
});

test('discovery uses each action scope requirements and never the global scope catalogue as grants', async () => {
  const available = action('plan.list', { scopes: ['plan:read'] });
  const unscoped = action('plan.get', { scopes: [] });
  const f = fixture({ actions: [available, unscoped] }, { actions: [], scopes: ['plan:read'] });
  const report = await diagnoseFeatures(f.client);
  assert.equal(findAction(report, 'plan.list').status, 'scope_missing');
  assert.equal(findAction(report, 'plan.get').status, 'unknown');
});

test('missing credentials preserve public evidence without starting login', async () => {
  const f = fixture({ release_profile: 'core', actions: [action('library.list')] });
  f.client.capabilities = async () => { throw new CliError('AUTH_REQUIRED', 'secret-token'); };
  const report = await diagnoseFeatures(f.client);
  assert.equal(report.discovery.credential.status, 'auth_required');
  assert.equal(findAction(report, 'library.list').status, 'auth_required');
  assert.equal(findAction(report, 'creator.resolve').status, 'not_published');
  assert.doesNotMatch(JSON.stringify(report), /secret-token/);
});

test('credential discovery network errors are not scope gaps and do not erase release evidence', async () => {
  for (const code of ['TIMEOUT', 'REMOTE_FAILURE', 'HTTP_500', 'HTTP_503', 'RATE_LIMITED', 'INTERFACE_PROFILE_INVALID']) {
    const f = fixture({ release_profile: 'core', actions: [action('library.list')] });
    f.client.capabilities = async () => { throw new CliError(code, 'sensitive response', { details: { token: 'private-token' } }); };
    const report = await diagnoseFeatures(f.client);
    assert.equal(report.discovery.credential.status, 'service_unavailable');
    assert.equal(findAction(report, 'library.list').status, 'service_unavailable');
    assert.equal(findAction(report, 'creator.resolve').status, 'not_published');
    assert.equal(report.status_counts.scope_missing, undefined);
    assert.doesNotMatch(JSON.stringify(report), /sensitive response|private-token/);
  }
});

test('failed or malformed public discovery cannot declare actions unpublished or missing scopes', async () => {
  for (const invalid of [{}, { actions: [null] }, { actions: [action('library.list'), action('library.list')] }]) {
    const report = await diagnoseFeatures(fixture(invalid, { actions: [] }).client);
    assert.equal(report.discovery.public.status, 'unknown');
    assert.equal(findAction(report, 'creator.resolve').status, 'unknown');
    assert.equal(report.status_counts.scope_missing, undefined);
    assert.equal(report.status_counts.not_published, undefined);
  }
  const f = fixture({}, { actions: [action('library.list')] });
  f.client.publicCapabilities = async () => { throw new CliError('HTTP_503', 'server private detail'); };
  const report = await diagnoseFeatures(f.client);
  assert.equal(findAction(report, 'library.list').status, 'service_unavailable');
  assert.equal(report.status_counts.not_published, undefined);
});

test('disabled interface or cloud action is unavailable while local descriptor does not prove bridge failure', async () => {
  const local = action('local.platform.sync', { available: false, scopes: ['local:invoke'], execution_location: 'local_windows' });
  const cloud = action('library.list', { available: false });
  const report = await diagnoseFeatures(fixture({ actions: [local, cloud] }).client);
  assert.equal(findAction(report, local.id).status, 'unknown');
  assert.match(findAction(report, local.id).next_step, /本次未检查或启动桌面/);
  assert.equal(findAction(report, cloud.id).status, 'service_unavailable');
  for (const disabledSide of ['public', 'credential']) {
    const enabled = { actions: [action('library.list')] }, disabled = { feature_enabled: false, actions: [] };
    const f = disabledSide === 'public' ? fixture(disabled, enabled) : fixture(enabled, disabled);
    assert.equal(findAction(await diagnoseFeatures(f.client), 'library.list').status, 'service_unavailable');
  }
});

test('forbidden discovery and inconsistent action visibility are unknown, never inferred as scope denial', async () => {
  const f = fixture({ actions: [action('library.list')] });
  f.client.capabilities = async () => { throw new CliError('FORBIDDEN', 'Access denied'); };
  const report = await diagnoseFeatures(f.client);
  assert.equal(findAction(report, 'library.list').status, 'unknown');
  assert.equal(report.discovery.credential.error_code, 'DISCOVERY_FORBIDDEN');
  const inconsistent = await diagnoseFeatures(fixture({ actions: [] }, { actions: [action('library.list')] }).client);
  assert.equal(findAction(inconsistent, 'library.list').status, 'unknown');
});

test('schema restrictions and secure direct download remain explicit without asserting execution health', async () => {
  const transcript = action('library.transcript.generate', { input_schema: { properties: { operation: { enum: ['transcript'] } } } });
  const ask = action('ask.turn.start', { input_schema: { properties: { web_scope: { enum: ['video_only'] } } } });
  const sync = action('creator.sync.start', { input_schema: { properties: {
    operation: { enum: ['catalog_all'] }, auto_transcribe: { enum: [false] },
  } } });
  const download = action('library.media.download', { secure_direct: true, mcp_exposed: false });
  const report = await diagnoseFeatures(fixture({ release_profile: 'video_intake', actions: [transcript, ask, sync, download] }).client);
  assert.equal(report.release_profile, 'video_intake');
  assert.deepEqual(findAction(report, transcript.id).input_constraints, { operation: ['transcript'] });
  assert.deepEqual(findAction(report, ask.id).input_constraints, { web_scope: ['video_only'] });
  assert.deepEqual(findAction(report, sync.id).input_constraints, { operation: ['catalog_all'], auto_transcribe: [false] });
  assert.equal(findAction(report, download.id).status, 'accessible');
  assert.equal(report.connector_health, 'not_checked');
});

test('all requested product areas are represented and standalone REST products stay not_integrated', async () => {
  const report = await diagnoseFeatures(fixture({ release_profile: 'full', actions: [action('automation.list')] }).client);
  assert.deepEqual(report.features.map(feature => feature.id), [
    'library', 'sync_recap', 'extract', 'creator', 'download', 'ask', 'daily_research', 'knowledge', 'plan', 'analysis', 'studio',
  ]);
  for (const id of ['daily_research', 'studio']) {
    const feature = report.features.find(item => item.id === id);
    assert.equal(feature.status, 'not_integrated');
    assert.deepEqual(feature.actions, []);
    assert.match(feature.next_step, /正式新增 Action/);
  }
});

test('real client performs only two capability GET requests and never emits credential material', async t => {
  const requests = [];
  const server = await startServer((request, response) => {
    requests.push({ method: request.method, path: request.url, authenticated: Boolean(request.headers.authorization) });
    json(response, 200, envelope({ release_profile: 'core', feature_enabled: true, user_hash: 'private-user-hash',
      actions: [action('library.list')], scopes: [{ id: 'library:read' }] }));
  });
  t.after(server.close);
  const client = new AgentApiClient({ baseUrl: server.url, timeoutMs: 2000, credentials: {
    load: async () => ({ kind: 'pat', access_token: 'synthetic-private-token', created_at: '2026-10-16T00:00:00Z' }),
    save: async () => assert.fail('不应写凭据'),
  } });
  const report = await diagnoseFeatures(client);
  assert.deepEqual(requests.sort((a, b) => Number(a.authenticated) - Number(b.authenticated)), [
    { method: 'GET', path: '/api/agent-interface/v1/capabilities', authenticated: false },
    { method: 'GET', path: '/api/agent-interface/v1/capabilities', authenticated: true },
  ]);
  assert.equal(findAction(report, 'library.list').status, 'accessible');
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-token|private-user-hash|access_token|refresh_token/);
});
