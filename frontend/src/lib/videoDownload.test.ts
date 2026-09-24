import assert from 'node:assert/strict';
import test from 'node:test';
import { readVideoDownload, videoDownloadError, videoDownloadFilename } from './videoDownload.ts';

const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const headers = { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) };

test('streams validated video and reports actual transferred bytes', async () => {
  const chunks = [mp4.slice(0, 3), mp4.slice(3, 8), mp4.slice(8)];
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const progress: number[] = [];
  const blob = await readVideoDownload(new Response(stream, { headers }), (value) => progress.push(value.receivedBytes));
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), mp4);
  assert.equal(progress[0], 0);
  assert.equal(progress.at(-1), mp4.length);
});

test('permits unknown length and does not invent a download total', async () => {
  let total: number | null | undefined;
  const blob = await readVideoDownload(new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } }), (value) => { total = value.totalBytes; });
  assert.equal(blob.size, mp4.length);
  assert.equal(total, null);
});

test('rejects partial transfers before they can be saved', async () => {
  await assert.rejects(readVideoDownload(new Response(mp4.slice(0, 12), { headers })), /下载中断/);
});

test('rejects an HTML error page, including a mislabeled HTTP 200', async () => {
  await assert.rejects(readVideoDownload(new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } })), /有效的视频文件/);
  await assert.rejects(readVideoDownload(new Response('<html>error</html>', { headers: { 'Content-Type': 'video/mp4' } })), /校验失败/);
});

test('does not read an advertised oversized response into browser memory', async () => {
  await assert.rejects(readVideoDownload(new Response(mp4, { headers: { ...headers, 'Content-Length': String(513 * 1024 * 1024) } })), /超过 512 MB/);
});

test('canceling an active download cancels its reader and produces no file', async () => {
  const controller = new AbortController();
  let canceled = false;
  const stream = new ReadableStream({
    start(reader) { reader.enqueue(mp4.slice(0, 8)); },
    cancel() { canceled = true; },
  });
  const result = readVideoDownload(new Response(stream, { headers }), ({ receivedBytes }) => {
    if (receivedBytes) controller.abort();
  }, controller.signal);
  await assert.rejects(result, (error: Error) => error.name === 'AbortError');
  assert.equal(canceled, true);
});

test('handles a safe server error and hides authentication/debug details', async () => {
  await assert.rejects(readVideoDownload(new Response(JSON.stringify({ error: '这个作品暂时无法下载' }), { status: 503 })), /这个作品暂时无法下载/);
  assert.match(videoDownloadError(401, { error: 'token expired' }), /重新登录/);
  assert.match(videoDownloadError(403, {}), /没有.*权限/);
  assert.match(videoDownloadError(404, {}), /不存在/);
  assert.match(videoDownloadError(429, {}), /稍后/);
  assert.equal(videoDownloadError(502, { error: '上游错误 https://cdn.example/video?secret=value' }), '视频暂时无法下载，请稍后重试');
  assert.equal(videoDownloadError(502, { error: '授权错误 Bearer secret' }), '视频暂时无法下载，请稍后重试');
});

test('produces portable MP4 filenames from source titles', () => {
  assert.equal(videoDownloadFilename('视频: 你好/世界?'), '视频 你好 世界.mp4');
  assert.equal(videoDownloadFilename('CON'), '知萃视频.mp4');
  assert.equal(videoDownloadFilename('  测试.mp4  '), '测试.mp4');
  assert.equal(videoDownloadFilename(''), '知萃视频.mp4');
  assert.ok(videoDownloadFilename('视'.repeat(200)).length <= 104);
});
