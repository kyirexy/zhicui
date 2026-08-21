import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AGENT_RESEARCH_MODE,
  DEFAULT_AGENT_WEB_SCOPE,
  researchProgressDetail,
  shouldResumeAgentTurn,
  threadHasBackgroundWork,
} from './agentTurnUi.ts';
import type { AgentThread } from './types.ts';

function thread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: 'thread-1',
    title: '研究',
    status: 'ready',
    source_scope: 'all_ready',
    source_ids: [],
    source_count: 37,
    message_count: 0,
    created_at: '2026-08-21T00:00:00Z',
    updated_at: '2026-08-21T00:00:00Z',
    ...overrides,
  };
}

test('Harness 默认自动选择研究深度，并且不主动使用网页', () => {
  assert.equal(DEFAULT_AGENT_RESEARCH_MODE, 'auto');
  assert.equal(DEFAULT_AGENT_WEB_SCOPE, 'video_only');
});

test('刷新时 queued Turn 仍被识别为后台任务并恢复事件流', () => {
  const queued = thread({
    active_turn: {
      id: 'turn-1', thread_id: 'thread-1', client_turn_id: 'client-turn-1',
      status: 'queued', phase: 'queued', requested_mode: 'auto',
      resolved_mode: 'deep', output_style: 'answer', web_scope: 'video_only',
      attempt_count: 0, cancellation_requested: false, source_total_count: 37,
      scanned_count: 0, mapped_count: 0, deep_read_count: 0,
      failed_source_count: 0, claim_count: 0, evidence_count: 0,
      last_event_seq: 1, created_at: '2026-08-21T00:00:00Z',
      updated_at: '2026-08-21T00:00:00Z',
    },
  });
  assert.equal(threadHasBackgroundWork(queued), true);
  assert.equal(shouldResumeAgentTurn({ active: true, sending: false, thread: queued }), true);
  assert.equal(shouldResumeAgentTurn({ active: false, sending: false, thread: queued }), false);
});

test('进度只展示服务端已经报告的真实分层计数', () => {
  assert.equal(
    researchProgressDetail({
      stage: 'verifying', message: '正在核验证据', source_total_count: 37,
      scanned_count: 37, mapped_count: 37, deep_read_count: 12, claim_count: 4,
    }),
    '扫描 37/37 · 映射 37 · 深读 12 · 观点 4',
  );
  assert.equal(
    researchProgressDetail({ stage: 'scanning', message: '正在扫描', scanned_count: 8 }),
    '扫描 8',
  );
});
