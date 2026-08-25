import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_TEXT_STREAM_DEFAULT_DRAIN_TIMEOUT_MS,
  AgentTextStreamPump,
  decideAgentTextStreamDrain,
} from './agentTextStream.ts';

function createFrameHarness() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    schedule(callback: FrameRequestCallback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id: number) {
      callbacks.delete(id);
    },
    run(timestamp: number) {
      const current = [...callbacks.values()];
      callbacks.clear();
      current.forEach((callback) => callback(timestamp));
    },
    count() {
      return callbacks.size;
    },
  };
}

test('常态流每次只排空小字符组', () => {
  assert.deepEqual(decideAgentTextStreamDrain({
    pendingCharacters: 40,
    oldestAgeMs: 32,
  }), {
    mode: 'smooth',
    characters: 20,
    intervalMs: 24,
  });
});

test('队列过深或等待过久时进入追赶档', () => {
  assert.deepEqual(decideAgentTextStreamDrain({
    pendingCharacters: 240,
    oldestAgeMs: 40,
  }), {
    mode: 'catch-up',
    characters: 32,
    intervalMs: 16,
  });
  assert.deepEqual(decideAgentTextStreamDrain({
    pendingCharacters: 20,
    oldestAgeMs: 1_300,
  }), {
    mode: 'catch-up',
    characters: 20,
    intervalMs: 16,
  });
});

test('终态 drain 立即切换到快速追赶且保持单帧上限', () => {
  assert.deepEqual(decideAgentTextStreamDrain({
    pendingCharacters: 6_000,
    oldestAgeMs: 0,
    finishing: true,
  }), {
    mode: 'catch-up',
    characters: 192,
    intervalMs: 16,
  });
  assert.equal(AGENT_TEXT_STREAM_DEFAULT_DRAIN_TIMEOUT_MS, 2_500);
});

test('同一绘制帧前的多个 delta 只触发一次有界提交', () => {
  const frames = createFrameHarness();
  const commits: string[] = [];
  let now = 0;
  const pump = new AgentTextStreamPump({
    onCommit: (text) => commits.push(text),
    scheduleFrame: (callback) => frames.schedule(callback),
    cancelFrame: (id) => frames.cancel(id),
    now: () => now,
  });

  pump.enqueue('甲乙丙丁');
  pump.enqueue('戊己庚辛');
  assert.equal(frames.count(), 1);
  now = 16;
  frames.run(now);
  assert.deepEqual(commits, ['甲乙丙丁戊己庚辛']);

  now = 32;
  frames.run(now);
  assert.deepEqual(commits, ['甲乙丙丁戊己庚辛']);
});

test('大量积压也保持有界提交，不会把证据正文整块塞进一帧', () => {
  const decision = decideAgentTextStreamDrain({
    pendingCharacters: 8_000,
    oldestAgeMs: 2_000,
  });
  assert.equal(decision.mode, 'catch-up');
  assert.equal(decision.characters, 192);
  assert.equal(decision.intervalMs, 16);
});

test('六千字终态积压在 60Hz 下 1.5 秒内排空', async () => {
  const frames = createFrameHarness();
  const commits: string[] = [];
  let now = 0;
  const answer = '流'.repeat(6_000);
  const pump = new AgentTextStreamPump({
    onCommit: (text) => commits.push(text),
    scheduleFrame: (callback) => frames.schedule(callback),
    cancelFrame: (id) => frames.cancel(id),
    now: () => now,
  });

  pump.enqueue(answer);
  const drainPromise = pump.drain(60_000);
  let frameCount = 0;
  while (frames.count() && frameCount < 200) {
    now += 16;
    frameCount += 1;
    frames.run(now);
  }
  await drainPromise;

  assert.equal(commits.join(''), answer);
  assert.ok(frameCount * 16 <= 1_500);
  assert.ok(commits.every((chunk) => Array.from(chunk).length <= 192));
});

test('drain 等待所有帧完成后再允许 canonical 消息接管', async () => {
  const frames = createFrameHarness();
  const commits: string[] = [];
  let now = 0;
  const answer = '总览。\n\n### 已核验原文\n\n- 证据内容。'.repeat(30);
  const pump = new AgentTextStreamPump({
    onCommit: (text) => commits.push(text),
    scheduleFrame: (callback) => frames.schedule(callback),
    cancelFrame: (id) => frames.cancel(id),
    now: () => now,
  });

  pump.enqueue(answer);
  let drained = false;
  const drainPromise = pump.drain(60_000).then(() => {
    drained = true;
  });
  for (let index = 0; index < 200 && frames.count(); index += 1) {
    now += 32;
    frames.run(now);
  }
  await drainPromise;

  assert.equal(drained, true);
  assert.equal(commits.join(''), answer);
  assert.ok(commits.length > 1);
});

test('减少动态效果时仍按帧合并，但一次提交全部积压', () => {
  const frames = createFrameHarness();
  const commits: string[] = [];
  const pump = new AgentTextStreamPump({
    onCommit: (text) => commits.push(text),
    reducedMotion: true,
    scheduleFrame: (callback) => frames.schedule(callback),
    cancelFrame: (id) => frames.cancel(id),
    now: () => 0,
  });

  pump.enqueue('第一段');
  pump.enqueue('第二段');
  assert.deepEqual(commits, []);
  frames.run(16);
  assert.deepEqual(commits, ['第一段第二段']);
});

test('作废队列后迟到的帧不得覆盖终态消息', () => {
  const callbacks: FrameRequestCallback[] = [];
  const commits: string[] = [];
  const pump = new AgentTextStreamPump({
    onCommit: (text) => commits.push(text),
    scheduleFrame: (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    // 故意不移除回调，模拟取消后仍到达的旧帧。
    cancelFrame: () => undefined,
    now: () => 0,
  });

  pump.enqueue('未完成草稿');
  pump.discard();
  callbacks[0](16);
  assert.deepEqual(commits, []);
});
