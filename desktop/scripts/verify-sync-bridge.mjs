import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// 只替换 Electron UI，真实桥接 HTTP、账号校验与磁盘检查点照常运行。
const require = createRequire(import.meta.url);
const exports = {};
const code = await readFile(new URL('../dist/agent-action-bridge.js', import.meta.url), 'utf8');
vm.runInNewContext(code, { exports, require: (name) => name === 'electron' ? { dialog: {} }
  : name === './updater' ? {} : name.startsWith('./') ? require(`../dist/${name.slice(2)}.js`) : require(name),
  process: { ...process, platform: 'win32' }, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval });
const root = await mkdtemp(join(tmpdir(), 'zhicui-sync-bridge-'));
let captures = 0;
const options = { descriptorDirectory: root, version: 'test', channel: 'beta', getWindow: () => null,
  getMediaLibrary: () => null, platformAccounts: { cancel: async () => ({ success: true }), collect: async () => {
    captures++;
    return { success: true, platform: 'douyin', count: 200, coverage: 'limited', orderReliable: true,
      items: Array.from({ length: 200 }, (_, index) => ({ videoId: String(7690000000000000000n + BigInt(index)),
        title: `作品${index}`, ephemeralMediaUrl: 'private-media-url', coverUrl: 'temporary-cover-url', engagement: { likes: index } })) };
  } } };
let bridge = new exports.DesktopAgentActionBridge(options);
let descriptor;
const bind = async (owner) => {
  await bridge.bindUser(owner);
  descriptor = JSON.parse(await readFile(join(root, 'desktop-agent-bridge.json'), 'utf8'));
};
const call = async (action, input, key) => {
  const response = await fetch(`${descriptor.url}/v1/actions/${action}/invoke`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${descriptor.token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ input }) });
  assert.equal(response.status, 200);
  return response.json();
};
try {
  await bridge.start(); await bind('owner-one');
  const input = { platform: 'douyin', mode: 'like', limit: 200 };
  const [a, b] = await Promise.all([call('local.platform.sync', input, 'fixed-task-source'), call('local.platform.sync', input, 'fixed-task-source')]);
  assert.equal(a.run_id, b.run_id);
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = await call('local.platform.status', { platform: 'douyin', run_id: a.run_id });
    if (job.data.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await bridge.jobWrites;
  await bridge.stop();
  bridge = new exports.DesktopAgentActionBridge(options);
  await bridge.start(); await bind('owner-one');
  const restored = await call('local.platform.sync', input, 'fixed-task-source');
  assert.equal(restored.run_id, a.run_id);
  assert.equal(restored.data.result.items.length, 200);
  assert.equal(restored.data.result.items[199].engagement.likes, 199);
  assert.doesNotMatch(JSON.stringify(restored), /private-media-url|temporary-cover-url/);
  assert.equal(captures, 1, '重启和并发重试复用同一次读取');
  await bind('owner-two');
  assert.equal((await call('local.platform.status', { platform: 'douyin', run_id: a.run_id })).data.status, 'idle');
} finally { await bridge.stop(); }
console.log('桌面同步桥：200 条、并发幂等、重启续跑、账号隔离与秘密字段过滤通过');
