import type {
  AgentStreamProgress,
  AgentThread,
  LibraryResearchMode,
  ResearchScope,
} from '@/lib/types';

export const DEFAULT_AGENT_RESEARCH_MODE: LibraryResearchMode = 'auto';
export const DEFAULT_AGENT_WEB_SCOPE: ResearchScope = 'video_only';

export function threadHasBackgroundWork(
  thread: AgentThread | null | undefined,
): boolean {
  return Boolean(
    thread?.active_turn
    || thread?.status === 'running'
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
