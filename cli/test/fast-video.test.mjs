import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { action, credentialEnv, envelope, json, readJsonBody, runCli, startServer, temporaryDirectory } from './helpers.mjs';

test('one short command downloads without import or ASR; resolve only returns an authenticated handle', async (t) => {
  const directory=await temporaryDirectory();
  const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(100)]);
  const mediaId='gAAAAAfast_media_test_handle_'+'x'.repeat(40);
  let parses=0, downloads=0;
  const server=await startServer(async (req,res) => {
    if(req.url.endsWith('/capabilities')) return json(res,200,envelope({actions:[action('library.media.resolve',{scopes:['library:read']})]}));
    assert.equal(req.headers.authorization,'Bearer zcpat_fast_fixture');
    if(req.url.endsWith('/actions/library.media.resolve/invoke')) {
      parses++;
      assert.equal((await readJsonBody(req)).input.url,'https://v.douyin.com/demo/');
      return json(res,200,envelope({result:{media_id:mediaId,title:'咕嘎',video_id:'123456789',resolve_ms:321,expires_in:300}}));
    }
    assert.equal(req.url,'/api/agent-interface/v1/media/'+mediaId);
    downloads++; res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':String(bytes.length)}); res.end(bytes);
  });
  t.after(server.close);
  const env=credentialEnv(directory,server.url);
  const auth=await runCli(['auth','pat','--non-interactive','--json'],{env,input:'zcpat_fast_fixture'});
  assert.equal(auth.code,0,auth.stderr);
  const link=await runCli(['resolve','分享 https://v.douyin.com/demo/ 打开抖音','--json'],{env});
  assert.equal(link.code,0,link.stderr); assert.equal(JSON.parse(link.stdout).media_id,mediaId); assert.equal(downloads,0);
  const output=resolve(directory,'fast.mp4');
  const run=await runCli(['download','https://v.douyin.com/demo/','--output',output,'--jsonl'],{env});
  assert.equal(run.code,0,run.stderr);
  const events=run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(x=>x.terminal).length,1);
  assert.equal(events.at(-1).data.resolve_ms,321);
  assert.deepEqual(await readFile(output),bytes);
  assert.equal(parses,2); assert.equal(downloads,1);
  assert.doesNotMatch(run.stdout+run.stderr,/zcpat_fast_fixture/);
});


test('audio is one authenticated command, validates MP3, and leaves no file for NO_AUDIO', async (t) => {
  const directory=await temporaryDirectory();
  const bytes=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(100)]);
  const mediaId='gAAAAAaudio_test_handle_'+'x'.repeat(40);
  let mode='ok';
  const server=await startServer(async (req,res) => {
    if(req.url.endsWith('/capabilities')) return json(res,200,envelope({actions:[action('library.media.resolve',{scopes:['library:read']})]}));
    assert.equal(req.headers.authorization,'Bearer zcpat_audio_fixture');
    if(req.url.endsWith('/actions/library.media.resolve/invoke')) {
      assert.equal((await readJsonBody(req)).input.kind,'audio');
      return json(res,200,envelope({result:{media_id:mediaId,kind:'audio',title:'原声',video_id:'123456789',resolve_ms:320}}));
    }
    assert.equal(req.url,'/api/agent-interface/v1/media/'+mediaId);
    if(mode==='none') return json(res,422,{error:{code:'NO_AUDIO',message:'private upstream details'}});
    res.writeHead(200,{'Content-Type':'audio/mpeg'});res.end(mode==='html' ? Buffer.from('<html>error</html>') : bytes);
  });t.after(server.close);
  const env=credentialEnv(directory,server.url);
  await runCli(['auth','pat','--non-interactive','--json'],{env,input:'zcpat_audio_fixture'});
  const output=resolve(directory,'audio.mp3');
  const success=await runCli(['audio','https://v.douyin.com/demo/','--output',output,'--json'],{env});
  assert.equal(success.code,0,success.stderr);assert.deepEqual(await readFile(output),bytes);
  assert.equal(JSON.parse(success.stdout).action,'audio.download');
  for(mode of ['none','html']){
    const failedOutput=resolve(directory,mode+'.mp3');
    const failure=await runCli(['download','https://v.douyin.com/demo/','--audio','--output',failedOutput,'--json'],{env});
    assert.notEqual(failure.code,0);
    assert.match(failure.stdout,mode==='none'?/NO_AUDIO/:/MEDIA_INVALID/);
    assert.doesNotMatch(failure.stdout+failure.stderr,/private upstream|zcpat_audio_fixture/);
    await assert.rejects(readFile(failedOutput),{code:'ENOENT'});
  }
});
