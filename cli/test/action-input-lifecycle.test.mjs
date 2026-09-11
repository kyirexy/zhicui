import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  action, credentialEnv, envelope, json, readJsonBody, runCli,
  startServer, temporaryDirectory,
} from './helpers.mjs';

async function authorizedEnv(url) {
  const directory = await temporaryDirectory();
  const env = credentialEnv(directory, url);
  await writeFile(resolve(directory, 'credential.json'), JSON.stringify({
    kind: 'pat', access_token: 'zcpat_test_input_only', server_origin: url,
    created_at: new Date().toISOString(),
  }));
  return env;
}

test('CLI preserves real Douyin IDs and string values while parsing schema arrays and numeric limits', async (t) => {
  const actions = [
    action('library.transcript.generate', { input_schema: {
      type: 'object', properties: { aweme_id: { type: 'string' } },
    } }),
    action('creator.sync.start', { input_schema: {
      type: 'object', properties: {
        source_id: { type: 'string' }, limit: { type: ['integer', 'null'] },
        item_ids: { type: 'array', items: { type: 'string' } },
      },
    } }),
    action('ask.turn.start', { input_schema: {
      type: 'object', properties: {
        thread_id: { type: 'string' }, client_turn_id: { type: 'string' }, question: { type: 'string' },
      },
    } }),
    action('plan.create', { input_schema: {
      type: 'object', properties: { title: { type: 'string' }, first_task: { type: ['object', 'null'] } },
    } }),
  ];
  const received = [];
  const server = await startServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    const match = /\/actions\/([^/]+)(\/invoke)?$/u.exec(path);
    if (match && !match[2]) return json(response, 200, envelope({ action: actions.find((item) => item.id === match[1]) }));
    if (match) {
      received.push((await readJsonBody(request)).input);
      return json(response, 200, envelope({ saved: true }));
    }
    return json(response, 404, { error: { code: 'NOT_FOUND', message: 'missing' } });
  });
  t.after(server.close);
  const env = await authorizedEnv(server.url);
  const commands = [
    ['library', 'transcript', '7661253132151819539'],
    ['run', 'library.transcript.generate', '--aweme-id', '7661253132151819539'],
    ['creator', 'sync', 'source-1', '--limit', '20', '--item-ids', '["item-1","item-2"]'],
    ['ask', 'start', '001', 'true', '2026'],
    ['plan', 'create', 'null', '--first-task', '{"title":"第一步","day":1}'],
  ];
  for (const command of commands) {
    const result = await runCli([...command, '--json'], { env });
    assert.equal(result.code, 0, result.stdout || result.stderr);
  }
  assert.deepEqual(received, [
    { aweme_id: '7661253132151819539' },
    { aweme_id: '7661253132151819539' },
    { source_id: 'source-1', limit: 20, item_ids: ['item-1', 'item-2'] },
    { thread_id: '001', client_turn_id: 'true', question: '2026' },
    { title: 'null', first_task: { title: '第一步', day: 1 } },
  ]);
  for (const args of [
    ['--limit', '9007199254740993'], ['--limit', '1.5'], ['--limit'],
    ['--item-ids', 'item-1,item-2'],
  ]) {
    const result = await runCli(['creator', 'sync', 'source-1', ...args, '--json'], { env });
    assert.equal(result.code, 2, result.stdout || result.stderr);
  }
  assert.equal(received.length, commands.length, 'invalid inputs must not invoke an action');
});

test('terminal, business-ID and waiting envelopes do not trigger spurious cloud polling', async (t) => {
  const actions = [action('library.get'), action('creator.sync.start')];
  let requestedStatus = 'succeeded';
  let unexpectedPolls = 0;
  const server = await startServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (path.endsWith('/actions/library.get/invoke')) {
      return json(response, 200, envelope({ id: 'note-not-a-run', title: '视频资料' }));
    }
    if (path.endsWith('/actions/creator.sync.start/invoke')) {
      return json(response, 200, envelope({ run: { id: 'business-run', status: requestedStatus } }, {
        run_id: 'agent-run', status: requestedStatus,
      }));
    }
    unexpectedPolls += 1;
    return json(response, 500, { error: { code: 'WRONG_POLL', message: 'already complete or waiting' } });
  });
  t.after(server.close);
  const env = await authorizedEnv(server.url);
  for (const mode of ['--json', '--jsonl']) {
    const result = await runCli(['library', 'get', 'note-not-a-run', '--wait', mode], { env });
    assert.equal(result.code, 0, result.stdout || result.stderr);
  }
  for (const [status, expectedCode] of [['succeeded', 0], ['waiting_for_user', 5], ['canceled', 8], ['failed', 7]]) {
    requestedStatus = status;
    const result = await runCli(['creator', 'sync', 'source-1', '--jsonl'], { env });
    assert.equal(result.code, expectedCode, result.stdout || result.stderr);
    const events = result.stdout.trim().split(/\r?\n/u).map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, status);
    assert.equal(events[0].terminal, status !== 'waiting_for_user');
  }
  assert.equal(unexpectedPolls, 0);
});

test('long task polls the protocol run ID instead of nested business run IDs', async (t) => {
  const actions = [action('analysis.run.confirm', { run_type: 'long_task' })];
  const polls = [];
  const server = await startServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (path.endsWith('/actions/analysis.run.confirm/invoke')) {
      return json(response, 200, envelope({ run: { id: 'analysis-business-run', status: 'running' } }, {
        run_id: 'agent-run', status: 'running',
      }));
    }
    polls.push(path);
    if (path.endsWith('/runs/agent-run/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return response.end(`data: ${JSON.stringify({ sequence: 1, status: 'succeeded', terminal: true })}\n\n`);
    }
    return json(response, 500, { error: { code: 'WRONG_POLL', message: 'wrong ID' } });
  });
  t.after(server.close);
  const env = await authorizedEnv(server.url);
  const result = await runCli(['analysis', 'confirm', 'analysis-business-run', '--jsonl'], { env });
  assert.equal(result.code, 0, result.stdout || result.stderr);
  assert.deepEqual(polls, ['/api/agent-interface/v1/runs/agent-run/events']);
});

test('domain command help describes complete core flows without credentials', async () => {
  const directory = await temporaryDirectory();
  for (const [domain, expected] of [['creator', 'creator.create'], ['ask', 'ask.thread.create'], ['plan', 'plan.from_library.generate']]) {
    const result = await runCli([domain, '--help', '--json'], { env: credentialEnv(directory, 'http://127.0.0.1:1') });
    assert.equal(result.code, 0, result.stdout || result.stderr);
    assert.ok(JSON.parse(result.stdout).commands.some((item) => item.action === expected));
  }
});

test('a scope-filtered registered command reports permission denial without invoking it', async (t) => {
  let invokes = 0;
  const server = await startServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.endsWith('/capabilities')) return json(response, 200, envelope({ actions: [] }));
    if (path.endsWith('/actions/plan.create')) {
      return json(response, 200, envelope({ action: action('plan.create', { scopes: ['plan:write'] }) }));
    }
    invokes += 1;
    return json(response, 500, { error: { code: 'UNEXPECTED_CALL', message: 'must not invoke' } });
  });
  t.after(server.close);
  const env = await authorizedEnv(server.url);
  const result = await runCli(['plan', 'create', '测试计划', '--json'], { env });
  assert.equal(result.code, 4, result.stdout || result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'SCOPE_DENIED');
  assert.equal(invokes, 0);
});
