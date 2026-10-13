import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyResearchWorker, dailyResearchMetadata } from '../dist/daily-research-worker.js';

const root = await mkdtemp(join(tmpdir(), 'zhicui-daily-research-test-'));
const session = (id = 'user-a') => ({ token: `token-${id}`, user: { id, agent_profile_key: `profile-${id}` } });
const claim = (id = 'run-one', modes = ['like', 'collect']) => ({ run_id: id, lease_token: 'lease-one',
  request: { platforms: ['douyin'], source_modes: modes, limit: 500, task_id: id } });
const items = length => Array.from({ length }, (_, index) => ({ videoId: String(100000 + index),
  sourceUrl: `https://www.douyin.com/video/${100000 + index}`, title: `视频 ${index}`, authorName: '作者', caption: '正文',
  coverUrl: 'https://example.test/private-cover', ephemeralMediaUrl: 'https://example.test/private-media',
  publishedAt: '', durationSeconds: 30, sourceRank: index }));
const capture = length => ({ success: true, platform: 'douyin', items: items(length), coverage: 'limited', orderReliable: true });
const reply = data => Response.json({ success: true, data });
const batchResult = body => ({ accepted: body.items.length, created: body.items.length, reused: 0, skipped: 0, failed: 0 });
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(name, options = {}) {
  const requests = [], cancellations = [], errors = [];
  let bound = session(), collections = 0, online = true;
  const worker = new DailyResearchWorker({ directory: join(root, name), origin: 'https://example.test',
    getAccessToken: expected => online && expected === bound?.user.id ? bound.token : null,
    collect: async request => { collections++; return options.collect ? options.collect(request, worker) : capture(500); },
    cancel: async request => { cancellations.push(request); options.cancel?.(request); return {}; },
    ownsSession: key => options.ownsSession ? options.ownsSession(key) : true,
    heartbeatMs: options.heartbeatMs ?? 60_000,
    onError: message => errors.push(message),
    fetch: async (url, init) => {
      const path = url.split('/').at(-1), body = JSON.parse(init.body);
      requests.push({ path, body, authorization: init.headers.Authorization });
      if (options.fetch) return options.fetch(path, body, requests);
      return reply(path === 'claim' ? claim() : path === 'batch' ? batchResult(body) : {});
    },
  });
  await worker.bindSession(bound);
  return { worker, requests, cancellations, errors, get collections() { return collections; },
    setOnline: value => { online = value; },
    bind: async next => { bound = next; await worker.bindSession(next); } };
}

// 同时轮询只有一个消费者；喜欢和收藏各 500 条，始终按 100 条保存。
{
  const pending = deferred();
  const f = await fixture('batching', { collect: async () => { await pending.promise; return capture(500); } });
  const first = f.worker.runOnce(), second = f.worker.runOnce();
  assert.equal(first, second);
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(f.collections, 2);
  assert.equal(f.requests.filter(row => row.path === 'claim').length, 1);
  const batches = f.requests.filter(row => row.path === 'batch');
  assert.equal(batches.length, 10);
  assert.ok(batches.every(row => row.body.items.length === 100));
  assert.deepEqual(batches.slice(0, 5).map(row => row.body.source_rank_offset), [0, 100, 200, 300, 400]);
  const done = f.requests.find(row => row.path === 'complete').body;
  assert.equal(done.coverage, 'limited');
  assert.equal(done.sources.reduce((sum, source) => sum + source.created, 0), 1000);
  assert.ok(done.sources.every(source => source.saved === 500 && !source.error));
  const checkpointName = (await readdir(join(root, 'batching'))).find(name => name.endsWith('.json'));
  const checkpoint = await readFile(join(root, 'batching', checkpointName), 'utf8');
  assert.ok(!checkpoint.includes('private-media') && !checkpoint.includes('private-cover') && !checkpoint.includes('token-user'));
  await f.worker.stop();
}

// 官方验证窗口保持原任务，云端看到 waiting_for_user；恢复后才保存清单。
{
  const pending = deferred(), entered = deferred();
  const f = await fixture('verification', { collect: async (_request, worker) => {
    worker.recordPlatformStatus({ platform: 'douyin', mode: 'like', stage: 'needs-action', message: '请完成官方验证', readCount: 20 });
    entered.resolve(); await pending.promise;
    worker.recordPlatformStatus({ platform: 'douyin', mode: 'like', stage: 'collecting', message: '正在继续分页', readCount: 25 });
    return capture(25);
  }, fetch: async (path, body) => reply(path === 'claim' ? claim('run-verification', ['like']) : path === 'batch' ? batchResult(body) : {}) });
  const work = f.worker.runOnce(); await entered.promise; await flush();
  assert.ok(f.requests.some(row => row.path === 'progress' && row.body.stage === 'waiting_for_user'));
  assert.equal(f.requests.filter(row => row.path === 'batch').length, 0);
  pending.resolve(); await work;
  assert.equal(f.requests.filter(row => row.path === 'complete').length, 1);
  await f.worker.stop();
}

// 切账号期间的旧采集结果不能用新账号 JWT 保存；取消只限原 sessionKey。
{
  const pending = deferred(), entered = deferred();
  const f = await fixture('account-switch', { collect: async () => { entered.resolve(); await pending.promise; return capture(10); } });
  const work = f.worker.runOnce(); await entered.promise;
  await f.bind(session('user-b'));
  assert.equal(f.cancellations.length, 1);
  assert.match(f.cancellations[0].sessionKey, /^[a-f0-9-]{36}$/);
  pending.resolve(); await work;
  assert.equal(f.requests.filter(row => ['batch', 'complete'].includes(row.path)).length, 0);
  assert.ok(f.requests.every(row => row.authorization === 'Bearer token-user-a'));
  await f.bind(null);
  const count = f.requests.length; await f.worker.runOnce(); assert.equal(f.requests.length, count);
  await f.worker.stop();
}

// 服务端已保存但响应丢失：重启复用设备 ID、检查点、同一批次标识，不重新采集。
{
  const receipts = new Map(); let lost = true, serverWrites = 0;
  const transport = async (path, body) => {
    if (path === 'claim') return reply(claim('run-resume', ['like']));
    if (path !== 'batch') return reply({});
    if (!receipts.has(body.batch_id)) { serverWrites++; receipts.set(body.batch_id, batchResult(body)); }
    if (lost) { lost = false; throw new Error('响应丢失'); }
    return reply(receipts.get(body.batch_id));
  };
  const first = await fixture('resume', { collect: async () => capture(150), fetch: transport });
  await first.worker.runOnce();
  assert.equal(first.collections, 1);
  assert.equal(first.requests.filter(row => row.path === 'complete').length, 0);
  const original = first.requests.find(row => row.path === 'batch').body;
  const firstDevice = first.requests.find(row => row.path === 'claim').body.device_id;
  await first.worker.stop();
  const second = await fixture('resume', { collect: async () => { throw new Error('不应重新采集'); }, fetch: transport });
  await second.worker.runOnce();
  assert.equal(second.collections, 0);
  assert.deepEqual(second.requests.find(row => row.path === 'batch').body, original);
  assert.equal(second.requests.find(row => row.path === 'claim').body.device_id, firstDevice);
  assert.equal(serverWrites, 2);
  assert.equal(second.requests.filter(row => row.path === 'complete').length, 1);
  await second.worker.stop();
}

// 网络离线不采集；手动同步占用不取消、不把它错误标记为每日研究完成。
{
  const offline = await fixture('offline', { fetch: async () => { throw new Error('offline'); } });
  await offline.worker.runOnce(); assert.equal(offline.collections, 0); await offline.worker.stop();
  const busy = await fixture('manual-busy', { collect: async () => ({ success: false, platform: 'douyin', code: 'LOCAL_ACTION_BUSY' }) });
  await busy.worker.runOnce();
  assert.equal(busy.requests.filter(row => row.path === 'complete').length, 0);
  assert.equal(busy.cancellations.length, 0); await busy.worker.stop();
}

// 采集中临时离线，公开清单仍落盘；网络恢复继续保存，不重复读取平台。
{
  const pending = deferred(), entered = deferred();
  const f = await fixture('offline-capture', { collect: async () => { entered.resolve(); await pending.promise; return capture(5); },
    fetch: async (path, body) => reply(path === 'claim' ? claim('run-offline-capture', ['like']) : path === 'batch' ? batchResult(body) : {}) });
  const work = f.worker.runOnce(); await entered.promise;
  f.setOnline(false); pending.resolve(); await work;
  assert.equal(f.requests.filter(row => row.path === 'batch').length, 0);
  f.setOnline(true); await f.worker.runOnce();
  assert.equal(f.collections, 1);
  assert.equal(f.requests.filter(row => row.path === 'complete').length, 1);
  await f.worker.stop();
}

// 云端规则暂停/租约失效立即取消本轮官方会话，不继续上传。
{
  const cancelled = deferred();
  const f = await fixture('lease-invalid', { collect: async (_request, worker) => {
    worker.recordPlatformStatus({ platform: 'douyin', mode: 'like', stage: 'needs-action', message: '等待验证' });
    await cancelled.promise; return capture(5);
  }, cancel: () => cancelled.resolve(), fetch: async (path, body) => {
    if (path === 'claim') return reply(claim('run-invalidated', ['like']));
    if (path === 'progress' && body.stage === 'waiting_for_user') return Response.json({ success: false }, { status: 409 });
    return reply({});
  } });
  await f.worker.runOnce();
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.requests.filter(row => ['batch', 'complete'].includes(row.path)).length, 0);
  await f.worker.stop();
}

// 短期令牌 401 只暂停本轮并保留检查点；同账号刷新令牌后可继续，不需要退出或重新登录。
{
  const cancelled = deferred(); let expired = true, attempt = 0;
  const f = await fixture('token-refresh-race', { collect: async (_request, worker) => {
    if (++attempt === 1) {
      worker.recordPlatformStatus({ platform: 'douyin', mode: 'like', stage: 'needs-action', message: '等待验证' });
      await cancelled.promise;
      return { success: false, platform: 'douyin', cancelled: true };
    }
    return capture(5);
  }, cancel: () => cancelled.resolve(), fetch: async (path, body) => {
    if (path === 'claim') return reply(claim('run-token-refresh', ['like']));
    if (path === 'progress' && body.stage === 'waiting_for_user' && expired) {
      expired = false;
      return Response.json({ success: false }, { status: 401 });
    }
    return reply(path === 'batch' ? batchResult(body) : {});
  } });
  await f.worker.runOnce();
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.requests.filter(row => ['batch', 'complete'].includes(row.path)).length, 0);
  const savedName = (await readdir(join(root, 'token-refresh-race'))).find(name => name.endsWith('.json'));
  assert.equal(JSON.parse(await readFile(join(root, 'token-refresh-race', savedName), 'utf8')).run_id, 'run-token-refresh');
  await f.bind({ ...session(), token: 'refreshed-token' });
  await f.worker.runOnce();
  assert.equal(f.requests.filter(row => row.path === 'complete').length, 1);
  assert.equal(f.requests.find(row => row.path === 'batch').authorization, 'Bearer refreshed-token');
  assert.ok(f.errors.every(message => !/重新登录|登录需要/.test(message)));
  assert.ok(f.requests.every(row => !['logout', 'refresh', 'migrate'].includes(row.path)), '消费者不修改会话生命周期');
  await f.worker.stop();
}

// 同平台同来源的手动任务不能更新每日研究状态：平台独占锁之外再核实批次所有权。
{
  const f = await fixture('manual-status-isolation', { ownsSession: () => false, collect: async (_request, worker) => {
    worker.recordPlatformStatus({ platform: 'douyin', mode: 'like', stage: 'needs-action', message: '手动任务正在验证', readCount: 450 });
    return { success: false, platform: 'douyin', code: 'LOCAL_ACTION_BUSY' };
  } });
  await f.worker.runOnce();
  assert.equal(f.requests.filter(row => row.path === 'progress' && row.body.stage === 'waiting_for_user').length, 0);
  assert.ok(f.requests.filter(row => row.path === 'progress').every(row => row.body.read === 0));
  assert.equal(f.cancellations.length, 0);
  await f.worker.stop();
}

// 旧后端尚未部署路由时仅诊断日志；不采集、不取消、不清除身份，下一轮仍可探测。
{
  const f = await fixture('backend-not-deployed', { fetch: async () => Response.json({ detail: 'Not Found' }, { status: 404 }) });
  await f.worker.runOnce(); await f.worker.runOnce();
  assert.equal(f.collections, 0);
  assert.equal(f.cancellations.length, 0);
  assert.equal(f.requests.filter(row => row.path === 'claim').length, 2);
  assert.ok(f.requests.every(row => row.authorization === 'Bearer token-user-a'));
  assert.equal(f.errors.length, 2);
  await f.worker.stop();
}

// 领取时遇到一次 401 的文案同样表示等待会话恢复，而非要求用户重新登录。
{
  let first = true;
  const f = await fixture('claim-token-race', { fetch: async () => {
    if (first) { first = false; return Response.json({ success: false }, { status: 401 }); }
    return reply(null);
  } });
  await f.worker.runOnce();
  assert.match(f.errors[0], /会话正在重新确认/);
  await f.worker.runOnce();
  assert.equal(f.requests.length, 2);
  assert.equal(f.cancellations.length, 0);
  await f.worker.stop();
}

// 平台失败如实提交 partial/error；不能将未证实的空列表报告为成功。
{
  const f = await fixture('capture-failed', { collect: async (request, worker) => {
    worker.recordPlatformStatus({ platform: 'douyin', mode: request.mode, stage: 'collecting', message: '已读取 40 条', readCount: 40 });
    return { success: false, platform: 'douyin', error: '官方验证等待超时' };
  } });
  await f.worker.runOnce();
  const done = f.requests.find(row => row.path === 'complete').body;
  assert.equal(done.coverage, 'partial');
  assert.ok(done.sources.every(source => source.error.includes('验证') && source.saved === 0));
  assert.ok(done.sources.every(source => source.read === 40 && source.failed === 40), '失败前观察到但未交付的条目明确计入失败，允许云端终结任务');
  await f.worker.stop();
}

// 固定来源与条数白名单，拒绝异常远端任务及非官方元数据。
{
  const f = await fixture('invalid-task', { fetch: async () => reply({ ...claim(), request: { ...claim().request, platforms: ['shell'] } }) });
  await f.worker.runOnce(); assert.equal(f.collections, 0); await f.worker.stop();
  assert.throws(() => dailyResearchMetadata({ ...capture(0), urls: ['https://example.test/video/12345'] }, 500));
  assert.throws(() => dailyResearchMetadata(capture(2), 1));
}

console.log('每日研究桌面消费者：并发、500/100 分批、验证暂停、账号切换、离线、重启幂等、失败与白名单验证通过');
