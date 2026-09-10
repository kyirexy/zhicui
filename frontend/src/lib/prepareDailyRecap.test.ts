import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DailyRecap, DailyRecapItem } from './dailyRecapApi';

type PreparationApi = typeof import('./prepareDailyRecap');
type Call = { name: string; args: unknown[] };
type StreamCallbacks = { onTurn?: (id: string) => void; onProgress?: (event: { message: string }) => void };
type Thread = { id: string; source_scope: string; source_ids: string[]; message_count: number; active_turn?: unknown };
const ok = (data: unknown) => ({ success: true, data });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function item(index: number, ready = true, platform: DailyRecapItem['platform'] = 'douyin'): DailyRecapItem {
  return {
    id: `${platform}:${index}`, video_id: platform === 'douyin' ? `video-${index}` : `BV${index}`,
    note_id: ready ? `note-${index}` : null, platform, title: `样例 ${index}`, cover_url: '',
    source_url: `https://example.invalid/video/${index}`, source_modes: ['collect'],
    first_seen_at: '2026-09-09T08:00:00Z', can_extract: true, transcript_ready: ready,
    ai_initialized: false, initial_import: false,
  };
}

function recap(items = [item(1), item(2)]): DailyRecap {
  return {
    date: '2026-09-09', timezone: 'Asia/Shanghai', time_basis: 'first_discovered',
    time_basis_label: '按知萃首次同步记录', message: '', total: items.length,
    like_count: 0, collect_count: items.length, ready_count: items.filter((value) => value.transcript_ready).length,
    pending_count: items.filter((value) => !value.transcript_ready).length, initial_import_count: 0,
    items, preview: items.slice(0, 3), has_more: false,
    ready_note_ids: items.filter((value) => value.transcript_ready).map((value) => value.note_id!),
  };
}

function job(status = 'running', total = 4) {
  return { job_id: 'job-1', status, total, active: status === 'running' ? Math.min(4, total) : 0,
    queued: Math.max(total - 4, 0), success: status === 'running' ? 0 : total,
    failed: 0, operation: 'transcript', items: [], concurrency: { asr: 4, llm: 1 } };
}

function harness(initial = recap()) {
  const calls: Call[] = [];
  const stored = new Map<string, string>();
  const timers = new Map<number, () => void>();
  const threads = new Map<string, Thread>();
  const runtime = { token: 'token-user-a' as string | null, recap: initial };
  let serial = 0;
  let timerSerial = 0;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getDailyRecap: () => copy(runtime.recap),
    createAgentThread: (body) => {
      const thread = { id: `thread-${++serial}`, ...(body as object), message_count: 0 } as Thread;
      threads.set(thread.id, thread);
      return ok(thread);
    },
    getAgentThread: (id) => threads.has(String(id)) ? ok(threads.get(String(id))) : { success: false, status: 404 },
    startDouyinBatchExtraction: () => ok(job()),
    getDouyinBatchExtraction: () => ok(job('success')),
    importPlatformLibraryItems: () => ok({}),
    streamAgentMessage: () => ok({}),
    resumeAgentTurnStream: () => ok({}),
  };
  const request = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return handlers[name](...args);
  };
  const exports = {} as PreparationApi;
  const source = readFileSync(new URL('./prepareDailyRecap.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  runInNewContext(js, {
    exports, Error, AbortController,
    crypto: { randomUUID: () => `client-turn-${++serial}` },
    setTimeout: (callback: () => void) => { const id = ++timerSerial; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
    require(name: string) {
      if (name === './api') return Object.fromEntries(Object.keys(handlers).map((key) => [key, request(key)]));
      if (name === './authSession') return { readStoredToken: () => runtime.token };
      if (name === './dailyRecapApi') return { getDailyRecap: request('getDailyRecap') };
      throw new Error(name);
    },
  });
  const progress: string[] = [];
  return {
    runtime, handlers, calls, stored, threads, progress,
    run: (signal?: AbortSignal, onProgress = (value: string) => { progress.push(value); }) =>
      exports.prepareDailyRecap(initial, onProgress, signal, 'user-a'),
    count: (name: string) => calls.filter((call) => call.name === name).length,
    last: (name: string) => calls.filter((call) => call.name === name).at(-1)!,
    tick() { const next = timers.entries().next().value; assert.ok(next, '应存在文稿轮询计时器'); timers.delete(next[0]); next[1](); },
    seed(value: object) { stored.set(`zhicui:daily-recap:v1:user-a:${initial.date}:${initial.timezone}`, JSON.stringify(value)); },
    state() { return JSON.parse([...stored.values()].at(-1) || '{}'); },
  };
}

test('全部文稿就绪时跳过 ASR，只创建选中资料的回顾；跨午夜请求仍固定原日期', async () => {
  const h = harness();
  h.runtime.recap = { ...h.runtime.recap, date: '2026-09-10' };
  const result = await h.run();
  assert.match(result.href, /^\/harness\?thread=thread-/);
  assert.equal(h.count('startDouyinBatchExtraction'), 0);
  assert.equal(h.count('importPlatformLibraryItems'), 0);
  assert.deepEqual(copy(h.last('createAgentThread').args[0]), {
    title: '2026-09-09 昨日回顾', source_scope: 'selected', source_ids: ['note-1', 'note-2'],
  });
  for (const call of h.calls.filter((value) => value.name === 'getDailyRecap')) {
    assert.equal(call.args[0], 'Asia/Shanghai');
    assert.equal(call.args[2], '2026-09-09');
  }
  const body = h.last('streamAgentMessage').args[1] as Record<string, string>;
  assert.equal(body.web_scope, 'video_only');
  assert.match(body.content, /2026-09-09/);
  assert.match(body.content, /不代表当天实际点赞收藏/);
  assert.equal(h.state().complete, true);
});

test('缺失文稿一次整批提交，实际活动数量 4 展示在进度中，完成后只用重新读取的 Note', async () => {
  const original = recap(Array.from({ length: 6 }, (_, index) => item(index, false)));
  const h = harness(original);
  h.handlers.startDouyinBatchExtraction = () => ok(job('running', 6));
  h.handlers.getDouyinBatchExtraction = () => {
    h.runtime.recap = recap(Array.from({ length: 6 }, (_, index) => item(index)));
    return ok(job('success', 6));
  };
  const pending = h.run();
  await settle();
  assert.equal(h.count('startDouyinBatchExtraction'), 1);
  assert.deepEqual(copy(h.last('startDouyinBatchExtraction').args), [
    ['video-0', 'video-1', 'video-2', 'video-3', 'video-4', 'video-5'], 'transcript',
  ]);
  assert.ok(h.progress.some((message) => message.includes('同时处理 4 条')));
  assert.equal(h.count('createAgentThread'), 0);
  h.tick();
  await pending;
  assert.equal(h.count('startDouyinBatchExtraction'), 1);
  assert.equal((h.last('createAgentThread').args[0] as { source_ids: string[] }).source_ids.length, 6);
});

test('部分提取失败或资料变为隐藏，只分析仍可见且就绪的资料，并在提示词明确缺失范围', async () => {
  const h = harness(recap([item(1), item(2, false), item(3, false)]));
  h.handlers.startDouyinBatchExtraction = () => {
    h.runtime.recap = recap([item(1), item(2, false)]);
    return ok({ ...job('partial', 2), success: 0, failed: 2 });
  };
  await h.run();
  assert.deepEqual(copy((h.last('createAgentThread').args[0] as { source_ids: string[] }).source_ids), ['note-1']);
  const body = h.last('streamAgentMessage').args[1] as { content: string };
  assert.match(body.content, /本次选择 3 条；2 条未就绪或已不可见/);
  assert.match(body.content, /不要假装已经读过/);
  assert.ok(h.progress.some((message) => message.includes('2 条暂不可用')));
});

test('所有文稿仍缺失时保留同步记录，不创建空的 AI 会话', async () => {
  const h = harness(recap([item(1, false)]));
  h.handlers.startDouyinBatchExtraction = () => ok({ ...job('failed', 1), success: 0, failed: 1 });
  await assert.rejects(h.run(), /文稿尚未就绪/);
  assert.equal(h.count('createAgentThread'), 0);
  assert.equal(h.count('streamAgentMessage'), 0);
});

test('同一账号日期重复点击只启动一个操作，完成后继续打开已有回顾', async () => {
  const h = harness();
  let release!: (value: DailyRecap) => void;
  h.handlers.getDailyRecap = () => new Promise((resolve) => { release = resolve; });
  const first = h.run();
  await assert.rejects(h.run(), /正在处理中/);
  assert.equal(h.count('getDailyRecap'), 1);
  h.handlers.getDailyRecap = () => h.runtime.recap;
  release(h.runtime.recap);
  const result = await first;
  assert.deepEqual(copy(await h.run()), copy(result));
  assert.equal(h.count('createAgentThread'), 1);
  assert.equal(h.count('streamAgentMessage'), 1);
});

test('初次读取期间切换账号或取消，旧操作不能发起新的提取或 AI 请求', async () => {
  for (const action of ['switch', 'abort'] as const) {
    const h = harness(recap([item(1, false)]));
    const controller = new AbortController();
    let release!: (value: DailyRecap) => void;
    h.handlers.getDailyRecap = () => new Promise((resolve) => { release = resolve; });
    const pending = h.run(controller.signal);
    const rejected = assert.rejects(pending, action === 'switch' ? /账号已切换/ : /已暂停/);
    if (action === 'switch') h.runtime.token = 'token-user-b'; else controller.abort();
    release(h.runtime.recap);
    await rejected;
    assert.equal(h.count('startDouyinBatchExtraction'), 0);
    assert.equal(h.count('createAgentThread'), 0);
    assert.equal(h.count('streamAgentMessage'), 0);
  }
});

test('等待中取消后保存已有文稿任务，下一次继续轮询而不重新提交 ASR', async () => {
  const h = harness(recap([item(1, false)]));
  const controller = new AbortController();
  const pending = h.run(controller.signal);
  const rejected = assert.rejects(pending, /已暂停/);
  await settle();
  controller.abort();
  await rejected;
  assert.equal(h.state().jobId, 'job-1');
  assert.equal(h.count('createAgentThread'), 0);
  h.handlers.getDouyinBatchExtraction = () => {
    h.runtime.recap = recap([item(1)]);
    return ok(job('success', 1));
  };
  await h.run(new AbortController().signal);
  assert.equal(h.count('startDouyinBatchExtraction'), 1);
  assert.equal(h.count('getDouyinBatchExtraction'), 1);
  assert.equal(h.count('streamAgentMessage'), 1);
});

test('轮询返回时账号已切换，不能继续读取回顾或提交 AI', async () => {
  const h = harness(recap([item(1, false)]));
  h.handlers.getDouyinBatchExtraction = () => { h.runtime.token = 'token-user-b'; return ok(job('success', 1)); };
  const pending = h.run();
  const rejected = assert.rejects(pending, /账号已切换/);
  await settle();
  h.tick();
  await rejected;
  assert.equal(h.count('getDailyRecap'), 1);
  assert.equal(h.count('createAgentThread'), 0);
});

test('已经发送 AI 但响应丢失时复用原会话，不重发、不再次收费', async () => {
  const h = harness();
  h.handlers.streamAgentMessage = () => { throw new Error('响应连接中断'); };
  await assert.rejects(h.run(), /响应连接中断/);
  assert.equal(h.state().sent, true);
  const originalThread = h.state().threadId;
  const result = await h.run();
  assert.equal(result.href, `/harness?thread=${originalThread}`);
  assert.equal(h.count('createAgentThread'), 1);
  assert.equal(h.count('streamAgentMessage'), 1);
  assert.equal(h.count('resumeAgentTurnStream'), 0);
});

test('收到 AI turn 标识后断线，只恢复已有流，不重新提取或发送用户消息', async () => {
  const h = harness();
  h.handlers.streamAgentMessage = (_id, _body, callbacks) => {
    (callbacks as StreamCallbacks).onTurn!('turn-existing');
    throw new Error('流已断开');
  };
  await assert.rejects(h.run(), /流已断开/);
  const state = h.state();
  await h.run();
  assert.deepEqual(copy(h.last('resumeAgentTurnStream').args.slice(0, 2)), [state.threadId, 'turn-existing']);
  assert.equal(h.count('streamAgentMessage'), 1);
  assert.equal(h.count('startDouyinBatchExtraction'), 0);
  assert.equal(h.state().complete, true);
});

test('已有 AI 任务失败、取消或恢复断流时仍打开原会话，不标记完成也不重复生成', async () => {
  for (const response of [
    { success: false, status: 502, error: '视频 Agent 暂时没有完成回答' },
    { success: false, status: 409, error: '本次生成已停止' },
    { success: false, error: '回答数据流提前结束，请重新生成' },
  ]) {
    const h = harness();
    h.seed({ scope: h.runtime.recap.items.map((value) => value.id).sort(),
      threadId: 'thread-existing', turnId: 'turn-existing', sent: true });
    h.threads.set('thread-existing', { id: 'thread-existing', source_scope: 'selected',
      source_ids: ['note-1', 'note-2'], message_count: 1 });
    h.handlers.resumeAgentTurnStream = () => response;
    const result = await h.run();
    assert.equal(result.href, '/harness?thread=thread-existing');
    assert.notEqual(h.state().complete, true);
    assert.equal(h.state().turnId, 'turn-existing');
    assert.equal(h.count('resumeAgentTurnStream'), 1);
    assert.equal(h.count('createAgentThread'), 0);
    assert.equal(h.count('streamAgentMessage'), 0);
    assert.equal(h.count('startDouyinBatchExtraction'), 0);
  }
});

test('创建空会话后取消，重试核对相同来源并复用原会话及请求标识', async () => {
  const h = harness();
  const controller = new AbortController();
  const create = h.handlers.createAgentThread;
  h.handlers.createAgentThread = (...args) => { const result = create(...args); controller.abort(); return result; };
  await assert.rejects(h.run(controller.signal), /已暂停/);
  const original = h.state();
  assert.ok(original.threadId);
  assert.equal(h.count('streamAgentMessage'), 0);
  h.handlers.createAgentThread = create;
  await h.run();
  assert.equal(h.count('createAgentThread'), 1, '同范围未发送会话必须复用，不能留下重复空会话');
  assert.equal(h.last('streamAgentMessage').args[0], original.threadId);
  assert.equal((h.last('streamAgentMessage').args[1] as { client_turn_id: string }).client_turn_id, original.clientTurnId);
});

test('空会话重试发现 Note 已变化时重新限定当前来源，不将旧 Note 交给 AI', async () => {
  const h = harness();
  const scope = h.runtime.recap.items.map((value) => value.id).sort();
  h.seed({ scope, threadId: 'old-thread', clientTurnId: 'old-turn' });
  h.threads.set('old-thread', { id: 'old-thread', source_scope: 'selected', source_ids: ['old-note'], message_count: 0 });
  await h.run();
  assert.equal(h.count('createAgentThread'), 1);
  assert.deepEqual(copy((h.last('createAgentThread').args[0] as { source_ids: string[] }).source_ids), ['note-1', 'note-2']);
  assert.notEqual(h.last('streamAgentMessage').args[0], 'old-thread');
});

test('会话已在别处开始问答时不自动补发回顾', async () => {
  const h = harness();
  h.seed({ scope: h.runtime.recap.items.map((value) => value.id).sort(), threadId: 'used-thread' });
  h.threads.set('used-thread', { id: 'used-thread', source_scope: 'selected', source_ids: ['note-1', 'note-2'], message_count: 1 });
  assert.equal((await h.run()).href, '/harness?thread=used-thread');
  assert.equal(h.count('createAgentThread'), 0);
  assert.equal(h.count('streamAgentMessage'), 0);
});

test('进度回调触发取消时，不能在回调之后新建会话或恢复 AI 请求', async () => {
  for (const recovering of [false, true]) {
    const h = harness();
    if (recovering) {
      h.seed({ scope: h.runtime.recap.items.map((value) => value.id).sort(), threadId: 'thread-existing', turnId: 'turn-existing', sent: true });
      h.threads.set('thread-existing', { id: 'thread-existing', source_scope: 'selected', source_ids: ['note-1', 'note-2'], message_count: 1 });
    }
    const controller = new AbortController();
    await assert.rejects(h.run(controller.signal, () => controller.abort()), /已暂停/);
    assert.equal(h.count('createAgentThread'), 0);
    assert.equal(h.count('resumeAgentTurnStream'), 0);
    assert.equal(h.count('streamAgentMessage'), 0);
  }
});

test('B站单条网络失败隔离，仍就绪的资料可以进入回顾', async () => {
  const h = harness(recap([item(1), item(2, false, 'bilibili'), item(3, false, 'bilibili')]));
  h.handlers.importPlatformLibraryItems = (urls) => {
    if ((urls as string[])[0].endsWith('/2')) throw new Error('字幕网络失败');
    h.runtime.recap = recap([item(1), item(2, false, 'bilibili'), item(3, true, 'bilibili')]);
    return ok({});
  };
  await h.run();
  assert.equal(h.count('importPlatformLibraryItems'), 2);
  assert.deepEqual(copy((h.last('createAgentThread').args[0] as { source_ids: string[] }).source_ids), ['note-1', 'note-3']);
  assert.match((h.last('streamAgentMessage').args[1] as { content: string }).content, /1 条未就绪或已不可见/);
});
