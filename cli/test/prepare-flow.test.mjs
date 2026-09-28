import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { normalizePrepareLink } from '../dist/prepare-flow.js';
import { action, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory } from './helpers.mjs';

const actions = ['library.import_link', 'library.transcript.generate', 'library.media.download'].map((id) => action(id));
const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);

test('share text accepts one supported link and rejects ambiguous or unsafe input', () => {
  assert.equal(normalizePrepareLink('2.58 咕嘎！ https://v.douyin.com/example/ 复制此链接打开抖音'), 'https://v.douyin.com/example/');
  assert.equal(normalizePrepareLink('看看 https://www.bilibili.com/video/BVtest。'), 'https://www.bilibili.com/video/BVtest');
  for (const value of ['https://evil.test/', 'https://user:pass@v.douyin.com/a/', 'https://v.douyin.com/a/ https://b23.tv/b/', '没有链接']) {
    assert.throws(() => normalizePrepareLink(value));
  }
});

test('one prepare command authorizes, recovers a temporary gateway outage, completes, and automatically reuses its bundle', async (t) => {
  const directory = await temporaryDirectory();
  let starts = 0, polls = 0, imports = 0, transcripts = 0, downloads = 0;
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/auth/device')) {
      starts++;
      assert.deepEqual((await readJsonBody(request)).scopes, ['account:read', 'library:read', 'library:write']);
      return json(response, 200, envelope({ device_code: 'machine_code_secret', user_code: 'FLOW-TEST', verification_uri: `${server.url}/verify`, interval: 1, expires_in: 60 }));
    }
    if (request.url.endsWith('/auth/device/token')) {
      polls++;
      if (polls === 1) { response.writeHead(502); return response.end('temporary gateway error'); }
      return json(response, 200, envelope({ access_token: 'device_token_secret', scopes: ['account:read', 'library:read', 'library:write'], expires_in: 900 }));
    }
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    assert.equal(request.headers.authorization, 'Bearer device_token_secret');
    if (request.url.endsWith('/actions/library.import_link/invoke')) {
      imports++; assert.equal((await readJsonBody(request)).input.url, 'https://v.douyin.com/example/');
      return json(response, 200, envelope({ result: { item: { id: 'flow-note' } } }));
    }
    if (request.url.endsWith('/actions/library.transcript.generate/invoke')) {
      transcripts++;
      return json(response, 200, envelope({ result: { transcript: '真实服务替身文稿' } }));
    }
    if (request.url.endsWith('/library/flow-note/media')) {
      downloads++; response.writeHead(200, { 'Content-Type': 'video/mp4' }); return response.end(media);
    }
    assert.fail(request.url);
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  const args = ['library', 'prepare', '分享视频 https://v.douyin.com/example/ 复制链接', '--connect', '--no-open', '--jsonl', '--timeout', '8s'];
  const result = await runCli(args, { env, cwd: directory, processTimeoutMs: 15000 });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((e) => e.terminal).length, 1);
  assert.equal(events.find((e) => e.event === 'authorization_complete').terminal, false);
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, index) => index + 1));
  assert.equal(events.at(-1).event, 'prepare.completed');
  assert.deepEqual(await readFile(events.at(-1).data.media), media);
  assert.doesNotMatch(result.stdout + result.stderr, /device_token_secret|machine_code_secret/);
  const again = await runCli(args, { env, cwd: directory });
  assert.equal(again.code, 0, again.stdout + again.stderr);
  assert.deepEqual([starts, polls, imports, transcripts, downloads], [1, 2, 1, 1, 1]);
});

test('missing authorization gives a runnable recovery command without starting consent implicitly', async (t) => {
  const directory = await temporaryDirectory();
  let calls = 0;
  const server = await startServer((req, res) => { calls++; json(res, 500, {}); });
  t.after(server.close);
  const result = await runCli(['library', 'prepare', 'https://v.douyin.com/example/', '--json'], { env: credentialEnv(directory, server.url), cwd: directory });
  assert.equal(result.code, 3);
  assert.equal(calls, 0);
  const recovery = JSON.parse(result.stdout).error.details;
  assert.equal(recovery.next_step, 'authorize');
  assert.ok(recovery.resume_argv.includes('--connect'));
  assert.ok(!recovery.resume_argv.includes('--resume'));
});

test('platform refusal preserves progress and reports platform help without another authorization or retry', async (t) => {
  const directory = await temporaryDirectory();
  let imports = 0;
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    assert.ok(request.url.endsWith('/actions/library.import_link/invoke'));
    imports++;
    return json(response, 200, envelope(null, { status: 'failed', error: { code: 'PLATFORM_AUTH_REQUIRED', message: 'not safe upstream detail' } }));
  });
  t.after(server.close);
  const env = credentialEnv(directory, server.url);
  assert.equal((await runCli(['auth', 'pat', '--json', '--non-interactive'], { env, input: 'test_pat_fixture' })).code, 0);
  const result = await runCli(['library', 'prepare', 'https://v.douyin.com/example/', '--connect', '--no-open', '--json'], { env, cwd: directory });
  assert.equal(result.code, 7);
  assert.equal(imports, 1);
  const recovery = JSON.parse(result.stdout).error.details;
  assert.equal(recovery.next_step, 'check_platform');
  assert.equal(recovery.help_url, 'https://luxai.cn/library?sync=1');
  assert.ok(recovery.resume_argv.includes('--resume'));
  assert.equal(JSON.parse(await readFile(resolve(recovery.directory, '.zhicui-prepare.json'), 'utf8')).import_attempt, 1);
  assert.doesNotMatch(result.stdout, /not safe upstream detail/);
});
