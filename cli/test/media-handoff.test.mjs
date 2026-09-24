import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { action, CLI_ENTRY, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory } from './helpers.mjs';

const media = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4096, 3)]);
const actions = [
  action('library.import_link', { scopes: ['library:write'] }),
  action('library.transcript.generate', { scopes: ['library:write'] }),
  action('library.media.download', { scopes: ['library:read'], secure_direct: true, mcp_exposed: false }),
];
async function auth(directory, serverUrl) {
  const env = credentialEnv(directory, serverUrl);
  const login = await runCli(['auth', 'pat', '--non-interactive', '--json'], { env, input: 'zcpat_media_test_fixture' });
  assert.equal(login.code, 0, login.stderr);
  return env;
}

test('download streams an atomic MP4 file, reports digest, never overwrites and emits one JSONL terminal', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'source.mp4');
  let downloads = 0;
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    assert.equal(request.url, '/api/agent-interface/v1/library/note-123/media');
    assert.equal(request.headers.authorization, 'Bearer zcpat_media_test_fixture');
    downloads += 1;
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(media.length) });
    response.write(media.subarray(0, 4));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
    assert.equal(existsSync(output), false, 'final filename is hidden until all bytes arrive');
    response.end(media.subarray(4));
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const result = await runCli(['library', 'download', 'note-123', '--output', output, '--jsonl'], { env });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(output), media);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.terminal).length, 1);
  assert.equal(events.at(-1).data.sha256, createHash('sha256').update(media).digest('hex'));
  assert.equal(events.at(-1).data.bytes, media.length);
  assert.ok(events.some((event) => event.event === 'download.progress'));
  assert.doesNotMatch(result.stdout + result.stderr, /zcpat_media_test_fixture/);
  const again = await runCli(['library', 'download', 'note-123', '--output', output, '--json'], { env });
  assert.equal(JSON.parse(again.stdout).error.code, 'OUTPUT_EXISTS');
  assert.equal(downloads, 1);
  assert.deepEqual(await readFile(output), media);
  assert.equal((await readdir(directory)).some((file) => file.endsWith('.part')), false);
});

test('download rejects redirects without sending a token to the redirect target', async (t) => {
  const directory = await temporaryDirectory();
  let leakRequests = 0;
  const target = await startServer((request, response) => { leakRequests += 1; response.end(media); });
  t.after(target.close);
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    response.writeHead(302, { Location: `${target.url}/private?signature=must-not-print` }); response.end();
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const output = resolve(directory, 'source.mp4');
  const result = await runCli(['library', 'download', 'note-1', '--output', output, '--json'], { env });
  assert.notEqual(result.code, 0);
  assert.equal(leakRequests, 0);
  assert.equal(existsSync(output), false);
  assert.doesNotMatch(result.stdout + result.stderr, /signature|zcpat_media_test_fixture/);
  assert.equal((await readdir(directory)).some((file) => file.endsWith('.part')), false);
});

test('download rejects invalid bytes and oversized responses, redacts upstream errors and cleans partial files', async (t) => {
  const directory = await temporaryDirectory();
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (request.url.includes('/invalid/')) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end('not-real-video'); }
    else if (request.url.includes('/huge/')) { response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(1024 ** 3 + 1) }); response.end(); }
    else json(response, 403, envelope(null, { error: { code: 'SCOPE_DENIED', message: 'https://cdn.invalid/?signed=private', details: { token: 'hidden' } } }));
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  for (const [id, code] of [['invalid', 'MEDIA_INVALID'], ['huge', 'MEDIA_TOO_LARGE'], ['denied', 'SCOPE_DENIED']]) {
    const output = resolve(directory, `${id}.mp4`);
    const result = await runCli(['library', 'download', id, '--output', output, '--json'], { env });
    assert.notEqual(result.code, 0);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.equal(existsSync(output), false);
    assert.doesNotMatch(result.stdout + result.stderr, /cdn\.invalid|private|hidden/);
  }
  assert.equal((await readdir(directory)).some((file) => file.endsWith('.part')), false);
});

test('download never overwrites a file created while bytes are arriving', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'race.mp4');
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    response.writeHead(200, { 'Content-Type': 'video/mp4' });
    response.write(media.subarray(0, 100));
    await writeFile(output, 'belongs-to-another-process');
    response.end(media.subarray(100));
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const result = await runCli(['library', 'download', 'note-1', '--output', output, '--json'], { env });
  assert.equal(JSON.parse(result.stdout).error.code, 'OUTPUT_EXISTS');
  assert.equal(await readFile(output, 'utf8'), 'belongs-to-another-process');
});

test('prepare imports an explicit link, waits for extraction, and hands Hypit a clean repeatable bundle', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  const seen = [];
  const keys = [];
  let runPolls = 0;
  const server = await startServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (url.pathname.endsWith('/actions/library.import_link/invoke')) {
      seen.push(await readJsonBody(request)); keys.push(request.headers['idempotency-key']);
      return json(response, 200, envelope({ result: { item: { id: 'note-1', video_id: '7538839820381614132', title: '原视频标题', platform: 'douyin' } } }));
    }
    if (url.pathname.endsWith('/actions/library.transcript.generate/invoke')) {
      seen.push(await readJsonBody(request)); keys.push(request.headers['idempotency-key']);
      return json(response, 200, envelope(null, { run_id: 'transcript-1', status: 'running' }));
    }
    if (url.pathname.endsWith('/runs/transcript-1/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return response.end('data: {"sequence":1,"status":"succeeded","terminal":true}\n\n');
    }
    if (url.pathname.endsWith('/runs/transcript-1')) {
      runPolls += 1;
      return json(response, 200, envelope({ run: { id: 'transcript-1', status: runPolls < 2 ? 'running' : 'succeeded', data: { note: { transcript_raw: '老板，来份这个。咕嘎！' } } } }, { run_id: 'transcript-1', status: runPolls < 2 ? 'running' : 'succeeded' }));
    }
    if (url.pathname.endsWith('/library/note-1/media')) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); return response.end(media); }
    assert.fail(request.url);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const args = ['library', 'prepare', 'https://v.douyin.com/reference/', '--output', output, '--jsonl'];
  const result = await runCli(args, { env });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(seen, [{ input: { url: 'https://v.douyin.com/reference/' } }, { input: { note_id: 'note-1' } }]);
  assert.notEqual(keys[0], keys[1]);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter((event) => event.terminal).length, 1);
  assert.equal(events.at(-1).data.transcript_status, 'ready');
  assert.equal(await readFile(resolve(output, 'transcript.txt'), 'utf8'), '老板，来份这个。咕嘎！');
  assert.deepEqual(await readFile(resolve(output, 'source.mp4')), media);
  const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'zhicui.hypit-source.v1');
  assert.equal(manifest.media.file, 'source.mp4');
  assert.equal(manifest.video_id, '7538839820381614132');
  assert.doesNotMatch(JSON.stringify(manifest), /token|signed|authorization/i);
  const resumed = await runCli([...args, '--resume'], { env });
  assert.equal(resumed.code, 0, resumed.stderr + resumed.stdout);
  assert.equal(seen.length, 2, 'resume does not re-import or re-transcribe completed material');
  await writeFile(resolve(output, 'source.mp4'), 'tampered');
  const changed = await runCli([...args, '--resume'], { env });
  assert.equal(JSON.parse(changed.stdout.trim().split('\n').at(-1)).error.code, 'MEDIA_CHANGED');
});

test('prepare stops before local or remote writes when PAT lacks write permission', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  let invocations = 0;
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions: [actions[2]] }));
    if (request.url.endsWith('/actions/library.import_link')) return json(response, 200, envelope(actions[0]));
    invocations += 1; response.end();
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const result = await runCli(['library', 'prepare', 'https://www.bilibili.com/video/BVtest', '--output', output, '--json'], { env });
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).error.code, 'SCOPE_DENIED');
  assert.match(JSON.parse(result.stdout).error.message, /library:write/);
  assert.equal(invocations, 0);
  assert.equal(existsSync(output), false);
});

test('prepare records no audio honestly and still downloads the video', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (request.url.endsWith('/actions/library.import_link/invoke')) {
      await readJsonBody(request); return json(response, 200, envelope({ result: { item: { note_id: 'silent-1' } } }));
    }
    if (request.url.endsWith('/actions/library.transcript.generate/invoke')) {
      await readJsonBody(request); return json(response, 200, envelope({ result: { state: 'no_audio', transcript_status: 'no_audio', transcript_raw: '', already_existed: false } }));
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4' }); response.end(media);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const result = await runCli(['library', 'prepare', 'https://v.douyin.com/silent/', '--output', output, '--json'], { env });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).transcript_status, 'no_audio');
  assert.equal(existsSync(resolve(output, 'transcript.txt')), false);
  assert.equal(existsSync(resolve(output, 'source.mp4')), true);
});

test('prepare resumes a timed-out Run without invoking import or transcription again', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  let finished = false;
  let invokes = 0;
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (request.url.endsWith('/actions/library.import_link/invoke')) {
      invokes += 1; await readJsonBody(request);
      return json(response, 200, envelope({ result: { item: { note_id: 'note-resume' } } }));
    }
    if (request.url.endsWith('/actions/library.transcript.generate/invoke')) {
      invokes += 1; await readJsonBody(request);
      return json(response, 200, envelope(null, { status: 'running', run_id: 'saved-run' }));
    }
    if (request.url.startsWith('/api/agent-interface/v1/runs/saved-run/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(': pending\n\n');
      return;
    }
    if (request.url.endsWith('/runs/saved-run')) return json(response, 200, envelope({
      run: { id: 'saved-run', status: finished ? 'succeeded' : 'running', data: { note: { transcript_raw: '恢复后得到的真实文稿' } } },
    }, { run_id: 'saved-run', status: finished ? 'succeeded' : 'running' }));
    if (request.url.endsWith('/library/note-resume/media')) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); return response.end(media); }
    assert.fail(request.url);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const args = ['library', 'prepare', 'https://v.douyin.com/resume/', '--output', output, '--json'];
  const timedOut = await runCli([...args, '--timeout', '300ms'], { env });
  assert.equal(timedOut.code, 8, timedOut.stdout + timedOut.stderr);
  const state = JSON.parse(await readFile(resolve(output, '.zhicui-prepare.json'), 'utf8'));
  assert.equal(state.transcript_run_id, 'saved-run');
  assert.equal(existsSync(resolve(output, '.prepare.lock')), false);
  finished = true;
  const resumed = await runCli([...args, '--resume'], { env });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(invokes, 2);
  assert.equal(await readFile(resolve(output, 'transcript.txt'), 'utf8'), '恢复后得到的真实文稿');
});

test('prepare retries a confirmed failed import with a new stage key only after explicit resume', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  const importKeys = [];
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (request.url.endsWith('/actions/library.import_link/invoke')) {
      await readJsonBody(request); importKeys.push(request.headers['idempotency-key']);
      if (importKeys.length === 1) return json(response, 200, envelope(null, {
        run_id: 'failed-import', status: 'failed', error: { code: 'PLATFORM_UNAVAILABLE', message: 'temporary failure' },
      }));
      return json(response, 200, envelope({ result: { item: { note_id: 'note-retry' } } }));
    }
    if (request.url.endsWith('/actions/library.transcript.generate/invoke')) {
      await readJsonBody(request); return json(response, 200, envelope({ result: { transcript_raw: '重试成功' } }));
    }
    if (request.url.endsWith('/library/note-retry/media')) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); return response.end(media); }
    assert.fail(`unexpected failed run replay: ${request.url}`);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const args = ['library', 'prepare', 'https://v.douyin.com/retry/', '--output', output, '--json'];
  const failed = await runCli(args, { env });
  assert.equal(JSON.parse(failed.stdout).error.code, 'PLATFORM_UNAVAILABLE');
  assert.equal(importKeys.length, 1, 'failed operation is not automatically retried');
  const state = JSON.parse(await readFile(resolve(output, '.zhicui-prepare.json'), 'utf8'));
  assert.equal(state.import_run_id, undefined);
  assert.equal(state.import_attempt, 1);
  const resumed = await runCli([...args, '--resume'], { env });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(importKeys.length, 2);
  assert.notEqual(importKeys[0], importKeys[1]);
});

test('prepare recovers the owned lock after its process is killed and resumes the same run', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  let finished = false;
  let invokes = 0;
  let waiting;
  const readyToKill = new Promise((resolveReady) => { waiting = resolveReady; });
  const server = await startServer(async (request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    if (request.url.endsWith('/actions/library.import_link/invoke')) {
      invokes += 1; await readJsonBody(request);
      return json(response, 200, envelope({ result: { item: { note_id: 'note-killed' } } }));
    }
    if (request.url.endsWith('/actions/library.transcript.generate/invoke')) {
      invokes += 1; await readJsonBody(request); return json(response, 200, envelope(null, { run_id: 'killed-run', status: 'running' }));
    }
    if (request.url.endsWith('/runs/killed-run')) return json(response, 200, envelope({
      run: { id: 'killed-run', status: finished ? 'succeeded' : 'running', data: { transcript_raw: '继续原文稿' } },
    }, { run_id: 'killed-run', status: finished ? 'succeeded' : 'running' }));
    if (request.url.startsWith('/api/agent-interface/v1/runs/killed-run/events')) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': working\n\n'); waiting(); return;
    }
    if (request.url.endsWith('/library/note-killed/media')) { response.writeHead(200, { 'Content-Type': 'video/mp4' }); return response.end(media); }
    assert.fail(request.url);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  const args = ['library', 'prepare', 'https://v.douyin.com/killed/', '--output', output, '--json'];
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], { env: { ...process.env, ...env }, stdio: 'ignore', windowsHide: true });
  t.after(() => child.kill());
  await Promise.race([readyToKill, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('child never reached pending run')), 10_000); timer.unref(); })]);
  const closed = new Promise((resolveClosed) => child.once('close', resolveClosed));
  child.kill('SIGKILL');
  await closed;
  assert.equal(existsSync(resolve(output, '.prepare.lock')), true);
  finished = true;
  const resumed = await runCli([...args, '--resume'], { env });
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  assert.equal(invokes, 2);
  assert.equal(existsSync(resolve(output, '.prepare.lock')), false);
});

test('prepare adopts only checksum-matching files published just before interruption', async (t) => {
  const directory = await temporaryDirectory();
  const output = resolve(directory, 'hypit');
  let calls = 0;
  const server = await startServer((request, response) => {
    if (request.url.endsWith('/capabilities')) return json(response, 200, envelope({ actions }));
    calls += 1; assert.fail(request.url);
  });
  t.after(server.close);
  const env = await auth(directory, server.url);
  await mkdir(output);
  const transcript = '已完整落盘的文稿';
  const state = {
    kind: 'zhicui-library-prepare', version: 1, api_origin: server.url,
    source_url: 'https://v.douyin.com/checkpoint/', operation_id: 'fixture-only-checkpoint', created_at: '2026-09-24T00:00:00.000Z',
    note_id: 'note-checkpoint', title: '原视频',
    pending_transcript: { bytes: Buffer.byteLength(transcript), sha256: createHash('sha256').update(transcript).digest('hex') },
    pending_media: { file: 'source.mp4', bytes: media.length, sha256: createHash('sha256').update(media).digest('hex'), content_type: 'video/mp4' },
  };
  await writeFile(resolve(output, '.zhicui-prepare.json'), JSON.stringify(state));
  await writeFile(resolve(output, 'transcript.txt'), transcript);
  await writeFile(resolve(output, 'source.mp4'), media);
  const deadProcess = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  await mkdir(resolve(output, '.prepare.lock'));
  await writeFile(resolve(output, '.prepare.lock', `owner-${deadProcess.pid}-12345678-abcd`), '');
  const result = await runCli(['library', 'prepare', state.source_url, '--output', output, '--resume', '--json'], { env });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(calls, 0);
  const saved = JSON.parse(await readFile(resolve(output, '.zhicui-prepare.json'), 'utf8'));
  assert.equal(saved.transcript_status, 'ready');
  assert.equal(saved.pending_transcript, undefined);
  assert.equal(saved.pending_media, undefined);
  assert.equal(saved.media.sha256, state.pending_media.sha256);
});
