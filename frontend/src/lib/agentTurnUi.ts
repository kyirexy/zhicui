import type {
  AgentStreamProgress,
  AgentThread,
  LibraryResearchMode,
  ResearchScope,
} from '@/lib/types';

export const DEFAULT_AGENT_RESEARCH_MODE: LibraryResearchMode = 'auto';
export const DEFAULT_AGENT_WEB_SCOPE: ResearchScope = 'auto';
export const DEFAULT_AGENT_ACTIVITY_EXPANDED = false;

export type AgentActivityDisclosureEvent = 'toggle' | 'answer-started' | 'turn-restored';

export function nextAgentActivityExpanded(
  current: boolean,
  event: AgentActivityDisclosureEvent,
): boolean {
  if (event === 'toggle') return !current;
  return false;
}

export type AgentActivityStatus = 'running' | 'completed' | 'failed';

export interface AgentActivityItem {
  id: string;
  label: string;
  detail: string;
  status: AgentActivityStatus;
  eventSeq: number;
  durationMs?: number;
}

export function hasVisibleAgentAnswer(content: unknown): boolean {
  return typeof content === 'string' && content.trim().length > 0;
}

export function shouldShowAgentCitationCoverage(
  evidenceCount: number,
  coverage?: { requested: number; verified: number } | null,
): boolean {
  return Boolean(
    evidenceCount > 0
    && coverage
    && coverage.requested > 0
    && coverage.verified > 0,
  );
}

export function agentTurnTerminalMessage(options: {
  status: string;
  errorMessage?: string | null;
}): string {
  if (options.status === 'cancelled') {
    return '已停止生成，已经完成的内容仍然保留。';
  }
  const message = String(options.errorMessage || '').trim();
  if (!message) return '已保留本轮资料范围，可以重新尝试。';
  if (
    message.length > 180
    || /sqlalchemy|integrityerror|constraint failed|sql:|transaction has been rolled back|traceback/i.test(message)
  ) {
    return '研究状态同步时遇到冲突，请重新尝试。';
  }
  return message;
}

export function agentEventSequenceDecision(
  lastEventSeq: number,
  eventSeq?: number,
): { accepted: boolean; nextEventSeq: number } {
  if (typeof eventSeq !== 'number' || eventSeq <= 0) {
    return { accepted: true, nextEventSeq: lastEventSeq };
  }
  if (eventSeq <= lastEventSeq) {
    return { accepted: false, nextEventSeq: lastEventSeq };
  }
  return { accepted: true, nextEventSeq: eventSeq };
}

const STAGE_LABELS: Partial<Record<AgentStreamProgress['stage'], string>> = {
  queued: '研究任务已排队',
  reading: '读取视频资料',
  planning: '规划研究路径',
  scanning: '扫描视频文稿',
  ranking: '筛选相关片段',
  researching: '核对多视频观点',
  web: '检查外部查证需求',
  synthesizing: '组织最终回答',
  verifying: '校验观点与引用',
  finalizing: '保存回答结果',
  completed: '回答已完成',
};

const TOOL_LABELS: Record<string, string> = {
  'video.source_scan': '读取视频文稿',
  'video.transcript_map': '核对跨视频观点',
  'web.public_research': '查证外部信息',
  'video.answer_synthesize': '组织回答',
  'video.claim_validate': '校验引用',
  'video.claim_repair': '修正引用',
};

const VISIBLE_TURN_EVENTS = new Set([
  'turn.retried',
  'turn.v1_fallback_started',
  'turn.cancel_requested',
  'turn.cancelled',
  'turn.failed',
  'turn.completed',
]);

const QUIET_LOCAL_TOOLS = new Set([
  'video.source_scan',
  'video.claim_validate',
]);

const MIN_VISIBLE_TOOL_DURATION_MS = 600;

/**
 * 活动区只展示服务端已经持久化的真实动作。`turn.progress` 是流水线
 * 的阶段性旁白，不能再被投影成一套看似执行过的固定研究步骤。
 */
export function isVisibleAgentActivityProgress(
  progress: AgentStreamProgress,
): boolean {
  const eventType = progress.event_type || '';
  if (
    QUIET_LOCAL_TOOLS.has(progress.tool_name || '')
    && (
      eventType === 'turn.tool.started'
      || eventType === 'turn.tool.completed'
    )
  ) return false;
  return VISIBLE_TURN_EVENTS.has(eventType)
    || eventType.startsWith('turn.tool.')
    || eventType.startsWith('turn.map.batch.');
}

export function agentActivityLabel(progress: AgentStreamProgress): string {
  const eventType = progress.event_type || '';
  const toolLabel = progress.tool_name
    ? TOOL_LABELS[progress.tool_name]
    : '';
  if (toolLabel && eventType.startsWith('turn.tool.')) {
    if (eventType.endsWith('.completed')) return `已完成${toolLabel}`;
    if (eventType.endsWith('.failed')) return `${toolLabel}未完成`;
    return `正在${toolLabel}`;
  }
  return progress.message || STAGE_LABELS[progress.stage] || '正在研究';
}

function activityIdentity(progress: AgentStreamProgress): string {
  const eventType = progress.event_type || '';
  if (eventType.startsWith('turn.map.batch.')) {
    return `map-batch-${progress.batch_index ?? progress.event_seq ?? 0}`;
  }
  if (eventType.startsWith('turn.tool.')) {
    return `tool-${progress.call_index ?? progress.tool_name ?? progress.event_seq ?? 0}`;
  }
  if (eventType.startsWith('turn.answer.')) return 'answer-stream';
  return `stage-${progress.stage}`;
}

function activityStatus(progress: AgentStreamProgress): AgentActivityStatus {
  const eventType = progress.event_type || '';
  if (
    eventType.endsWith('.failed')
    || eventType.endsWith('.result_rejected')
    || eventType.endsWith('.budget_exceeded')
  ) return 'failed';
  if (
    eventType.endsWith('.completed')
    || progress.stage === 'completed'
  ) return 'completed';
  return 'running';
}

function activityDetail(progress: AgentStreamProgress): string {
  const detail = researchProgressDetail(progress);
  const batch = typeof progress.batch_index === 'number'
    && typeof progress.batch_total === 'number'
    ? `批次 ${progress.batch_index + 1}/${progress.batch_total}`
    : '';
  const duration = typeof progress.duration_ms === 'number'
    ? `${(progress.duration_ms / 1000).toFixed(progress.duration_ms >= 10_000 ? 0 : 1)} 秒`
    : '';
  return [batch, detail, duration].filter(Boolean).join(' · ');
}

export function projectAgentActivity(
  current: AgentActivityItem[],
  progress: AgentStreamProgress,
  limit = 5,
): AgentActivityItem[] {
  if (!isVisibleAgentActivityProgress(progress)) return current;
  const eventSeq = progress.event_seq ?? 0;
  const id = activityIdentity(progress);
  const status = activityStatus(progress);
  const nextItem: AgentActivityItem = {
    id,
    label: agentActivityLabel(progress),
    detail: activityDetail(progress),
    status,
    eventSeq,
    durationMs: progress.duration_ms,
  };
  const existing = current.find((item) => item.id === id);
  if (existing && eventSeq > 0 && existing.eventSeq >= eventSeq) return current;
  if (
    progress.event_type === 'turn.tool.completed'
    && typeof progress.duration_ms === 'number'
    && progress.duration_ms < MIN_VISIBLE_TOOL_DURATION_MS
  ) {
    return current.filter((item) => item.id !== id);
  }

  const next = current.map((item) => {
    if (item.id === id) return nextItem;
    const stageChanged = id.startsWith('stage-')
      && item.id.startsWith('stage-')
      && item.status === 'running';
    return stageChanged ? { ...item, status: 'completed' as const } : item;
  });
  if (!existing) next.push(nextItem);
  return next.slice(-Math.max(1, limit));
}

export function threadHasBackgroundWork(
  thread: AgentThread | null | undefined,
): boolean {
  return Boolean(
    thread?.active_turn
    || thread?.status === 'running_analysis',
  );
}

export function shouldResumeAgentTurn(options: {
  active: boolean;
  sending: boolean;
  thread: AgentThread | null | undefined;
}): boolean {
  return Boolean(
    options.active
    && !options.sending
    && options.thread?.id
    && options.thread.active_turn?.id,
  );
}

export function researchProgressDetail(
  progress: AgentStreamProgress | null,
): string {
  if (!progress) return '';
  const parts: string[] = [];
  if (typeof progress.scanned_count === 'number') {
    parts.push(
      typeof progress.source_total_count === 'number'
        ? `扫描 ${progress.scanned_count}/${progress.source_total_count}`
        : `扫描 ${progress.scanned_count}`,
    );
  }
  if (typeof progress.mapped_count === 'number') parts.push(`映射 ${progress.mapped_count}`);
  if (typeof progress.deep_read_count === 'number') parts.push(`深读 ${progress.deep_read_count}`);
  if (typeof progress.claim_count === 'number') parts.push(`观点 ${progress.claim_count}`);
  return parts.join(' · ');
}
