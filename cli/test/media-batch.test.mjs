import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { action, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory } from './helpers.mjs';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
async function fixture(t) {
  const root = await temporaryDirectory();
  const source = resolve(root, 'links.json');
  const output = resolve(root, 'batch');
  await writeFile(source, JSON.stringify({items:[{url:'https://www.douyin.com/video/111',title:'第一条'},
    'https://www.douyin.com/video/222', 'https://www.douyin.com/video/111']}));
  const state = { user:'user-one', mode:'ok', downloads:0, calls:0 };
  const server = await startServer(async (req, res) => {
    if (req.url.endsWith('/capabilities')) return json(res, 200, envelope({user_hash:state.user, actions:[action('library.media.resolve',{scopes:['library:read']})]}));
    assert.equal(req.headers.authorization, 'Bearer zcpat_batch_fixture');
    if (req.url.endsWith('/actions/library.media.resolve/invoke')) {
      state.calls++;
      const body = await readJsonBody(req);
      if (state.mode === 'failure_then_rate' && body.input.url.endsWith('/111')) return json(res,404,{error:{code:'NOT_FOUND',message:'missing'}});
      if (state.mode === 'failure_then_rate' && body.input.url.endsWith('/222')) return json(res,429,{error:{code:'RATE_LIMITED',retry_after_seconds:60}});
      if (state.mode === 'rate' && body.input.url.endsWith('/222')) return json(res, 429, {error:{code:'RATE_LIMITED',message:'secret upstream',retry_after_seconds:60}});
      if (state.mode === 'verify') return json(res, 422, {error:{code:'PLATFORM_AUTH_REQUIRED',message:'secret cookie'}});
      return json(res, 200, envelope({result:{media_id:'gAAAAA_batch_fixture_'+'x'.repeat(45),video_id:'fixture',title:'返回标题'}}));
    }
    assert.match(req.url, /^\/api\/agent-interface\/v1\/media\//);
    state.downloads++;
    res.writeHead(200, {'Content-Type':'video/mp4','Content-Length':String(mp4.length)}); res.end(mp4);
  }); t.after(server.close);
  const env = credentialEnv(root, server.url);
  assert.equal((await runCli(['auth','pat','--non-interactive','--json'],{env,input:'zcpat_batch_fixture'})).code,0);
  const args = ['download','batch','--input',source,'--output',output,'--json'];
  return {root, source, output, state, env, args};
}

test('batch deduplicates exact links, downloads serially without ASR, resumes by verifying files', async (t) => {
  const f = await fixture(t);
  const first = await runCli(f.args,{env:f.env});
  assert.equal(first.code,0,first.stdout+first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.ready,2); assert.equal(result.downloaded,2); assert.equal(result.analysis_status,'not_performed');
  const data = JSON.parse(await readFile(result.manifest,'utf8'));
  assert.equal(data.items.length,2); assert.equal(data.items[0].status,'ready');
  assert.doesNotMatch(JSON.stringify(data), /zcpat_batch_fixture|gAAAAA/);
  const resumed = await runCli([...f.args,'--resume'],{env:f.env});
  assert.equal(resumed.code,0,resumed.stdout+resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).reused,2); assert.equal(f.state.downloads,2); assert.equal(f.state.calls,2);
});

test('rate limit pauses the batch and persists cooldown; resume does not hammer server', async (t) => {
  const f = await fixture(t); f.state.mode='rate';
  const first = await runCli(f.args,{env:f.env});
  assert.equal(first.code,6);
  assert.equal(JSON.parse(first.stdout).status,'paused');
  assert.equal(JSON.parse(first.stdout).ready,1);
  assert.doesNotMatch(first.stdout+first.stderr,/secret upstream|zcpat_batch_fixture/);
  const calls=f.state.calls;
  const second=await runCli([...f.args,'--resume'],{env:f.env});
  assert.notEqual(second.code,0); assert.equal(f.state.calls,calls);
  const manifest=resolve(f.output,'manifest.json');
  const saved=JSON.parse(await readFile(manifest,'utf8')); saved.items[1].retry_not_before='2020-01-01T00:00:00Z';
  await writeFile(manifest,JSON.stringify(saved)); f.state.mode='ok';
  const resumed=await runCli([...f.args,'--resume'],{env:f.env});
  assert.equal(resumed.code,0,resumed.stdout); assert.equal(JSON.parse(resumed.stdout).downloaded,1); assert.equal(JSON.parse(resumed.stdout).reused,1);
});

test('cooldown blocks retry of earlier failed entries and JSONL preserves the reason with one terminal', async (t) => {
  const f=await fixture(t); f.state.mode='failure_then_rate';
  const args=f.args.filter(x=>x!=='--json');
  const first=await runCli([...args,'--jsonl'],{env:f.env});
  assert.equal(first.code,6);
  const events=first.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(x=>x.terminal).length,1); assert.equal(events.at(-1).status,'paused');
  assert.equal(events.at(-1).data.stop_code,'RATE_LIMITED');
  assert.equal(f.state.calls,2);
  const resumed=await runCli([...f.args,'--resume'],{env:f.env});
  assert.equal(resumed.code,6); assert.equal(f.state.calls,2);
});

test('account changes, mutated or missing assets and input changes cannot be silently reused', async (t) => {
  const f=await fixture(t);
  assert.equal((await runCli(f.args,{env:f.env})).code,0);
  f.state.user='different-user';
  assert.match((await runCli([...f.args,'--resume'],{env:f.env})).stdout,/BATCH_STATE_INVALID/);
  f.state.user='user-one';
  const saved=JSON.parse(await readFile(resolve(f.output,'manifest.json'),'utf8'));
  const path=resolve(f.output,saved.items[0].file);
  await writeFile(path,Buffer.alloc(mp4.length));
  assert.match((await runCli([...f.args,'--resume'],{env:f.env})).stdout,/MEDIA_CHANGED/);
  assert.deepEqual(await readFile(path),Buffer.alloc(mp4.length));
  await writeFile(f.source,JSON.stringify(['https://www.douyin.com/video/333']));
  assert.match((await runCli([...f.args,'--resume'],{env:f.env})).stdout,/BATCH_STATE_INVALID/);
  assert.equal(f.state.downloads,2);
});

test('committed file with pending receipt recovers after a lost completion without another download', async (t) => {
  const f=await fixture(t); assert.equal((await runCli(f.args,{env:f.env})).code,0);
  const manifest=resolve(f.output,'manifest.json');
  const saved=JSON.parse(await readFile(manifest,'utf8'));
  saved.items[1].pending_media=saved.items[1].media; delete saved.items[1].media; saved.items[1].status='downloading';
  await writeFile(manifest,JSON.stringify(saved));
  const resumed=await runCli([...f.args,'--resume'],{env:f.env});
  assert.equal(resumed.code,0,resumed.stdout); assert.equal(JSON.parse(resumed.stdout).reused,2); assert.equal(f.state.downloads,2);
});

test('invalid links are rejected before creating output; verification pauses without retry or auto login', async (t) => {
  const f=await fixture(t);
  await writeFile(f.source,JSON.stringify(['http://127.0.0.1/private']));
  const bad=await runCli(f.args,{env:f.env}); assert.equal(bad.code,2); assert.equal(f.state.calls,0);
  assert.ok(!(await readdir(f.root)).includes('batch'));
  await writeFile(f.source,JSON.stringify(['https://www.douyin.com/video/111']));
  f.state.mode='verify';
  const paused=await runCli(f.args,{env:f.env}); assert.notEqual(paused.code,0);
  assert.equal(JSON.parse(paused.stdout).status,'paused'); assert.equal(f.state.calls,1); assert.equal(f.state.downloads,0);
  assert.doesNotMatch(paused.stdout+paused.stderr,/secret cookie/);
});

test('an existing unrelated directory is never overwritten', async (t) => {
  const f=await fixture(t); await mkdir(f.output); await writeFile(resolve(f.output,'keep.txt'),'keep');
  const result=await runCli(f.args,{env:f.env}); assert.match(result.stdout,/OUTPUT_EXISTS/);
  assert.equal(await readFile(resolve(f.output,'keep.txt'),'utf8'),'keep'); assert.equal(f.state.calls,0);
});
