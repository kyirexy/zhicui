import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFilename, shareTemporaryFile } from './fileExportCore.ts';

test('导出文件名保留中文与扩展名，不接受路径穿越', () => {
  assert.equal(exportFilename('我的知识.png'), '我的知识.png');
  for (const name of ['../../资料.zip', '..\\资料.zip', '/资料\u0000.zip']) {
    const safe = exportFilename(name);
    assert.doesNotMatch(safe, /[\\/\u0000]/);
    assert.ok(!safe.startsWith('.'));
    assert.ok(safe.endsWith('.zip'));
  }
});

test('系统分享未结束前不删除临时文件', async () => {
  let finish!: () => void;
  const events: string[] = [];
  const pending = shareTemporaryFile(
    async () => { events.push('write'); return 'file://private/archive.zip'; },
    async (uri) => { assert.equal(uri, 'file://private/archive.zip'); events.push('share'); await new Promise<void>((resolve) => { finish = resolve; }); },
    async () => { events.push('remove'); },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['write', 'share']);
  finish();
  assert.equal(await pending, 'shared');
  assert.deepEqual(events, ['write', 'share', 'remove']);
});

test('取消和分享失败都清理归档，失败不暴露底层路径', async () => {
  for (const message of ['Share canceled', 'private path /Users/example/archive.zip']) {
    let removed = false;
    const pending = shareTemporaryFile(async () => 'file://archive', async () => { throw new Error(message); }, async () => { removed = true; });
    if (message === 'Share canceled') assert.equal(await pending, 'cancelled');
    else await assert.rejects(pending, { message: '无法打开保存面板，请稍后重试' });
    assert.equal(removed, true);
  }
});

test('写入失败不打开面板，清理错误不覆盖已完成的操作', async () => {
  await assert.rejects(shareTemporaryFile(async () => { throw new Error('空间不足'); }, async () => assert.fail('不应分享'), async () => assert.fail('未创建文件')), /空间不足/);
  assert.equal(await shareTemporaryFile(async () => 'file://archive', async () => undefined, async () => { throw new Error('busy'); }), 'shared');
});
