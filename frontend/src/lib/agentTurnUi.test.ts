import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_AGENT_ACTIVITY_EXPANDED,
  DEFAULT_AGENT_RESEARCH_MODE,
  DEFAULT_AGENT_WEB_SCOPE,
  agentActivityLabel,
  agentEventSequenceDecision,
  agentTurnTerminalMessage,
  hasVisibleAgentAnswer,
  isVisibleAgentActivityProgress,
  nextAgentActivityExpanded,
  projectAgentActivity,
  researchProgressDetail,
  shouldShowAgentCitationCoverage,
  shouldResumeAgentTurn,
  threadHasBackgroundWork,
} from './agentTurnUi.ts';
import type { AgentThread } from './types.ts';

test('只有真实正文到达后才认为回答已经开始', () => {
  assert.equal(hasVisibleAgentAnswer(''), false);
  assert.equal(hasVisibleAgentAnswer('   '), false);
  assert.equal(hasVisibleAgentAnswer(undefined), false);
  assert.equal(hasVisibleAgentAnswer('第一段回答'), true);
});

test('只有存在已核验依据时才展示引用覆盖率', () => {
  assert.equal(shouldShowAgentCitationCoverage(0, {
    requested: 6,
    verified: 0,
  }), false);
  assert.equal(shouldShowAgentCitationCoverage(2, {
    requested: 4,
    verified: 2,
  }), true);
  assert.equal(shouldShowAgentCitationCoverage(0, {
    requested: 4,
    verified: 2,
  }), false);
});

test('研究动作默认单行收拢，只在用户主动操作时展开', () => {
  assert.equal(DEFAULT_AGENT_ACTIVITY_EXPANDED, false);
  assert.equal(nextAgentActivityExpanded(false, 'toggle'), true);
  assert.equal(nextAgentActivityExpanded(true, 'toggle'), false);
  assert.equal(nextAgentActivityExpanded(true, 'answer-started'), false);
  assert.equal(nextAgentActivityExpanded(true, 'turn-restored'), false);
});

test('Codex 式活动标题隐藏冗长的通用工具文案', () => {
  assert.equal(agentActivityLabel({
    stage: 'synthesizing',
    message: '正在执行研究步骤：综合候选依据并生成回答',
    event_type: 'turn.tool.started',
    tool_name: 'video.answer_synthesize',
  }), '正在组织回答');
  assert.equal(agentActivityLabel({
    stage: 'verifying',
    message: '完成研究步骤',
    event_type: 'turn.tool.completed',
    tool_name: 'video.claim_validate',
  }), '已完成校验引用');
});

test('终止态不会向用户泄露数据库内部错误', () => {
  assert.equal(agentTurnTerminalMessage({
    status: 'cancelled',
    errorMessage: "(sqlite3.IntegrityError) UNIQUE constraint failed: agent_events.turn_id",
  }), '已停止生成，已经完成的内容仍然保留。');
  assert.equal(agentTurnTerminalMessage({
    status: 'failed',
    errorMessage: "This Session's transaction has been rolled back after IntegrityError SQL: INSERT",
  }), '研究状态同步时遇到冲突，请重新尝试。');
});

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

test('Harness 默认自动选择研究深度，并按问题需要查证网页', () => {
  assert.equal(DEFAULT_AGENT_RESEARCH_MODE, 'auto');
  assert.equal(DEFAULT_AGENT_WEB_SCOPE, 'auto');
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

test('没有 active Turn 的幽灵 running 状态不会让 Harness 永久轮询', () => {
  const ghost = thread({ status: 'running', active_turn: null });
  assert.equal(threadHasBackgroundWork(ghost), false);
  assert.equal(
    shouldResumeAgentTurn({ active: true, sending: false, thread: ghost }),
    false,
  );
  assert.equal(
    threadHasBackgroundWork(thread({ status: 'running_analysis' })),
    true,
  );
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

test('活动流用稳定批次键更新，并忽略重复回放事件', () => {
  const started = projectAgentActivity([], {
    stage: 'researching',
    message: '正在核对第 1/8 批视频',
    event_type: 'turn.map.batch.started',
    event_seq: 11,
    batch_index: 0,
    batch_total: 8,
    batch_source_count: 5,
    mapped_count: 0,
    source_total_count: 37,
  });
  assert.equal(started.length, 1);
  assert.equal(started[0].id, 'map-batch-0');
  assert.equal(started[0].status, 'running');

  const completed = projectAgentActivity(started, {
    stage: 'researching',
    message: '已核对第 1/8 批视频',
    event_type: 'turn.map.batch.completed',
    event_seq: 15,
    batch_index: 0,
    batch_total: 8,
    mapped_count: 5,
    source_total_count: 37,
    duration_ms: 9_800,
  });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, 'completed');
  assert.match(completed[0].detail, /批次 1\/8/);
  assert.match(completed[0].detail, /映射 5/);

  const replayed = projectAgentActivity(completed, {
    stage: 'researching',
    message: '旧事件不得覆盖',
    event_type: 'turn.map.batch.started',
    event_seq: 11,
    batch_index: 0,
    batch_total: 8,
  });
  assert.deepEqual(replayed, completed);
});

test('活动流不把流水线旁白补成固定研究步骤', () => {
  const stagedNarration = {
    stage: 'web' as const,
    message: '正在判断是否需要外部查证',
    event_type: 'turn.progress',
    event_seq: 9,
  };
  assert.equal(isVisibleAgentActivityProgress(stagedNarration), false);
  assert.deepEqual(projectAgentActivity([], stagedNarration), []);

  for (const eventType of ['turn.created', 'turn.started', 'turn.answer.started']) {
    assert.equal(isVisibleAgentActivityProgress({
      stage: 'queued',
      message: '生命周期旁白',
      event_type: eventType,
      event_seq: 9,
    }), false);
  }

  assert.equal(isVisibleAgentActivityProgress({
    stage: 'scanning',
    message: '正在扫描冻结的视频文稿',
    event_type: 'turn.tool.started',
    tool_name: 'video.source_scan',
    call_index: 1,
    event_seq: 10,
  }), false);

  const actualTool = {
    stage: 'synthesizing' as const,
    message: '正在执行研究步骤：综合候选依据并生成回答',
    event_type: 'turn.tool.started',
    tool_name: 'video.answer_synthesize',
    call_index: 2,
    event_seq: 11,
  };
  assert.equal(isVisibleAgentActivityProgress(actualTool), true);
  assert.equal(projectAgentActivity([], actualTool)[0]?.label, '正在组织回答');
});

test('瞬时工具完成后从活动历史移除，慢工具与失败仍保留', () => {
  const started = projectAgentActivity([], {
    stage: 'synthesizing',
    message: '正在组织回答',
    event_type: 'turn.tool.started',
    tool_name: 'video.answer_synthesize',
    call_index: 3,
    event_seq: 20,
  });
  assert.equal(started.length, 1);

  const instant = projectAgentActivity(started, {
    stage: 'synthesizing',
    message: '已完成组织回答',
    event_type: 'turn.tool.completed',
    tool_name: 'video.answer_synthesize',
    call_index: 3,
    event_seq: 21,
    duration_ms: 180,
  });
  assert.deepEqual(instant, []);

  const slow = projectAgentActivity(started, {
    stage: 'synthesizing',
    message: '已完成组织回答',
    event_type: 'turn.tool.completed',
    tool_name: 'video.answer_synthesize',
    call_index: 3,
    event_seq: 22,
    duration_ms: 1_200,
  });
  assert.equal(slow.length, 1);
  assert.equal(slow[0].status, 'completed');
  assert.match(slow[0].detail, /1.2 秒/);

  const failed = projectAgentActivity([], {
    stage: 'scanning',
    message: '读取视频文稿未完成',
    event_type: 'turn.tool.failed',
    tool_name: 'video.source_scan',
    call_index: 4,
    event_seq: 23,
    duration_ms: 50,
  });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed');
});

test('无 event_type 的客户端占位文案不会进入真实活动记录', () => {
  assert.deepEqual(projectAgentActivity([], {
    stage: 'queued',
    message: '研究任务已接收，正在准备资料',
  }), []);
});

test('活动流只保留最近五项并保留失败状态', () => {
  let activities = [] as ReturnType<typeof projectAgentActivity>;
  for (let index = 0; index < 7; index += 1) {
    activities = projectAgentActivity(activities, {
      stage: 'researching',
      message: `批次 ${index + 1}`,
      event_type: index === 6
        ? 'turn.map.batch.failed'
        : 'turn.map.batch.started',
      event_seq: index + 1,
      batch_index: index,
      batch_total: 7,
    });
  }
  assert.equal(activities.length, 5);
  assert.equal(activities[0].id, 'map-batch-2');
  assert.equal(activities.at(-1)?.status, 'failed');
});

test('正文增量与进度共用单调事件序号，重连回放不会重复追加', () => {
  assert.deepEqual(agentEventSequenceDecision(0, 8), {
    accepted: true,
    nextEventSeq: 8,
  });
  assert.deepEqual(agentEventSequenceDecision(8, 8), {
    accepted: false,
    nextEventSeq: 8,
  });
  assert.deepEqual(agentEventSequenceDecision(8, 7), {
    accepted: false,
    nextEventSeq: 8,
  });
  assert.deepEqual(agentEventSequenceDecision(8, 9), {
    accepted: true,
    nextEventSeq: 9,
  });
});
