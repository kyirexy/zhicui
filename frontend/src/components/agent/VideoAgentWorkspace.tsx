'use client';

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ArrowsOut,
  ArrowClockwise,
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChatsCircle,
  CheckCircle,
  ClipboardText,
  Clock,
  ClockCounterClockwise,
  EnvelopeSimple,
  FileText,
  FolderOpen,
  ListChecks,
  MagnifyingGlass,
  Notebook,
  PencilSimple,
  Play,
  Plus,
  Scales,
  SelectionAll,
  Sparkle,
  SquaresFour,
  Trash,
  VideoCamera,
  X,
} from '@phosphor-icons/react';
import AgentMark from '@/components/agent/AgentMark';
import AgentComposer from '@/components/agent/AgentComposer';
import type { AgentComposerHandle } from '@/components/agent/AgentComposer';
import AgentMessageView from '@/components/agent/AgentMessageView';
import AgentSourceSyncSheet from '@/components/agent/AgentSourceSyncSheet';
import VideoAnalysisBatchAction from '@/components/VideoAnalysisBatchAction';
import type { AgentMessageDeliveryState } from '@/components/agent/AgentMessageView';
import type { AgentVideoAnalysisDecision } from '@/components/agent/AgentVideoAnalysisCard';
import MarqueeSelectionOverlay from '@/components/MarqueeSelectionOverlay';
import NativeModal from '@/components/NativeModal';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import { MessageResponse } from '@/components/ai-elements/message';
import styles from '@/components/agent/AgentWorkspace.module.css';
import {
  deriveAgentStudioResults,
  studioResultTypeLabel,
  type AgentStudioResult,
} from '@/lib/agentStudio';
import {
  DEFAULT_AGENT_RESEARCH_MODE,
  DEFAULT_AGENT_WEB_SCOPE,
  researchProgressDetail,
  shouldResumeAgentTurn,
  threadHasBackgroundWork,
} from '@/lib/agentTurnUi';
import {
  createAgentAutomation,
  createAgentThread,
  cancelAgentTurn,
  deleteAgentSources,
  decideAgentVideoAnalysis,
  confirmAgentEmailVerification,
  deleteAgentAutomation,
  deleteAgentThread,
  getAgentThread,
  getAgentTurn,
  getAgentEmailStatus,
  getUserAIProvider,
  getUserChatModels,
  listAgentAutomationRuns,
  listAgentAutomations,
  listAgentSources,
  listAgentThreads,
  resetUserAIProvider,
  retryAgentTurn,
  resumeAgentTurnStream,
  runAgentAutomation,
  saveUserAIProvider,
  searchAgentSources,
  selectUserChatModel,
  selectUserCustomChatModel,
  sendAgentEmailVerification,
  streamAgentMessage,
  testUserAIProvider,
  updateAgentAutomation,
  type UserAIProviderConfig,
  type UserChatModelCatalog,
} from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { useMarqueeSelection } from '@/lib/hooks/useMarqueeSelection';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import type {
  AgentAutomation,
  AgentAutomationCreate,
  AgentAutomationRun,
  AgentAutomationSourceScope,
  AgentEmailStatus,
  AgentMessage,
  AgentSource,
  AgentSourceMode,
  AgentSourceScope,
  AgentStreamProgress,
  AgentThread,
  AgentTurn,
  LibraryOutputStyle,
  LibraryResearchMode,
  ResearchScope,
  VideoAnalysisItem,
  VideoAnalysisRun,
  VideoAnalysisRunResult,
} from '@/lib/types';

const MAX_SELECTED_SOURCES = 100;
type BrowseSourceScope = Exclude<AgentSourceScope, 'selected'>;
type AgentSourcePlatform = 'all' | 'douyin' | 'bilibili' | 'xiaohongshu';

const SOURCE_PLATFORMS: Array<{ value: AgentSourcePlatform; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'douyin', label: '抖音' },
  { value: 'bilibili', label: 'B站' },
];

function SourcePlatformIcon({ platform }: { platform: AgentSourcePlatform }) {
  if (platform === 'all') return <SquaresFour size={20} weight="fill" aria-hidden="true" />;
  return (
    <PlatformBrandIcon
      platform={platform}
      size={20}
    />
  );
}

function agentSourcePlatform(source: AgentSource): Exclude<AgentSourcePlatform, 'all'> | 'unknown' {
  const explicit = String(source.platform || '').toLowerCase();
  if (explicit === 'douyin' || explicit === 'bilibili' || explicit === 'xiaohongshu') {
    return explicit;
  }
  const url = String(source.source_url || '').toLowerCase();
  if (url.includes('bilibili.com') || url.includes('b23.tv')) return 'bilibili';
  if (url.includes('xiaohongshu.com') || url.includes('xhslink.com')) return 'xiaohongshu';
  if (url.includes('douyin.com') || url.includes('iesdouyin.com')) return 'douyin';
  return 'unknown';
}
type DraftSourceMode = 'scope' | 'selected';

function isBrowseSourceScope(value: string | null): value is BrowseSourceScope {
  return SOURCE_SCOPES.some((scope) => scope.value === value);
}

function normalizeSourceIds(values: readonly string[] | undefined): string[] {
  return Array.from(new Set(
    (values || [])
      .map((value) => String(value).trim())
      .filter(Boolean),
  )).slice(0, MAX_SELECTED_SOURCES);
}

function threadContainsAllSources(thread: AgentThread, requiredSourceIds: readonly string[]): boolean {
  if (requiredSourceIds.length === 0) return true;
  const threadSourceIds = new Set([
    ...(thread.source_ids || []).map((value) => String(value).trim()),
    ...(thread.sources || []).map((source) => String(source.note_id).trim()),
  ].filter(Boolean));
  return requiredSourceIds.every((sourceId) => threadSourceIds.has(sourceId));
}

function useEventCallback<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}

const SOURCE_MATCH_LABELS = {
  title: '标题',
  author: '作者',
  summary: '摘要',
  transcript: '文稿',
} as const;

const SOURCE_SCOPES: Array<{
  value: BrowseSourceScope;
  label: string;
  description: string;
}> = [
  {
    value: 'all_ready',
    label: '全部',
    description: '所有已有完整文案的视频',
  },
  {
    value: 'yesterday_new',
    label: '昨日新增',
    description: '昨天首次整理进知萃的内容',
  },
  {
    value: 'collect',
    label: '收藏',
    description: '参考已同步的收藏视频',
  },
  {
    value: 'like',
    label: '喜欢',
    description: '参考已同步的喜欢视频',
  },
  {
    value: 'post',
    label: '我的作品',
    description: '参考已同步的个人作品',
  },
];

const STARTERS = [
  '这些视频反复出现的核心观点是什么？',
  '把能立刻执行的建议整理成清单',
  '找出互相矛盾的观点，并说明各自依据',
];

const OUTPUT_LABELS: Record<LibraryOutputStyle, string> = {
  answer: '直接回答',
  summary: '完整总结',
  comparison: '差异对比',
  action_plan: '行动方案',
  custom: '自定义',
};

const STUDIO_SHORTCUTS: Array<{
  value: Exclude<LibraryOutputStyle, 'answer' | 'custom'>;
  label: string;
  description: string;
  prompt: string;
  Icon: typeof Notebook;
}> = [
  {
    value: 'summary',
    label: '完整总结',
    description: '把核心观点和依据收拢成一份可复用笔记',
    prompt: '请把当前视频资料整理成一份结构清晰的完整总结，保留关键结论及其视频依据。',
    Icon: Notebook,
  },
  {
    value: 'comparison',
    label: '观点对比',
    description: '并排呈现共识、分歧与各自依据',
    prompt: '请对比当前视频中的主要观点，分别列出共识、分歧和各自依据。',
    Icon: Scales,
  },
  {
    value: 'action_plan',
    label: '行动方案',
    description: '把可执行的方法排成有先后的步骤',
    prompt: '请把当前视频中可执行的方法整理成有先后顺序的行动方案，并标注依据不足或需要验证的部分。',
    Icon: ListChecks,
  },
];

interface SubmitQuestionOptions {
  outputStyle?: LibraryOutputStyle;
  customInstruction?: string;
  revealStudioOnComplete?: boolean;
}

const AUTOMATION_SOURCE_MODES: Array<{
  value: AgentSourceMode;
  label: string;
}> = [
  { value: 'collect', label: '收藏' },
  { value: 'like', label: '喜欢' },
  { value: 'post', label: '我的作品' },
  { value: 'all', label: '全部来源' },
];

interface AutomationDraft {
  name: string;
  schedule_time: string;
  source_scope: AgentAutomationSourceScope;
  source_mode: AgentSourceMode;
  instruction: string;
  recipient_email: string;
}

function sourceScopeLabel(
  scope: AgentSourceScope | AgentAutomationSourceScope,
): string {
  if (scope === 'yesterday') return '昨天新整理进知萃';
  if (scope === 'selected') return '手选视频';
  return SOURCE_SCOPES.find((item) => item.value === scope)?.label || '视频资料';
}

function automationSourceModeLabel(mode: AgentSourceMode): string {
  return AUTOMATION_SOURCE_MODES.find((item) => item.value === mode)?.label || '收藏';
}

function defaultAutomationInstruction(mode: AgentSourceMode): string {
  const sourceLabel = mode === 'all'
    ? '全部来源视频'
    : `${automationSourceModeLabel(mode)}视频`;
  return `总结昨天新整理进知萃的${sourceLabel}，列出核心观点、值得行动的事项和需要进一步核实的信息。`;
}

function formatCompactTime(value?: string | null): string {
  if (!value) return '尚未运行';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function threadPreview(thread: AgentThread): string {
  if (thread.last_message?.trim()) return thread.last_message.trim();
  if (thread.message_count > 0) return `${thread.message_count} 条对话消息`;
  return `${thread.source_count} 条视频资料`;
}

function automationRunStatus(run: AgentAutomationRun): string {
  if (run.status === 'running') return '正在生成';
  if (run.status === 'completed') return '生成完成';
  if (run.status === 'cancelled') return '任务已取消';
  return '生成失败';
}

function automationDeliveryStatus(run: AgentAutomationRun): string {
  if (run.delivery_status === 'sent') return '已提交到邮箱';
  if (run.delivery_status === 'delivering') return '正在提交邮箱';
  if (run.delivery_status === 'failed') return '提交失败，摘要已保存';
  if (run.delivery_status === 'verification_required') return '待验证，摘要已保存';
  if (run.delivery_status === 'not_configured') return '邮件未开放，摘要已保存';
  if (run.delivery_status === 'unknown') return '可能已提交，不会自动重发';
  if (run.trigger === 'scheduled' && run.source_count === 0) return '昨日没有新增内容';
  return '仅保存站内';
}

function createOptimisticMessage(
  threadId: string,
  content: string,
): AgentMessage {
  return {
    id: `optimistic-${Date.now()}`,
    thread_id: threadId,
    role: 'user',
    content,
    created_at: new Date().toISOString(),
  };
}

function createStreamingAssistantMessage(threadId: string): AgentMessage {
  return {
    id: `streaming-${Date.now()}`,
    thread_id: threadId,
    role: 'assistant',
    content: '',
    created_at: new Date().toISOString(),
  };
}

function threadBlocksNewQuestion(thread: AgentThread | null | undefined): boolean {
  return threadHasBackgroundWork(thread) || thread?.status === 'awaiting_approval';
}

function agentVideoAnalysisRunId(message: AgentMessage): string {
  const payload = message.result?.video_analysis;
  if (!payload || typeof payload !== 'object' || !('run' in payload)) return '';
  const run = payload.run;
  return run && typeof run === 'object' && 'id' in run && typeof run.id === 'string'
    ? run.id
    : '';
}

function agentVideoAnalysisRunResult(value: unknown): VideoAnalysisRunResult | null {
  if (!value || typeof value !== 'object' || !('run' in value)) return null;
  const rawRun = (value as { run?: unknown }).run;
  if (
    !rawRun
    || typeof rawRun !== 'object'
    || !('id' in rawRun)
    || !('status' in rawRun)
    || typeof rawRun.id !== 'string'
    || typeof rawRun.status !== 'string'
  ) return null;
  const rawItems = (value as { items?: unknown }).items;
  const items = Array.isArray(rawItems) ? rawItems as VideoAnalysisItem[] : [];
  return {
    run: { ...(rawRun as VideoAnalysisRun), items },
    items,
  };
}

function threadConversationMessages(thread: AgentThread): AgentMessage[] {
  const threadMessages = thread.messages || [];
  if (threadHasBackgroundWork(thread) || thread.status === 'awaiting_approval') {
    return threadMessages;
  }
  const completedTurnIds = new Set(
    threadMessages
      .filter((message) => message.role === 'assistant' && message.turn_id)
      .map((message) => message.turn_id as string),
  );
  const orphanedUsers = threadMessages.filter(
    (message) => (
      message.role === 'user'
      && Boolean(message.turn_id)
      && !completedTurnIds.has(message.turn_id as string)
    ),
  );
  const latestOrphanId = orphanedUsers.at(-1)?.id;
  return threadMessages.filter((message) => (
    !orphanedUsers.some((orphan) => orphan.id === message.id)
    || message.id === latestOrphanId
  ));
}

function restoredDeliveryStates(
  thread: AgentThread,
): Record<string, AgentMessageDeliveryState> {
  if (threadHasBackgroundWork(thread) || thread.status === 'awaiting_approval') return {};
  const visibleMessages = threadConversationMessages(thread);
  const completedTurnIds = new Set(
    visibleMessages
      .filter((message) => message.role === 'assistant' && message.turn_id)
      .map((message) => message.turn_id as string),
  );
  const failedUser = [...visibleMessages].reverse().find((message) => (
    message.role === 'user'
    && Boolean(message.turn_id)
    && !completedTurnIds.has(message.turn_id as string)
  ));
  return failedUser ? { [failedUser.id]: 'failed' } : {};
}

function restoredDeliveryErrors(thread: AgentThread): Record<string, string> {
  const [failedMessageId] = Object.keys(restoredDeliveryStates(thread));
  return failedMessageId
    ? { [failedMessageId]: '此前回答没有完成，可以直接重新生成' }
    : {};
}

interface AgentSourceOptionProps {
  source: AgentSource;
  selected: boolean;
  onToggle: (noteId: string) => void;
  disabled?: boolean;
}

function AgentSourceOption({ source, selected, onToggle, disabled = false }: AgentSourceOptionProps) {
  return (
    <label
      className={`video-agent-source-item ${selected ? 'is-selected' : ''}`}
      data-marquee-id={source.note_id}
    >
      <input type="checkbox" checked={selected} disabled={disabled} onChange={() => onToggle(source.note_id)} aria-label={`${selected ? '取消选择' : '选择'}${source.title}`} />
      <span className="video-agent-source-cover">
        <VideoCamera size={17} aria-hidden="true" />
        {source.cover_url && <img src={source.cover_url} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
      </span>
      <span className="video-agent-source-copy">
        <strong>{source.title}</strong>
        <small>
          {source.author_name || '抖音视频'}
          {' · '}
          {source.transcript_chars.toLocaleString('zh-CN')} 字
        </small>
        {source.visual_analysis && (
          <small className="video-agent-source-visual-status">
            <Sparkle size={11} weight="fill" aria-hidden="true" />
            已解析画面
            {source.visual_analysis.scene_count ? ` · ${source.visual_analysis.scene_count} 个场景` : ''}
          </small>
        )}
        {source.match?.snippet && (
          <small className="video-agent-source-match">
            <b>
              命中{source.match.fields.map(
                (field) => SOURCE_MATCH_LABELS[field],
              ).join('、')}
            </b>
            {source.match.snippet}
          </small>
        )}
      </span>
    </label>
  );
}

export interface VideoAgentWorkspaceProps {
  /**
   * 以指定来源初始化新会话。仅在工作区挂载时读取一次；切换详情时请用新 key 重挂载。
   */
  initialSourceIds?: string[];
  /** 恢复指定的持久化会话，而不是创建草稿。 */
  initialThreadId?: string | null;
  /** 嵌入其他工作区渲染，不触发全页壳层规则。 */
  embedded?: boolean;
  /** 当前工作区是否可见；重新显示时恢复此前的跟随滚动状态。 */
  active?: boolean;
  /** 回报持久化会话变化，包括回到草稿时清空会话。 */
  onThreadChange?: (threadId: string | null) => void;
}

export default function VideoAgentWorkspace({
  initialSourceIds,
  initialThreadId = null,
  embedded = false,
  active = true,
  onThreadChange,
}: VideoAgentWorkspaceProps) {
  const { user } = useAuth();
  const { settings } = useSettings();
  const { trackRun: trackVideoAnalysisRun } = useVideoAnalysis();
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [messageDeliveryStates, setMessageDeliveryStates] = useState<
    Record<string, AgentMessageDeliveryState>
  >({});
  const [messageDeliveryErrors, setMessageDeliveryErrors] = useState<
    Record<string, string>
  >({});
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [streamProgress, setStreamProgress] = useState<AgentStreamProgress | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [isCompact, setIsCompact] = useState(embedded);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourceSyncOpen, setSourceSyncOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [studioOpen, setStudioOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);

  const [browseScope, setBrowseScope] = useState<BrowseSourceScope>('all_ready');
  const [sourcePlatform, setSourcePlatform] = useState<AgentSourcePlatform>('all');
  const [draftSourceMode, setDraftSourceMode] = useState<DraftSourceMode>('scope');
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [scopeReadyCount, setScopeReadyCount] = useState(0);
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceAppliedQuery, setSourceAppliedQuery] = useState('');
  const [sourceSearchMode, setSourceSearchMode] = useState<
    'browse' | 'smart' | 'keyword_fallback'
  >('browse');
  const [sourceExpandedQueries, setSourceExpandedQueries] = useState<string[]>([]);
  const [sourceScannedCount, setSourceScannedCount] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [sourceRegistry, setSourceRegistry] = useState<Record<string, AgentSource>>({});

  const [aiProviderConfig, setAiProviderConfig] = useState<
    UserAIProviderConfig | null
  >(null);
  const [chatModelCatalog, setChatModelCatalog] = useState<UserChatModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelConfigSaving, setModelConfigSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const [researchMode, setResearchMode] = useState<LibraryResearchMode>(DEFAULT_AGENT_RESEARCH_MODE);
  const [outputStyle, setOutputStyle] = useState<LibraryOutputStyle>('answer');
  const [webScope, setWebScope] = useState<ResearchScope>(DEFAULT_AGENT_WEB_SCOPE);
  const [customInstruction, setCustomInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [studioGeneratingType, setStudioGeneratingType] = useState<
    LibraryOutputStyle | null
  >(null);
  const [selectedStudioResultId, setSelectedStudioResultId] = useState<
    string | null
  >(null);
  const [studioCustomOpen, setStudioCustomOpen] = useState(false);
  const [backgroundThreadId, setBackgroundThreadId] = useState<string | null>(null);
  const [terminalTurn, setTerminalTurn] = useState<AgentTurn | null>(null);
  const [turnAction, setTurnAction] = useState<'cancel' | 'retry' | ''>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingThreadDelete, setPendingThreadDelete] = useState<string | null>(null);
  const [destructivePending, setDestructivePending] = useState(false);
  const [pendingBatchDeleteIds, setPendingBatchDeleteIds] = useState<string[] | null>(null);
  const [deletingBatch, setDeletingBatch] = useState(false);
  const [removeSelectionMode, setRemoveSelectionMode] = useState(false);
  const [analysisDecisionMessageId, setAnalysisDecisionMessageId] = useState<string | null>(null);

  useEffect(() => {
    if (!error && !notice) return;
    const timeout = window.setTimeout(() => {
      setError('');
      setNotice('');
    }, error ? 5000 : 3200);
    return () => window.clearTimeout(timeout);
  }, [error, notice]);

  const [automations, setAutomations] = useState<AgentAutomation[]>([]);
  const [automationRuns, setAutomationRuns] = useState<
    Record<string, AgentAutomationRun | undefined>
  >({});
  const [automationsLoading, setAutomationsLoading] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [automationError, setAutomationError] = useState('');
  const [editingAutomationId, setEditingAutomationId] = useState<string | null>(null);
  const [runningAutomationId, setRunningAutomationId] = useState<string | null>(null);
  const [pendingAutomationDelete, setPendingAutomationDelete] = useState<string | null>(null);
  const [emailStatus, setEmailStatus] = useState<AgentEmailStatus | null>(null);
  const [emailStatusLoading, setEmailStatusLoading] = useState(false);
  const [emailVerificationSending, setEmailVerificationSending] = useState(false);
  const [emailVerificationFeedback, setEmailVerificationFeedback] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  const [automationDraft, setAutomationDraft] = useState<AutomationDraft>({
    name: '每日收藏摘要',
    schedule_time: '09:00',
    source_scope: 'yesterday_new',
    source_mode: 'collect',
    instruction: defaultAutomationInstruction('collect'),
    recipient_email: '',
  });

  const abortRef = useRef<AbortController | null>(null);
  const resumeAbortRef = useRef<AbortController | null>(null);
  const durableTurnIdRef = useRef<string | null>(null);
  const sourceRequestRef = useRef<AbortController | null>(null);
  const initialSourceIdsRef = useRef(initialSourceIds);
  const initialSourceIdsProvidedRef = useRef(initialSourceIds !== undefined);
  const initialThreadIdRef = useRef(initialThreadId);
  const embeddedInitialSourceIdsRef = useRef<string[] | null>(
    embedded && initialSourceIds !== undefined
      ? normalizeSourceIds(initialSourceIds)
      : null,
  );
  const requestedSourceIdsRef = useRef<string[]>([]);
  const sourceHandoffNoticeSettledRef = useRef(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // DSH follows only while the viewer is pinned to the bottom; scrolling up
  // releases the pin, scrolling back down re-arms it. Content growth itself
  // never toggles the pin.
  const followingRef = useRef(true);
  const followingBeforeInactiveRef = useRef(true);
  const wasActiveRef = useRef(active);
  const questionRef = useRef<AgentComposerHandle | null>(null);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyCloseRef = useRef<HTMLButtonElement | null>(null);
  const historyWasOpenRef = useRef(false);
  const sourcesCloseRef = useRef<HTMLButtonElement | null>(null);
  const lastSourcesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcesWereOpenRef = useRef(false);
  const sourceSelectionSurfaceRef = useRef<HTMLDivElement | null>(null);
  const studioCloseRef = useRef<HTMLButtonElement | null>(null);
  const lastStudioTriggerRef = useRef<HTMLButtonElement | null>(null);
  const studioWasOpenRef = useRef(false);
  const notifiedThreadIdRef = useRef<string | null>(null);

  const notifyThreadChange = useEventCallback((threadId: string | null) => {
    onThreadChange?.(threadId);
  });

  const invalidateThreadPointer = useEventCallback(() => {
    notifiedThreadIdRef.current = null;
    notifyThreadChange(null);
  });

  useEffect(() => {
    const threadId = activeThread?.id ?? null;
    if (notifiedThreadIdRef.current === threadId) return;
    notifiedThreadIdRef.current = threadId;
    notifyThreadChange(threadId);
  }, [activeThread?.id, notifyThreadChange]);

  useEffect(() => {
    const activeTurn = activeThread?.active_turn;
    if (!activeTurn) return;
    durableTurnIdRef.current = activeTurn.id;
    if (['queued', 'running', 'retry_wait'].includes(activeTurn.status)) {
      setTerminalTurn(null);
    }
  }, [activeThread?.active_turn?.id, activeThread?.active_turn?.status]);

  const threadMatchesEmbeddedSources = useCallback((thread: AgentThread) => {
    const requiredSourceIds = embeddedInitialSourceIdsRef.current;
    return requiredSourceIds === null
      || threadContainsAllSources(thread, requiredSourceIds);
  }, []);

  const returnToEmbeddedSourceDraft = useEventCallback((
    message: string,
    tone: 'notice' | 'error',
  ): boolean => {
    const sourceIds = embeddedInitialSourceIdsRef.current;
    if (sourceIds === null) return false;
    requestedSourceIdsRef.current = sourceIds;
    sourceHandoffNoticeSettledRef.current = true;
    setActiveThread(null);
    setMessages([]);
    setMessageDeliveryStates({});
    setMessageDeliveryErrors({});
    setStreamingMessageId(null);
    setStreamProgress(null);
    setBackgroundThreadId(null);
    setDraftSourceMode('selected');
    setSelectedSourceIds(new Set(sourceIds));
    setHistoryOpen(false);
    setSourcesOpen(false);
    setStudioOpen(false);
    setSelectedStudioResultId(null);
    followingRef.current = true;
    if (tone === 'error') {
      setNotice('');
      setError(message);
    } else {
      setError('');
      setNotice(message);
    }
    return true;
  });

  const rememberSources = useCallback((items: AgentSource[] | undefined) => {
    if (!items?.length) return;
    setSourceRegistry((current) => {
      const next = { ...current };
      items.forEach((item) => {
        next[item.note_id] = item;
      });
      return next;
    });
  }, []);

  const restoreThreadSourceSelection = useCallback((thread: AgentThread) => {
    const sourceIds = normalizeSourceIds([
      ...(thread.source_ids || []),
      ...(thread.sources || []).map((source) => source.note_id),
    ]);
    rememberSources(thread.sources);
    setSelectedSourceIds(new Set(sourceIds));
    setDraftSourceMode(sourceIds.length > 0 ? 'selected' : 'scope');
  }, [rememberSources]);

  const loadThreads = useCallback(async (selectFirst = false) => {
    setThreadsLoading(true);
    const response = await listAgentThreads();
    setThreadsLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法读取知萃 Harness 会话');
      return;
    }
    const nextThreads = (response.data.items || []).filter(threadMatchesEmbeddedSources);
    setThreads(nextThreads);
    if (selectFirst && !activeThread && nextThreads[0]) {
      const detailResponse = await getAgentThread(nextThreads[0].id);
      if (detailResponse.success && detailResponse.data) {
        setActiveThread(detailResponse.data);
        setMessages(threadConversationMessages(detailResponse.data));
        setMessageDeliveryStates(restoredDeliveryStates(detailResponse.data));
        setMessageDeliveryErrors(restoredDeliveryErrors(detailResponse.data));
        setStreamingMessageId(null);
        setStreamProgress(null);
        followingRef.current = true;
        restoreThreadSourceSelection(detailResponse.data);
        if (threadHasBackgroundWork(detailResponse.data)) {
          setBackgroundThreadId(detailResponse.data.id);
        }
      }
    }
  }, [activeThread, restoreThreadSourceSelection, threadMatchesEmbeddedSources]);

  const loadSources = useCallback(async (
    scope: BrowseSourceScope,
    includeIds: string[] = [],
  ) => {
    sourceRequestRef.current?.abort();
    const controller = new AbortController();
    sourceRequestRef.current = controller;
    setSourceLoading(true);
    setSourceError('');
    const response = await listAgentSources(
      scope,
      '',
      controller.signal,
      includeIds,
      settings.agentSourceDisplayLimit,
    );
    if (controller.signal.aborted) return;
    setSourceLoading(false);
    sourceRequestRef.current = null;
    if (!response.success || !response.data) {
      setSources([]);
      setSourceCount(0);
      setScopeReadyCount(0);
      setSourceError(response.error || '暂时无法读取可用视频资料');
      return;
    }
    setSources(response.data.items || []);
    setSourceCount(response.data.ready_count ?? response.data.total ?? 0);
    setScopeReadyCount(response.data.ready_count ?? response.data.total ?? 0);
    setSourceAppliedQuery('');
    setSourceSearchMode('browse');
    setSourceExpandedQueries([]);
    setSourceScannedCount(response.data.total ?? 0);
    rememberSources([
      ...(response.data.included_items || []),
      ...(response.data.items || []),
    ]);
  }, [rememberSources, settings.agentSourceDisplayLimit]);

  useEffect(() => {
    const refreshVisualStatuses = () => void loadSources(browseScope);
    window.addEventListener('vc:video-analysis-updated', refreshVisualStatuses);
    return () => window.removeEventListener('vc:video-analysis-updated', refreshVisualStatuses);
  }, [browseScope, loadSources]);

  const loadAutomations = useCallback(async () => {
    setAutomationsLoading(true);
    setAutomationError('');
    const response = await listAgentAutomations();
    setAutomationsLoading(false);
    if (!response.success || !response.data) {
      setAutomationError(response.error || '暂时无法读取定时摘要');
      return;
    }
    const nextAutomations = response.data.items || [];
    setAutomations(nextAutomations);
    const latestRuns = await Promise.all(nextAutomations.map(async (automation) => {
      const runsResponse = await listAgentAutomationRuns(automation.id);
      return [
        automation.id,
        runsResponse.success ? runsResponse.data?.items?.[0] : undefined,
      ] as const;
    }));
    setAutomationRuns(Object.fromEntries(latestRuns));
  }, []);

  const loadEmailStatus = useCallback(async () => {
    setEmailStatusLoading(true);
    const response = await getAgentEmailStatus();
    setEmailStatusLoading(false);
    if (!response.success || !response.data) {
      setEmailVerificationFeedback({
        tone: 'error',
        message: response.error || '暂时无法读取邮箱验证状态',
      });
      return;
    }
    setEmailStatus(response.data);
    setAutomationDraft((current) => ({
      ...current,
      recipient_email: response.data!.account_email,
    }));
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const verificationToken = hashParams.get('verify_email')
      || url.searchParams.get('verify_email');
    if (!verificationToken) return;

    let active = true;
    setNotice('正在确认邮箱，请稍候…');
    void confirmAgentEmailVerification(verificationToken).then((response) => {
      if (!active) return;
      url.searchParams.delete('verify_email');
      hashParams.delete('verify_email');
      url.hash = hashParams.toString() ? `#${hashParams.toString()}` : '';
      window.history.replaceState(
        null,
        '',
        `${url.pathname}${url.search}${url.hash}`,
      );
      if (!response.success || !response.data) {
        setNotice('');
        setError(response.error || '邮箱验证失败，请重新发送验证邮件');
        setEmailVerificationFeedback({
          tone: 'error',
          message: response.error || '邮箱验证失败，请重新发送验证邮件',
        });
        return;
      }
      setError('');
      setNotice(
        response.data.status === 'already_verified'
          ? '邮箱已经验证，可以接收定时摘要。'
          : '邮箱验证成功，之后的定时摘要可提交到这个邮箱。',
      );
      setEmailVerificationFeedback({
        tone: 'success',
        message: '邮箱已验证，之后的定时摘要可提交到这个邮箱。',
      });
      setEmailStatus((current) => (
        current ? { ...current, email_verified: true } : current
      ));
      void loadEmailStatus();
    });

    return () => {
      active = false;
    };
  }, [loadEmailStatus]);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const hasInitialSourceIds = initialSourceIdsProvidedRef.current;
    const explicitThreadId = String(initialThreadIdRef.current || '').trim();
    const useRouteDraft = !hasInitialSourceIds && !explicitThreadId;
    const requestedSourceIds = normalizeSourceIds(
      hasInitialSourceIds
        ? initialSourceIdsRef.current || []
        : (searchParams.get('source_ids') || '').split(','),
    );
    const requestedThreadId = explicitThreadId
      || (useRouteDraft ? String(searchParams.get('thread') || '').trim() : '');
    const requestedScopeParam = useRouteDraft
      ? searchParams.get('source_scope')
      : null;
    const requestedScope = isBrowseSourceScope(requestedScopeParam)
      ? requestedScopeParam
      : null;
    const forceNewThread = useRouteDraft && searchParams.get('new') === '1';
    requestedSourceIdsRef.current = requestedSourceIds;
    sourceHandoffNoticeSettledRef.current = requestedSourceIds.length === 0;

    if (requestedScope) setBrowseScope(requestedScope);

    // 显式会话优先于默认来源。详情页 URL 可能带有无关参数，因此只有调用方未提供
    // 初始化参数时，才读取当前路由里的 Harness 状态。
    if (requestedThreadId) {
      sourceHandoffNoticeSettledRef.current = true;
      void loadThreads(false);
      let active = true;
      setThreadLoading(true);
      void getAgentThread(requestedThreadId).then((response) => {
        if (!active) return;
        setThreadLoading(false);
        if (!response.success || !response.data) {
          const terminal = response.status === 404 || response.status === 410;
          if (terminal) {
            if (!returnToEmbeddedSourceDraft(
              '原会话已失效，已回到当前视频的新会话。',
              'notice',
            )) {
              setError('');
              setNotice('原会话已失效，请新建会话。');
            }
            invalidateThreadPointer();
          } else {
            const recoveryError = `${response.error || '暂时无法恢复原会话'}；恢复指针已保留，可先基于当前视频提问。`;
            if (!returnToEmbeddedSourceDraft(recoveryError, 'error')) {
              setNotice('');
              setError(recoveryError);
            }
          }
          return;
        }
        if (!threadMatchesEmbeddedSources(response.data)) {
          returnToEmbeddedSourceDraft(
            '原会话不属于当前视频，已回到当前视频的新会话。',
            'notice',
          );
          invalidateThreadPointer();
          return;
        }
        requestedSourceIdsRef.current = [];
        sourceHandoffNoticeSettledRef.current = true;
        setActiveThread(response.data);
        setMessages(threadConversationMessages(response.data));
        setMessageDeliveryStates(restoredDeliveryStates(response.data));
        setMessageDeliveryErrors(restoredDeliveryErrors(response.data));
        setStreamingMessageId(null);
        setStreamProgress(null);
        restoreThreadSourceSelection(response.data);
        if (threadHasBackgroundWork(response.data)) {
          setBackgroundThreadId(response.data.id);
        }
      });
      return () => {
        active = false;
      };
    }

    if (hasInitialSourceIds || requestedSourceIds.length > 0) {
      void loadThreads(false);
      setActiveThread(null);
      setMessages([]);
      setMessageDeliveryStates({});
      setMessageDeliveryErrors({});
      setStreamingMessageId(null);
      setStreamProgress(null);
      setDraftSourceMode('selected');
      setSelectedSourceIds(new Set(requestedSourceIds));
      setNotice(requestedSourceIds.length > 0
        ? `已带入 ${requestedSourceIds.length} 条视频，正在核对资料状态。`
        : '当前没有可用的视频资料，请重新选择。');
      return;
    }

    if (forceNewThread || requestedScope) {
      void loadThreads(false);
      setActiveThread(null);
      setMessages([]);
      setMessageDeliveryStates({});
      setMessageDeliveryErrors({});
      setStreamingMessageId(null);
      setStreamProgress(null);
      setDraftSourceMode('scope');
      setSelectedSourceIds(new Set());
      setNotice(`已开启新会话，将整体参考${sourceScopeLabel(requestedScope || 'all_ready')}。`);
      window.requestAnimationFrame(() => questionRef.current?.focus());
      return;
    }

    void loadThreads(true);
    return;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadSources(browseScope, requestedSourceIdsRef.current);
  }, [browseScope, loadSources]);

  useEffect(() => {
    const requestedSourceIds = requestedSourceIdsRef.current;
    if (
      sourceHandoffNoticeSettledRef.current
      || sourceLoading
      || requestedSourceIds.length === 0
    ) return;

    sourceHandoffNoticeSettledRef.current = true;
    const resolvedCount = requestedSourceIds.filter(
      (noteId) => Boolean(sourceRegistry[noteId]),
    ).length;
    setNotice(resolvedCount === requestedSourceIds.length
      ? `已带入 ${resolvedCount} 条视频，可以直接开始提问。`
      : `已带入 ${requestedSourceIds.length} 条视频，其中 ${requestedSourceIds.length - resolvedCount} 条暂时不可用。`);
  }, [sourceLoading, sourceRegistry]);

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    setModelCatalogLoading(true);
    setModelError('');
    void Promise.all([
      getUserAIProvider(),
      getUserChatModels(),
    ]).then(([providerResponse, catalogResponse]) => {
      if (!active) return;
      if (providerResponse.success && providerResponse.data) {
        setAiProviderConfig(providerResponse.data);
      }
      if (catalogResponse.success && catalogResponse.data) {
        setChatModelCatalog(catalogResponse.data);
      }
      if (!providerResponse.success) {
        setModelError(providerResponse.error || '暂时无法读取当前模型');
      } else if (!catalogResponse.success) {
        setModelError(catalogResponse.error || '模型目录暂时无法读取');
      }
    }).finally(() => {
      if (active) setModelCatalogLoading(false);
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  useEffect(() => {
    if (embedded) {
      setIsCompact(true);
      return;
    }
    const media = window.matchMedia('(max-width: 1279px)');
    const updateViewport = () => setIsCompact(media.matches);
    updateViewport();
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  }, [embedded]);

  useEffect(() => {
    if (historyOpen) {
      historyWasOpenRef.current = true;
      window.requestAnimationFrame(() => historyCloseRef.current?.focus());
      return;
    }
    if (historyWasOpenRef.current) {
      historyWasOpenRef.current = false;
      window.requestAnimationFrame(() => historyTriggerRef.current?.focus());
    }
  }, [historyOpen]);

  useEffect(() => {
    if (!isCompact) {
      sourcesWereOpenRef.current = false;
      return;
    }
    if (sourcesOpen) {
      sourcesWereOpenRef.current = true;
      window.requestAnimationFrame(() => sourcesCloseRef.current?.focus());
      return;
    }
    if (sourcesWereOpenRef.current) {
      sourcesWereOpenRef.current = false;
      window.requestAnimationFrame(() => lastSourcesTriggerRef.current?.focus());
    }
  }, [isCompact, sourcesOpen]);

  useEffect(() => {
    if (!isCompact) {
      studioWasOpenRef.current = false;
      return;
    }
    if (studioOpen) {
      studioWasOpenRef.current = true;
      window.requestAnimationFrame(() => studioCloseRef.current?.focus());
      return;
    }
    if (studioWasOpenRef.current) {
      studioWasOpenRef.current = false;
      window.requestAnimationFrame(() => lastStudioTriggerRef.current?.focus());
    }
  }, [isCompact, studioOpen]);

  useEffect(() => {
    if (!historyOpen && !sourcesOpen && !studioOpen && !automationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setHistoryOpen(false);
      setSourcesOpen(false);
      setStudioOpen(false);
      setAutomationOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [automationOpen, historyOpen, sourcesOpen, studioOpen]);

  useEffect(() => {
    if (!isCompact || (!sourcesOpen && !studioOpen)) return;
    const panel = document.getElementById(
      sourcesOpen ? 'video-agent-sources-panel' : 'video-agent-studio-panel',
    );
    if (!panel) return;

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', trapFocus);
    return () => window.removeEventListener('keydown', trapFocus);
  }, [isCompact, sourcesOpen, studioOpen]);

  useEffect(() => {
    if (user?.email && !automationDraft.recipient_email) {
      setAutomationDraft((current) => ({
        ...current,
        recipient_email: user.email,
      }));
    }
  }, [automationDraft.recipient_email, user?.email]);

  useEffect(() => {
    if (!automationOpen) return;
    void loadAutomations();
    void loadEmailStatus();
  }, [automationOpen, loadAutomations, loadEmailStatus]);

  useEffect(() => {
    const wasActive = wasActiveRef.current;
    if (wasActive && !active) {
      followingBeforeInactiveRef.current = followingRef.current;
    }
    const shouldRestoreFollowing = !wasActive
      && active
      && followingBeforeInactiveRef.current;
    wasActiveRef.current = active;
    if (!shouldRestoreFollowing) return;

    followingRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const scroller = threadScrollRef.current;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!activeRef.current || !followingRef.current) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messageEndRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [messages.length, sending]);

  // Back-to-bottom visibility — mirrors the DSH harness toBottomSlot button.
  // The scroll listener only reads scroll geometry; it never mutates the DOM.
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  useEffect(() => {
    if (!active) return;
    const el = threadScrollRef.current;
    if (!el) return;
    const update = () => {
      if (!activeRef.current) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      // DSH-style pin: once a user scrolls away from the bottom, stop chasing
      // it until they return; the button mirrors that state.
      followingRef.current = distance <= 2;
      setShowBackToBottom(distance > 56);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [active, threadLoading]);

  const scrollThreadToBottom = useCallback(() => {
    followingRef.current = true;
    setShowBackToBottom(false);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    threadScrollRef.current?.scrollTo({
      top: threadScrollRef.current.scrollHeight,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    resumeAbortRef.current?.abort();
    sourceRequestRef.current?.abort();
  }, []);

  const activeScope = activeThread?.source_scope
    || (draftSourceMode === 'scope' ? browseScope : 'selected');
  const activeSourceCount = activeThread?.source_count
    ?? (draftSourceMode === 'scope' ? scopeReadyCount : selectedSourceIds.size);
  const canStartDraft = draftSourceMode === 'scope'
    ? !sourceLoading && scopeReadyCount > 0
    : selectedSourceIds.size > 0
      && Array.from(selectedSourceIds).every((noteId) => Boolean(sourceRegistry[noteId]));
  const canGenerateStudioResult = activeThread
    ? activeSourceCount > 0
    : canStartDraft;
  const studioActionsDisabled = !canGenerateStudioResult
    || sending
    || Boolean(backgroundThreadId);

  const availableChatModels = chatModelCatalog?.items || [];

  const selectedCustomModel = aiProviderConfig?.custom_models?.find(
    (model) => model.id === aiProviderConfig.selected_custom_model_id,
  );
  const selectedChatModel = aiProviderConfig?.mode === 'custom' && selectedCustomModel
    ? `custom:${selectedCustomModel.id}`
    : chatModelCatalog?.selected_offering_id
      || aiProviderConfig?.selected_offering_id
      || '';

  const changeChatModel = async (modelId: string) => {
    if (modelSaving || modelId === selectedChatModel || modelId === '__custom__') return;
    setModelSaving(true);
    setModelError('');

    if (modelId.startsWith('custom:')) {
      const customModelId = modelId.slice('custom:'.length);
      const response = await selectUserCustomChatModel(customModelId);
      setModelSaving(false);
      if (!response.success || !response.data) {
        setModelError(response.error || '模型切换失败，请稍后重试');
        return;
      }
      const selected = response.data.items.find((model) => model.id === customModelId);
      setAiProviderConfig((current) => current ? {
        ...current,
        mode: 'custom',
        selected_custom_model_id: customModelId,
        custom_models: response.data!.items,
        provider_name: selected?.provider_name || current.provider_name,
        model: selected?.model || current.model,
        api_base: selected?.api_base || current.api_base,
      } : current);
      setNotice(`已切换到 ${selected?.name || customModelId}`);
      return;
    }

    const response = await selectUserChatModel(modelId);
    setModelSaving(false);
    if (!response.success || !response.data) {
      setModelError(response.error || '模型切换失败，请稍后重试');
      return;
    }
    setChatModelCatalog((current) => current ? {
      ...current,
      selected_offering_id: response.data!.selected_offering_id,
    } : current);
    setAiProviderConfig((current) => current ? {
      ...current,
      mode: 'platform',
      model: response.data!.selected_offering_id,
      selected_offering_id: response.data!.selected_offering_id,
      selected_offering_name: response.data!.item.name,
      selected_custom_model_id: null,
    } : current);
    const selectedModel = availableChatModels.find((model) => model.id === modelId);
    setNotice(`已切换到 ${selectedModel?.name || modelId}`);
  };

  const applyCustomModelConfig = useEventCallback(async (
    draft: { providerName: string; model: string; apiBase: string; apiKey: string },
    action: 'save' | 'test' | 'reset',
  ): Promise<{ kind: 'saved' | 'tested' | 'reset'; label: string } | null> => {
    if (modelConfigSaving) return null;
    setModelConfigSaving(true);
    setModelError('');
    try {
      if (action === 'reset') {
        const response = await resetUserAIProvider();
        if (!response.success || !response.data) {
          setModelError(response.error || '恢复默认模型失败');
          return null;
        }
        setAiProviderConfig(response.data);
        setNotice('已恢复平台模型');
        return { kind: 'reset', label: '已恢复平台模型' };
      }

      const response = await saveUserAIProvider({
        mode: 'custom',
        provider_name: draft.providerName,
        model: draft.model,
        api_base: draft.apiBase,
        api_key: draft.apiKey,
      });
      if (!response.success || !response.data) {
        setModelError(response.error || '保存失败，请检查配置');
        return null;
      }
      setAiProviderConfig(response.data);
      setNotice(action === 'save' ? '已启用你的模型' : `保存成功：${response.data.model}`);

      if (action === 'test') {
        const testResponse = await testUserAIProvider();
        if (!testResponse.success || !testResponse.data) {
          setModelError(testResponse.error || '连接失败，请检查模型、地址和密钥');
          return null;
        }
        setNotice(`连接成功：${testResponse.data.model}`);
        return { kind: 'tested', label: `连接成功：${testResponse.data.model}` };
      }

      return { kind: 'saved', label: `已启用你的模型：${response.data.model}` };
    } finally {
      setModelConfigSaving(false);
    }
  });

  const selectedSources = useMemo(
    () => Array.from(selectedSourceIds)
      .map((noteId) => sourceRegistry[noteId])
      .filter((source): source is AgentSource => Boolean(source)),
    [selectedSourceIds, sourceRegistry],
  );
  const platformSources = useMemo(
    () => sourcePlatform === 'all'
      ? sources
      : sources.filter((source) => agentSourcePlatform(source) === sourcePlatform),
    [sourcePlatform, sources],
  );
  const visibleSelectedSources = useMemo(
    () => sourcePlatform === 'all'
      ? selectedSources
      : selectedSources.filter((source) => agentSourcePlatform(source) === sourcePlatform),
    [selectedSources, sourcePlatform],
  );
  const sourceMarquee = useMarqueeSelection({
    containerRef: sourceSelectionSurfaceRef,
    selectedIds: selectedSourceIds,
    maxSelection: MAX_SELECTED_SOURCES,
    alwaysAdditive: false,
    toggleOnHitSelected: true,
    disabled: sourceLoading
      || Boolean(sourceError)
      || (platformSources.length === 0 && visibleSelectedSources.length === 0),
    isDisabled: () => sourceLoading,
    onSelectionChange: (nextSelection) => {
      setSelectedSourceIds(nextSelection);
      setDraftSourceMode('selected');
      setPendingBatchDeleteIds(null);
      setNotice((current) => (
        current === `每个任务最多参考 ${MAX_SELECTED_SOURCES} 条视频` ? '' : current
      ));
    },
    onLimitReached: () => {
      setNotice(`每个任务最多参考 ${MAX_SELECTED_SOURCES} 条视频`);
    },
  });
  const displayedSourceSelection = sourceMarquee.previewSelectedIds ?? selectedSourceIds;
  const visibleSelectionTargetIds = useMemo(
    () => platformSources.slice(0, MAX_SELECTED_SOURCES).map((source) => source.note_id),
    [platformSources],
  );
  const allVisibleSourcesSelected = visibleSelectionTargetIds.length > 0
    && visibleSelectionTargetIds.every((noteId) => selectedSourceIds.has(noteId));

  const studioResults = useMemo(
    () => deriveAgentStudioResults(messages),
    [messages],
  );
  const artifactCount = studioResults.filter((result) => result.isArtifact).length;
  const selectedStudioResult = useMemo<AgentStudioResult | null>(() => (
    studioResults.find((result) => result.id === selectedStudioResultId)
    ?? studioResults.find((result) => result.isArtifact)
    ?? studioResults[0]
    ?? null
  ), [selectedStudioResultId, studioResults]);

  const openSourcesPanel = (trigger?: HTMLButtonElement | null) => {
    if (!isCompact) {
      document
        .getElementById('video-agent-sources-panel')
        ?.querySelector<HTMLElement>('input, select, button')
        ?.focus();
      return;
    }
    lastSourcesTriggerRef.current = trigger ?? null;
    studioWasOpenRef.current = false;
    lastStudioTriggerRef.current = null;
    setStudioOpen(false);
    setSourcesOpen(true);
  };

  const openStudioPanel = (trigger?: HTMLButtonElement | null) => {
    if (!isCompact) {
      document
        .getElementById('video-agent-studio-panel')
        ?.querySelector<HTMLElement>('button')
        ?.focus();
      return;
    }
    lastStudioTriggerRef.current = trigger ?? null;
    sourcesWereOpenRef.current = false;
    lastSourcesTriggerRef.current = null;
    setSourcesOpen(false);
    setStudioOpen(true);
  };

  const copyStudioResult = async (result: AgentStudioResult) => {
    try {
      await navigator.clipboard.writeText(result.content);
      setNotice('成果已复制到剪贴板');
    } catch {
      setError('浏览器没有允许复制，请在对话中手动选择内容');
    }
  };

  const revealStudioResultInConversation = (result: AgentStudioResult) => {
    setStudioOpen(false);
    window.requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      document
        .getElementById(`agent-message-${result.message.id}`)
        ?.scrollIntoView({
          block: 'center',
          behavior: reduceMotion ? 'auto' : 'smooth',
        });
    });
  };

  const openThread = async (threadId: string) => {
    abortRef.current?.abort();
    setSending(false);
    setThreadLoading(true);
    setError('');
    const response = await getAgentThread(threadId);
    setThreadLoading(false);
    if (!response.success || !response.data) {
      const terminal = response.status === 404 || response.status === 410;
      if (terminal && returnToEmbeddedSourceDraft(
        '这项会话已失效，已回到当前视频的新会话。',
        'notice',
      )) {
        invalidateThreadPointer();
      } else {
        setNotice('');
        setError(response.error || '暂时无法打开这项任务，当前会话已保留。');
      }
      return;
    }
    if (!threadMatchesEmbeddedSources(response.data)) {
      returnToEmbeddedSourceDraft(
        '这项会话不属于当前视频，已回到当前视频的新会话。',
        'notice',
      );
      invalidateThreadPointer();
      return;
    }
    setActiveThread(response.data);
    setMessages(threadConversationMessages(response.data));
    setMessageDeliveryStates(restoredDeliveryStates(response.data));
    setMessageDeliveryErrors(restoredDeliveryErrors(response.data));
    setStreamingMessageId(null);
    setStreamProgress(null);
    followingRef.current = true;
    restoreThreadSourceSelection(response.data);
    setBackgroundThreadId(
      threadHasBackgroundWork(response.data) ? response.data.id : null,
    );
    setHistoryOpen(false);
    setSourcesOpen(false);
    setStudioOpen(false);
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const startNewTask = () => {
    if (backgroundThreadId) {
      setNotice('上一条回答仍在后台处理中；完成后会自动更新，再开始新任务。');
      return;
    }
    const embeddedDefaultSourceIds = embeddedInitialSourceIdsRef.current;
    abortRef.current?.abort();
    setSending(false);
    setActiveThread(null);
    setMessages([]);
    setMessageDeliveryStates({});
    setMessageDeliveryErrors({});
    setStreamingMessageId(null);
    setStreamProgress(null);
    questionRef.current?.clear();
    setError('');
    if (embeddedDefaultSourceIds) {
      requestedSourceIdsRef.current = embeddedDefaultSourceIds;
      sourceHandoffNoticeSettledRef.current = true;
      setDraftSourceMode('selected');
      setSelectedSourceIds(new Set(embeddedDefaultSourceIds));
      setNotice(embeddedDefaultSourceIds.length > 0
        ? `新会话将参考当前 ${embeddedDefaultSourceIds.length} 条视频`
        : '当前没有可用的视频资料，请重新选择。');
    } else {
      setNotice(draftSourceMode === 'scope'
        ? `新会话将整体参考${sourceScopeLabel(browseScope)}`
        : `新会话将参考已选的 ${selectedSourceIds.size} 条视频`);
    }
    setHistoryOpen(false);
    setSourcesOpen(false);
    setStudioOpen(false);
    setSelectedStudioResultId(null);
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const chooseBrowseScope = (scope: BrowseSourceScope) => {
    sourceRequestRef.current?.abort();
    setBrowseScope(scope);
    setSourceQuery('');
    setSourceAppliedQuery('');
    setSourceSearchMode('browse');
    setSourceExpandedQueries([]);
    setSourceError('');
    if (activeThread) {
      setNotice('筛选只影响新研究候选，当前对话的视频快照不会改变。');
    }
  };

  const runSmartSourceSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    const query = sourceQuery.trim();
    if (query.length < 2) {
      setSourceError('请至少输入两个字，描述你想找的视频');
      return;
    }

    sourceRequestRef.current?.abort();
    const controller = new AbortController();
    sourceRequestRef.current = controller;
    setSourceLoading(true);
    setSourceError('');
    const response = await searchAgentSources({
      query,
      scope: browseScope,
      limit: 50,
    }, controller.signal);
    if (controller.signal.aborted) return;
    sourceRequestRef.current = null;
    setSourceLoading(false);

    if (!response.success || !response.data) {
      setSources([]);
      setSourceCount(0);
      setSourceError(response.error || '智能搜索暂时不可用，请稍后重试');
      return;
    }

    const items = response.data.items || [];
    setSources(items);
    setSourceCount(response.data.matched_count ?? items.length);
    setScopeReadyCount(response.data.ready_count ?? scopeReadyCount);
    setSourceAppliedQuery(response.data.query || query);
    setSourceSearchMode(response.data.search_mode);
    setSourceExpandedQueries(response.data.expanded_queries || []);
    setSourceScannedCount(response.data.scanned_count || 0);
    rememberSources(items);
  };

  const clearSourceSearch = () => {
    sourceRequestRef.current?.abort();
    setSourceQuery('');
    setSourceAppliedQuery('');
    setSourceSearchMode('browse');
    setSourceExpandedQueries([]);
    setSourceError('');
    void loadSources(browseScope);
  };

  const toggleSource = (noteId: string) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) {
        next.delete(noteId);
        setPendingBatchDeleteIds(null);
        return next;
      }
      if (next.size >= MAX_SELECTED_SOURCES) {
        setNotice(`每个任务最多参考 ${MAX_SELECTED_SOURCES} 条视频`);
        return current;
      }
      next.add(noteId);
      setDraftSourceMode('selected');
      setPendingBatchDeleteIds(null);
      return next;
    });
  };

  const permanentlyDeleteSelectedSources = async () => {
    if (deletingBatch || selectedSourceIds.size === 0) return;
    if (!pendingBatchDeleteIds) {
      const snapshot = Array.from(selectedSourceIds);
      setPendingBatchDeleteIds(snapshot);
      setNotice(`再次点击“确认永久移除”，将删除已选的 ${selectedSourceIds.size} 条视频`);
      return;
    }
    setDeletingBatch(true);
    const targetIds = [...pendingBatchDeleteIds];
    const result = await deleteAgentSources(targetIds);
    const deletedIds = new Set(result.success ? (result.data?.deleted_ids || []) : []);
    const failedIds = targetIds.filter((noteId) => !deletedIds.has(noteId));
    setDeletingBatch(false);
    setPendingBatchDeleteIds(null);
    setSources((current) => current.filter((item) => !deletedIds.has(item.note_id)));
    setSourceRegistry((current) => {
      const next = { ...current };
      deletedIds.forEach((noteId) => delete next[noteId]);
      return next;
    });
    setSelectedSourceIds(new Set(failedIds));
    setSourceCount((current) => Math.max(0, current - deletedIds.size));
    setScopeReadyCount((current) => Math.max(0, current - deletedIds.size));
    if (failedIds.length > 0) setError(`已永久移除 ${deletedIds.size} 条，${failedIds.length} 条删除失败`);
    else {
      setDraftSourceMode('selected');
      setRemoveSelectionMode(false);
      setNotice(`已永久移除 ${deletedIds.size} 条视频`);
    }
  };

  const toggleVisibleSources = () => {
    setDraftSourceMode('selected');
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (visibleSelectionTargetIds.length > 0
        && visibleSelectionTargetIds.every((noteId) => next.has(noteId))) {
        visibleSelectionTargetIds.forEach((noteId) => next.delete(noteId));
        setPendingBatchDeleteIds(null);
        return next;
      }
      for (const noteId of visibleSelectionTargetIds) {
        if (next.size >= MAX_SELECTED_SOURCES) break;
        next.add(noteId);
      }
      return next;
    });
  };

  const clearSelectedSources = () => {
    setPendingBatchDeleteIds(null);
    setSelectedSourceIds(new Set());
    setDraftSourceMode('selected');
    setNotice('已取消全部选择，可以继续手选视频');
  };

  const enterRemoveSelectionMode = () => {
    setPendingBatchDeleteIds(null);
    setSelectedSourceIds(new Set());
    setDraftSourceMode('selected');
    setRemoveSelectionMode(true);
  };

  const leaveRemoveSelectionMode = () => {
    setPendingBatchDeleteIds(null);
    setSelectedSourceIds(new Set());
    setRemoveSelectionMode(false);
  };

  const useOverallSourceScope = () => {
    setPendingBatchDeleteIds(null);
    setDraftSourceMode('scope');
    setRemoveSelectionMode(false);
    setNotice(`新会话将整体参考${sourceScopeLabel(browseScope)}`);
  };

  const useManualSourceSelection = () => {
    setPendingBatchDeleteIds(null);
    setDraftSourceMode('selected');
    setNotice(selectedSourceIds.size > 0
      ? `新会话将只参考已选的 ${selectedSourceIds.size} 条视频`
      : '请从下方勾选视频；桌面端也可以拖动框选');
  };

  const refreshThreadList = useCallback(async () => {
    const response = await listAgentThreads();
    if (response.success && response.data) {
      setThreads((response.data.items || []).filter(threadMatchesEmbeddedSources));
    }
  }, [threadMatchesEmbeddedSources]);

  useEffect(() => {
    if (!backgroundThreadId) return;

    const threadId = backgroundThreadId;
    let active = true;
    let timer: number | undefined;

    const pollThread = async () => {
      const response = await getAgentThread(threadId);
      if (!active) return;

      if (!response.success || !response.data) {
        timer = window.setTimeout(pollThread, 2500);
        return;
      }

      if (activeThread?.id === threadId) {
        setActiveThread(response.data);
        setMessages(threadConversationMessages(response.data));
        setMessageDeliveryStates(restoredDeliveryStates(response.data));
        setMessageDeliveryErrors(restoredDeliveryErrors(response.data));
        setStreamingMessageId(null);
        if (!response.data.active_turn) setStreamProgress(null);
      }

      if (threadHasBackgroundWork(response.data)) {
        timer = window.setTimeout(pollThread, 2000);
        return;
      }

      setBackgroundThreadId((current) => (
        current === threadId ? null : current
      ));
      setNotice(
        response.data.status === 'ready'
          ? '详细解析或后台回答已完成，内容已自动更新。'
          : response.data.status === 'awaiting_approval'
            ? '详细解析需要你的确认。'
            : '后台回答没有完成，你可以重新提问。',
      );
      void refreshThreadList();
    };

    timer = window.setTimeout(pollThread, 900);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeThread?.id, backgroundThreadId, refreshThreadList]);

  useEffect(() => {
    const threadId = activeThread?.id;
    const turnId = activeThread?.active_turn?.id;
    if (!threadId || !turnId || !shouldResumeAgentTurn({
      active,
      sending,
      thread: activeThread,
    })) return;

    resumeAbortRef.current?.abort();
    const controller = new AbortController();
    resumeAbortRef.current = controller;
    durableTurnIdRef.current = turnId;
    setBackgroundThreadId(threadId);
    setNotice('已恢复上一条研究任务，完成后会自动显示回答。');

    const followTurn = async () => {
      while (!controller.signal.aborted) {
        const response = await resumeAgentTurnStream(
          threadId,
          turnId,
          {
            onProgress: (progress) => setStreamProgress(progress),
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (response.success && response.data) {
          const nextThread = response.data.thread;
          setActiveThread(nextThread);
          setMessages(threadConversationMessages(nextThread));
          setMessageDeliveryStates({});
          setMessageDeliveryErrors({});
          setStreamingMessageId(null);
          setStreamProgress(null);
          setBackgroundThreadId(null);
          setTerminalTurn(null);
          durableTurnIdRef.current = null;
          setNotice('研究已完成，回答和逐条依据已恢复。');
          followingRef.current = true;
          void refreshThreadList();
          return;
        }
        if (response.status === 409 || response.status === 502) {
          const [refreshed, turnResponse] = await Promise.all([
            getAgentThread(threadId),
            getAgentTurn(threadId, turnId),
          ]);
          if (refreshed.success && refreshed.data && !threadHasBackgroundWork(refreshed.data)) {
            setActiveThread(refreshed.data);
            setMessages(threadConversationMessages(refreshed.data));
            setBackgroundThreadId(null);
            setStreamProgress(null);
            if (
              turnResponse.success
              && turnResponse.data
              && ['failed', 'cancelled'].includes(turnResponse.data.status)
            ) {
              setTerminalTurn(turnResponse.data);
              durableTurnIdRef.current = turnResponse.data.id;
            }
            setError(response.error || '后台研究没有完成，可以重试本轮研究。');
            return;
          }
        }
        setNotice('研究仍在后台运行；实时连接暂时中断，正在自动重连。');
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 1500);
          controller.signal.addEventListener('abort', () => {
            window.clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }
    };
    void followTurn().finally(() => {
      if (resumeAbortRef.current === controller) resumeAbortRef.current = null;
    });

    return () => controller.abort();
  }, [
    active,
    activeThread?.active_turn?.id,
    activeThread?.id,
    refreshThreadList,
    sending,
  ]);

  const submitQuestion = async (
    event?: FormEvent,
    suggestion?: string,
    options?: SubmitQuestionOptions,
  ) => {
    event?.preventDefault();
    const content = (
      suggestion ?? questionRef.current?.getValue() ?? ''
    ).trim();
    const requestedOutputStyle = options?.outputStyle ?? outputStyle;
    const requestedCustomInstruction = options?.customInstruction
      ?? customInstruction;
    if (!content || sending || modelSaving) return;
    if (backgroundThreadId || threadBlocksNewQuestion(activeThread)) {
      if (!backgroundThreadId && threadHasBackgroundWork(activeThread) && activeThread?.id) {
        setBackgroundThreadId(activeThread.id);
      }
      setNotice(
        activeThread?.status === 'awaiting_approval'
          ? '请先处理上一条问题中的详细解析审批。'
          : '上一条回答仍在后台处理中；完成后会自动更新，再继续提问。',
      );
      return;
    }
    if (!activeThread && !canStartDraft) {
      setStudioOpen(false);
      setSourcesOpen(true);
      setError(draftSourceMode === 'scope'
        ? `${sourceScopeLabel(browseScope)}里还没有文案就绪的视频`
        : '请至少勾选一条已有完整文案的视频，或改用整体范围');
      return;
    }

    setSending(true);
    setError('');
    setNotice('');
    questionRef.current?.clear();

    let thread = activeThread;
    if (!thread) {
      const created = await createAgentThread({
        title: content.slice(0, 48),
        source_scope: draftSourceMode === 'scope' ? browseScope : 'selected',
        source_ids: draftSourceMode === 'selected'
          ? Array.from(selectedSourceIds).slice(0, MAX_SELECTED_SOURCES)
          : [],
      });
      if (!created.success || !created.data) {
        setSending(false);
        questionRef.current?.setValue(content);
        setError(created.error || '暂时无法创建知萃 Harness 会话');
        return;
      }
      thread = created.data;
      setActiveThread(thread);
      setMessages(thread.messages || []);
    }

    const optimistic = createOptimisticMessage(thread.id, content);
    const streamingAssistant = createStreamingAssistantMessage(thread.id);
    setMessages((current) => [...current, optimistic, streamingAssistant]);
    setMessageDeliveryStates((current) => ({
      ...current,
      [optimistic.id]: 'sending',
    }));
    setMessageDeliveryErrors((current) => {
      const next = { ...current };
      delete next[optimistic.id];
      return next;
    });
    setStreamingMessageId(streamingAssistant.id);
    setStreamProgress({
      stage: 'queued',
      message: '正在连接知萃 Harness',
    });
    const controller = new AbortController();
    abortRef.current = controller;
    followingRef.current = true;
    setShowBackToBottom(false);
    // Keep the first visible provider delta immediate, then publish the
    // accumulated answer at most once per browser paint. SSE callbacks run in
    // separate async turns, so relying on React to batch every delta still
    // reparses the growing Markdown far more often than the display can show.
    let pendingDelta = '';
    let deltaFrame = 0;
    let hasVisibleDelta = false;
    let followFrame = 0;
    const scheduleFollow = () => {
      if (!activeRef.current || !followingRef.current || followFrame) return;
      followFrame = window.requestAnimationFrame(() => {
        followFrame = 0;
        if (!activeRef.current || !followingRef.current) return;
        const scroller = threadScrollRef.current;
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    };
    const commitStreamingDelta = (delta: string) => {
      if (!delta) return;
      setMessages((current) => current.map((message) => (
        message.id === streamingAssistant.id
          ? { ...message, content: `${message.content}${delta}` }
          : message
      )));
      scheduleFollow();
    };
    const commitPendingDelta = () => {
      if (!pendingDelta) return;
      const nextDelta = pendingDelta;
      pendingDelta = '';
      commitStreamingDelta(nextDelta);
    };
    const flushPendingDelta = () => {
      if (deltaFrame) {
        window.cancelAnimationFrame(deltaFrame);
        deltaFrame = 0;
      }
      commitPendingDelta();
    };
    const enqueueStreamingDelta = (delta: string) => {
      if (!delta) return;
      if (!hasVisibleDelta) {
        hasVisibleDelta = true;
        commitStreamingDelta(delta);
        return;
      }
      pendingDelta += delta;
      if (deltaFrame) return;
      deltaFrame = window.requestAnimationFrame(() => {
        deltaFrame = 0;
        commitPendingDelta();
      });
    };
    let response: Awaited<ReturnType<typeof streamAgentMessage>>;
    let durableTurnId = '';
    try {
      response = await streamAgentMessage(
        thread.id,
        {
          content,
          research_mode: researchMode,
          output_style: requestedOutputStyle,
          custom_instruction: requestedCustomInstruction,
          web_scope: webScope,
        },
        {
          onTurn: (turnId) => {
            durableTurnId = turnId;
            durableTurnIdRef.current = turnId;
          },
          onProgress: (progress) => {
            if (progress.turn_id) {
              durableTurnId = progress.turn_id;
              durableTurnIdRef.current = progress.turn_id;
            }
            setStreamProgress(progress);
            setMessageDeliveryStates((current) => {
              const next = { ...current };
              delete next[optimistic.id];
              return next;
            });
          },
          onAssistantStart: (assistantMessage) => {
            setMessages((current) => current.map((message) => (
              message.id === streamingAssistant.id
                ? { ...assistantMessage, id: streamingAssistant.id, content: message.content }
                : message
            )));
          },
          onDelta: (delta) => {
            enqueueStreamingDelta(delta);
          },
          onApprovalRequired: () => {
            setStreamProgress({
              stage: 'finalizing',
              message: '需要确认后才能读取视频画面',
            });
          },
          onAnalysisStarted: () => {
            setStreamProgress({
              stage: 'finalizing',
              message: '详细解析已进入后台',
            });
          },
        },
        controller.signal,
      );
    } finally {
      flushPendingDelta();
      if (followFrame) {
        window.cancelAnimationFrame(followFrame);
        followFrame = 0;
      }
      if (abortRef.current === controller) abortRef.current = null;
      setSending(false);
    }
    if (controller.signal.aborted) {
      setMessages((current) => current.filter(
        (message) => message.id !== streamingAssistant.id,
      ));
      setMessageDeliveryStates((current) => {
        const next = { ...current };
        delete next[optimistic.id];
        return next;
      });
      setStreamingMessageId(null);
      setStreamProgress(null);
      return;
    }
    if (!response.success || !response.data) {
      setMessages((current) => current.filter(
        (message) => message.id !== streamingAssistant.id,
      ));
      setStreamingMessageId(null);
      if (!durableTurnId) setStreamProgress(null);
      if (durableTurnId && (response.status === 409 || response.status === 502)) {
        const [restored, turnResponse] = await Promise.all([
          getAgentThread(thread.id),
          getAgentTurn(thread.id, durableTurnId),
        ]);
        if (
          turnResponse.success
          && turnResponse.data
          && ['failed', 'cancelled'].includes(turnResponse.data.status)
        ) {
          setMessages((current) => current.filter(
            (message) => message.id !== optimistic.id,
          ));
          setMessageDeliveryStates((current) => {
            const next = { ...current };
            delete next[optimistic.id];
            return next;
          });
          if (restored.success && restored.data) {
            setActiveThread(restored.data);
            setMessages(threadConversationMessages(restored.data));
          }
          setTerminalTurn(turnResponse.data);
          durableTurnIdRef.current = turnResponse.data.id;
          setBackgroundThreadId(null);
          setStreamProgress(null);
          setError(response.error || '本轮研究没有完成，可以重试。');
          return;
        }
      }
      if (durableTurnId && response.status !== 409) {
        setMessages((current) => current.filter(
          (message) => message.id !== optimistic.id,
        ));
        setMessageDeliveryStates((current) => {
          const next = { ...current };
          delete next[optimistic.id];
          return next;
        });
        setBackgroundThreadId(thread.id);
        setNotice('实时连接中断，但研究任务仍在后台执行；重新进入页面也会自动恢复。');
        const restored = await getAgentThread(thread.id);
        if (restored.success && restored.data) {
          setActiveThread(restored.data);
          setMessages(threadConversationMessages(restored.data));
        }
        return;
      }
      if (response.status === 409) {
        setMessages((current) => current.filter(
          (message) => message.id !== optimistic.id,
        ));
        setMessageDeliveryStates((current) => {
          const next = { ...current };
          delete next[optimistic.id];
          return next;
        });
        questionRef.current?.setValue(content);
        setBackgroundThreadId(thread.id);
        setNotice(response.error || '上一条回答仍在生成，请稍候再发送');
        return;
      }
      setMessageDeliveryStates((current) => ({
        ...current,
        [optimistic.id]: 'failed',
      }));
      setMessageDeliveryErrors((current) => ({
        ...current,
        [optimistic.id]: response.error || '知萃 Harness 暂时无法回答，请稍后重试',
      }));
      return;
    }

    const nextThread = response.data.thread;
    if (response.data.terminal === 'analysis_started') {
      const tracked = agentVideoAnalysisRunResult(response.data.video_analysis);
      if (tracked) trackVideoAnalysisRun(tracked);
    }
    const nextMessages = threadConversationMessages(nextThread);
    setActiveThread(nextThread);
    setMessageDeliveryStates({});
    setMessageDeliveryErrors({});
    setStreamingMessageId(null);
    setStreamProgress(null);
    setTerminalTurn(null);
    durableTurnIdRef.current = null;
    setMessages(
      nextMessages.length
        ? nextMessages
        : [
            optimistic,
            response.data.assistant_message,
          ],
    );
    followingRef.current = true;
    if (threadHasBackgroundWork(nextThread)) {
      setBackgroundThreadId(nextThread.id);
      setNotice('详细解析已进入后台，完成后会自动继续回答。');
    } else if (nextThread.status === 'awaiting_approval') {
      setBackgroundThreadId(null);
      setNotice('这次回答需要读取画面，请在消息中确认解析方式。');
    }
    if (requestedOutputStyle !== 'answer' && !response.data.terminal) {
      setSelectedStudioResultId(response.data.assistant_message.id);
    }
    if (options?.revealStudioOnComplete && isCompact) {
      setSourcesOpen(false);
      setStudioOpen(true);
    }
    void refreshThreadList();
  };

  const generateStudioResult = async (
    style: Exclude<LibraryOutputStyle, 'answer'>,
    prompt?: string,
  ) => {
    if (sending || backgroundThreadId || threadBlocksNewQuestion(activeThread)) {
      setNotice('上一份成果仍在生成，完成后再继续。');
      return;
    }
    if (style === 'custom' && !customInstruction.trim()) {
      setStudioCustomOpen(true);
      return;
    }
    const shortcut = STUDIO_SHORTCUTS.find((item) => item.value === style);
    const content = prompt
      ?? shortcut?.prompt
      ?? '请基于当前视频资料生成一份便于保存和复用的成果。';
    setStudioGeneratingType(style);
    try {
      await submitQuestion(undefined, content, {
        outputStyle: style,
        customInstruction: style === 'custom' ? customInstruction.trim() : '',
        revealStudioOnComplete: true,
      });
    } finally {
      setStudioGeneratingType(null);
    }
  };

  const removeOptimisticMessage = (messageId: string) => {
    setMessages((current) => current.filter((message) => message.id !== messageId));
    setMessageDeliveryStates((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
    setMessageDeliveryErrors((current) => {
      const next = { ...current };
      delete next[messageId];
      return next;
    });
  };

  const retryMessage = (message: AgentMessage) => {
    removeOptimisticMessage(message.id);
    void submitQuestion(undefined, message.content);
  };

  const editMessage = (message: AgentMessage) => {
    removeOptimisticMessage(message.id);
    questionRef.current?.setValue(message.content);
    setError('');
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const handleMessageFollowUp = useEventCallback((followUp: string) => {
    void submitQuestion(undefined, followUp);
  });
  const handleMessageRetry = useEventCallback((message: AgentMessage) => {
    retryMessage(message);
  });
  const handleMessageEdit = useEventCallback((message: AgentMessage) => {
    editMessage(message);
  });

  const handleVideoAnalysisDecision = useEventCallback(async (
    message: AgentMessage,
    action: AgentVideoAnalysisDecision,
    options?: { offeringId?: string; useByok?: boolean },
  ) => {
    const threadId = activeThread?.id || message.thread_id;
    const runId = agentVideoAnalysisRunId(message);
    if (!threadId || !runId || analysisDecisionMessageId) return;
    setAnalysisDecisionMessageId(message.id);
    setError('');
    const response = await decideAgentVideoAnalysis(threadId, runId, {
      action,
      idempotency_key: `agent-ui:${runId}`,
      offering_id: options?.offeringId,
      use_byok: Boolean(options?.useByok),
    });
    setAnalysisDecisionMessageId(null);
    if (!response.success || !response.data) {
      setError(response.error || '详细解析操作暂时没有完成');
      return;
    }
    const nextThread = response.data.thread;
    if (threadHasBackgroundWork(nextThread)) {
      const tracked = agentVideoAnalysisRunResult(response.data.video_analysis);
      if (tracked) trackVideoAnalysisRun(tracked);
    }
    setActiveThread(nextThread);
    setMessages(threadConversationMessages(nextThread));
    setMessageDeliveryStates({});
    setMessageDeliveryErrors({});
    if (threadHasBackgroundWork(nextThread)) {
      setBackgroundThreadId(nextThread.id);
      setNotice('详细解析已开始；完成后会自动继续回答。');
    } else {
      setBackgroundThreadId(null);
      setNotice(
        nextThread.status === 'awaiting_approval'
          ? '新方案已报价，请确认后开始。'
          : action === 'cancel'
            ? '已取消本次提问。'
            : '已按现有文案完成回答。',
      );
    }
    void refreshThreadList();
  });

  const stopSending = () => {
    const threadId = activeThread?.id;
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    setStudioGeneratingType(null);
    setStreamingMessageId(null);
    setStreamProgress(null);
    if (threadId) {
      setBackgroundThreadId(threadId);
      setActiveThread((current) => (
        current?.id === threadId
          ? { ...current, status: 'running' }
          : current
      ));
    }
    setNotice('已停止等待；后台仍在处理这条回答，完成后会自动更新。');
  };

  const cancelCurrentTurn = async () => {
    const threadId = activeThread?.id;
    const turnId = activeThread?.active_turn?.id || durableTurnIdRef.current;
    if (!threadId || !turnId) {
      stopSending();
      return;
    }
    if (turnAction) return;
    setTurnAction('cancel');
    setError('');
    const response = await cancelAgentTurn(threadId, turnId);
    setTurnAction('');
    if (!response.success || !response.data) {
      setError(response.error || '取消研究暂时没有完成');
      return;
    }

    const turn = response.data;
    durableTurnIdRef.current = turn.id;
    if (turn.status === 'cancelled') {
      abortRef.current?.abort();
      resumeAbortRef.current?.abort();
      setSending(false);
      setBackgroundThreadId(null);
      setStreamProgress(null);
      setTerminalTurn(turn);
      setActiveThread((current) => (
        current?.id === threadId ? { ...current, active_turn: null } : current
      ));
      setNotice('本轮研究已取消；需要时可以从原进度重新排队。');
      return;
    }

    setActiveThread((current) => (
      current?.id === threadId ? { ...current, active_turn: turn } : current
    ));
    setBackgroundThreadId(threadId);
    setStreamProgress({
      stage: 'finalizing',
      message: '正在安全停止研究任务',
      turn_id: turn.id,
      source_total_count: turn.source_total_count,
      scanned_count: turn.scanned_count,
      mapped_count: turn.mapped_count,
      deep_read_count: turn.deep_read_count,
    });
    setNotice('已发送取消请求；当前工具返回后会安全停止。');
  };

  const retryTerminalTurn = async () => {
    const threadId = activeThread?.id;
    if (
      !threadId
      || !terminalTurn
      || terminalTurn.thread_id !== threadId
      || turnAction
    ) return;
    setTurnAction('retry');
    setError('');
    const response = await retryAgentTurn(threadId, terminalTurn.id);
    setTurnAction('');
    if (!response.success || !response.data) {
      setError(response.error || '重新排队暂时没有完成');
      return;
    }
    const turn = response.data;
    durableTurnIdRef.current = turn.id;
    setTerminalTurn(null);
    setActiveThread((current) => (
      current?.id === threadId
        ? { ...current, status: 'running', active_turn: turn }
        : current
    ));
    setStreamProgress({
      stage: 'queued',
      message: '研究已重新排队',
      turn_id: turn.id,
      source_total_count: turn.source_total_count,
    });
    setBackgroundThreadId(threadId);
    setNotice('本轮研究已重新排队，会从保存的来源范围继续。');
  };

  const handleComposerSubmit = useEventCallback((content: string) => {
    void submitQuestion(undefined, content);
  });
  const handleComposerModelChange = useEventCallback((modelId: string) => {
    void changeChatModel(modelId);
  });
  const handleComposerOpenSources = useEventCallback((trigger: HTMLButtonElement) => {
    openSourcesPanel(trigger);
  });
  const handleComposerApplyOptions = useEventCallback((
    nextResearchMode: LibraryResearchMode,
    nextOutputStyle: LibraryOutputStyle,
    nextWebScope: ResearchScope,
  ) => {
    setResearchMode(nextResearchMode);
    setOutputStyle(nextOutputStyle);
    setWebScope(nextWebScope);
  });
  const handleComposerStop = useEventCallback(() => {
    void cancelCurrentTurn();
  });

  const removeThread = async (threadId: string) => {
    if (pendingThreadDelete !== threadId || destructivePending) return;
    setDestructivePending(true);
    const response = await deleteAgentThread(threadId);
    setDestructivePending(false);
    setPendingThreadDelete(null);
    if (!response.success) {
      setError(response.error || '删除任务失败');
      return;
    }
    setThreads((current) => current.filter((thread) => thread.id !== threadId));
    if (activeThread?.id === threadId) startNewTask();
  };

  const resetAutomationDraft = () => {
    setEditingAutomationId(null);
    setAutomationDraft({
      name: '每日收藏摘要',
      schedule_time: '09:00',
      source_scope: 'yesterday_new',
      source_mode: 'collect',
      instruction: defaultAutomationInstruction('collect'),
      recipient_email: user?.email || '',
    });
  };

  const editAutomation = (automation: AgentAutomation) => {
    setEditingAutomationId(automation.id);
    setAutomationDraft({
      name: automation.name,
      schedule_time: automation.schedule_time,
      source_scope: automation.source_scope,
      source_mode: automation.source_mode || 'collect',
      instruction: automation.instruction,
      recipient_email: automation.recipient_email,
    });
  };

  const saveAutomation = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !automationDraft.name.trim()
      || !automationDraft.schedule_time
      || !automationDraft.recipient_email.includes('@')
    ) {
      setAutomationError('请填写任务名称、发送时间和有效邮箱');
      return;
    }
    setAutomationSaving(true);
    setAutomationError('');
    const payload: AgentAutomationCreate = {
      name: automationDraft.name.trim(),
      timezone: 'Asia/Shanghai',
      schedule_time: automationDraft.schedule_time,
      source_scope: automationDraft.source_scope,
      source_mode: automationDraft.source_mode,
      instruction: automationDraft.instruction.trim(),
      channel: 'email',
      recipient_email: automationDraft.recipient_email.trim(),
    };
    const response = editingAutomationId
      ? await updateAgentAutomation(editingAutomationId, payload)
      : await createAgentAutomation(payload);
    setAutomationSaving(false);
    if (!response.success || !response.data) {
      setAutomationError(response.error || '暂时无法保存定时摘要');
      return;
    }
    setAutomations((current) => {
      const exists = current.some((item) => item.id === response.data!.id);
      return exists
        ? current.map((item) => (
            item.id === response.data!.id ? response.data! : item
          ))
        : [response.data!, ...current];
    });
    setNotice(editingAutomationId ? '定时摘要已更新' : '定时摘要已创建');
    resetAutomationDraft();
  };

  const toggleAutomation = async (automation: AgentAutomation) => {
    setAutomationError('');
    const response = await updateAgentAutomation(automation.id, {
      enabled: !automation.enabled,
    });
    if (!response.success || !response.data) {
      setAutomationError(response.error || '暂时无法修改定时摘要');
      return;
    }
    setAutomations((current) => current.map((item) => (
      item.id === automation.id ? response.data! : item
    )));
  };

  const runAutomationNow = async (automationId: string) => {
    setRunningAutomationId(automationId);
    setAutomationError('');
    const response = await runAgentAutomation(automationId);
    setRunningAutomationId(null);
    if (!response.success || !response.data) {
      setAutomationError(response.error || '立即运行失败');
      return;
    }
    setAutomationRuns((current) => ({
      ...current,
      [automationId]: response.data,
    }));
    setNotice('摘要预览已生成并保存，本次手动运行不会发送邮件。');
    void loadAutomations();
  };

  const requestEmailVerification = async () => {
    if (emailVerificationSending || emailStatus?.email_verified) return;
    if (emailStatus && !emailStatus.delivery.configured) {
      setEmailVerificationFeedback({
        tone: 'error',
        message: '邮件服务尚未启用；定时摘要仍会生成并保存在知萃中。',
      });
      return;
    }
    setEmailVerificationSending(true);
    setEmailVerificationFeedback(null);
    const response = await sendAgentEmailVerification();
    setEmailVerificationSending(false);
    if (!response.success || !response.data) {
      setEmailVerificationFeedback({
        tone: 'error',
        message: response.error || '验证邮件暂时没有提交成功，请稍后再试',
      });
      return;
    }
    if (response.data.email_verified) {
      setEmailStatus((current) => (
        current ? { ...current, email_verified: true } : current
      ));
      setEmailVerificationFeedback({
        tone: 'success',
        message: '邮箱已经验证，可以接收定时摘要。',
      });
      return;
    }
    setEmailVerificationFeedback({
      tone: 'success',
      message: '验证邮件已提交到邮箱，请查看收件箱和垃圾邮件。',
    });
  };

  const removeAutomation = async (automationId: string) => {
    if (pendingAutomationDelete !== automationId || destructivePending) return;
    setDestructivePending(true);
    const response = await deleteAgentAutomation(automationId);
    setDestructivePending(false);
    setPendingAutomationDelete(null);
    if (!response.success) {
      setAutomationError(response.error || '删除定时摘要失败');
      return;
    }
    setAutomations((current) => current.filter((item) => item.id !== automationId));
    if (editingAutomationId === automationId) resetAutomationDraft();
  };

  const threadDeleteTarget = pendingThreadDelete
    ? threads.find((thread) => thread.id === pendingThreadDelete) || null
    : null;
  const automationDeleteTarget = pendingAutomationDelete
    ? automations.find((automation) => automation.id === pendingAutomationDelete) || null
    : null;

  const closeDeleteConfirmation = () => {
    if (destructivePending) return;
    setPendingThreadDelete(null);
    setPendingAutomationDelete(null);
  };
  const workspaceClassName = [
    styles.root,
    embedded ? styles.embedded : 'video-agent-page',
    embedded ? 'video-agent-embedded' : 'desktop-core-page',
    'video-agent-refined',
  ].join(' ');
  const ConversationContainer = embedded ? 'div' : 'main';
  const conversationBlocked = isCompact
    && (historyOpen || sourcesOpen || studioOpen || automationOpen);

  return (
    <div className={workspaceClassName} data-embedded={embedded || undefined}>
      <div
        className={`video-agent-backdrop ${
          (isCompact && (historyOpen || sourcesOpen || studioOpen))
          || automationOpen
            ? 'is-visible'
            : ''
        }`}
        onClick={() => {
          setHistoryOpen(false);
          setSourcesOpen(false);
          setStudioOpen(false);
          setAutomationOpen(false);
        }}
        aria-hidden="true"
      />

      <section
        className="video-agent-shell"
        aria-label="知萃 Harness"
      >
        <aside
          id="video-agent-history-panel"
          className={`video-agent-history ${historyOpen ? 'is-open' : ''}`}
          role="dialog"
          aria-modal={isCompact && historyOpen ? true : undefined}
          aria-label="会话记录"
          aria-hidden={!historyOpen}
          inert={!historyOpen}
        >
          <header className="video-agent-panel-heading">
            <div>
              <strong>会话记录</strong>
            </div>
            <button
              ref={historyCloseRef}
              type="button"
              className="video-agent-mobile-close"
              onClick={() => setHistoryOpen(false)}
              aria-label="关闭任务列表"
            >
              <X size={18} />
            </button>
          </header>

          <button type="button" className="video-agent-new-task" onClick={() => startNewTask()}>
            <Plus size={15} weight="bold" /> 新建会话
          </button>

          <div className="video-agent-history-list">
            {threadsLoading ? (
              <div className="video-agent-rail-skeleton" aria-label="正在读取任务">
                <i /><i /><i />
              </div>
            ) : threads.length === 0 ? (
              <div className="video-agent-rail-empty">
                <ChatsCircle size={22} />
                <strong>还没有会话</strong>
                <span>提问后会保存在这里</span>
              </div>
            ) : (
              threads.map((thread) => (
                <article
                  key={thread.id}
                  className={`video-agent-history-item ${
                    activeThread?.id === thread.id ? 'is-active' : ''
                  }`}
                >
                  <button type="button" onClick={() => void openThread(thread.id)}>
                    <strong>{thread.title || '未命名任务'}</strong>
                    <span>{threadPreview(thread)}</span>
                    <small>
                      {sourceScopeLabel(thread.source_scope)}
                      {' · '}
                      {formatCompactTime(thread.updated_at)}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="video-agent-history-delete"
                    onClick={() => {
                      setPendingAutomationDelete(null);
                      setPendingThreadDelete(thread.id);
                    }}
                    aria-label={`删除会话：${thread.title || '未命名会话'}`}
                    title="删除会话"
                  >
                    <Trash size={14} />
                  </button>
                </article>
              ))
            )}
          </div>

        </aside>

        <ConversationContainer
          className="video-agent-main"
          role={embedded ? 'region' : undefined}
          aria-label={embedded ? '知萃 Harness 对话' : undefined}
          aria-hidden={conversationBlocked}
          inert={conversationBlocked}
        >
          <header className="video-agent-topbar">
            <div className="video-agent-topbar-leading">
              <span className="video-agent-avatar" aria-hidden="true">
                <AgentMark variant="nav" />
              </span>
              <div className="video-agent-conversation-heading">
                <button
                  ref={historyTriggerRef}
                  type="button"
                  className="video-agent-conversation-trigger"
                  onClick={() => setHistoryOpen((current) => !current)}
                  aria-expanded={historyOpen}
                  aria-controls="video-agent-history-panel"
                  title="查看会话记录"
                >
                  <h1>{activeThread?.title || '知萃 Harness'}</h1>
                  <CaretRight size={14} aria-hidden="true" />
                </button>
                <p>
                  {activeThread
                    ? `${sourceScopeLabel(activeScope)} · ${activeSourceCount} 条视频`
                    : draftSourceMode === 'scope'
                      ? `使用${sourceScopeLabel(browseScope)}`
                      : `使用已选 ${selectedSourceIds.size} 条视频`}
                </p>
              </div>
            </div>
            <div className="video-agent-topbar-actions">
              <button
                type="button"
                className="is-icon"
                onClick={() => startNewTask()}
                aria-label="新建会话"
                title="新建会话"
              >
                <Plus size={17} weight="bold" />
                <span className="sr-only">新建会话</span>
              </button>
              <button
                type="button"
                className="is-icon"
                onClick={() => setAutomationOpen(true)}
                aria-label="打开定时摘要"
                title="定时摘要"
              >
                <Clock size={16} />
                <span className="sr-only">定时摘要</span>
              </button>
              <button
                type="button"
                className="is-source"
                onClick={(event) => {
                  openSourcesPanel(event.currentTarget);
                }}
                aria-expanded={isCompact ? sourcesOpen : undefined}
                aria-controls="video-agent-sources-panel"
                aria-label={
                  activeThread
                    ? `本对话使用${sourceScopeLabel(activeScope)}，${activeSourceCount}条资料；打开新任务资料选择`
                    : `选择提问资料，当前${activeSourceCount}条可用`
                }
              >
                <FolderOpen size={16} />
                <span>
                  {activeThread
                    ? `本对话 · ${sourceScopeLabel(activeScope)}`
                    : sourceScopeLabel(activeScope)}
                </span>
                <b>{activeSourceCount}</b>
              </button>
              <button
                type="button"
                className="is-studio"
                onClick={(event) => openStudioPanel(event.currentTarget)}
                aria-expanded={isCompact ? studioOpen : undefined}
                aria-controls="video-agent-studio-panel"
                aria-label={`打开成果面板，当前有 ${artifactCount} 份成果`}
              >
                <Sparkle size={16} weight="fill" />
                <span>成果</span>
                <b>{artifactCount}</b>
              </button>
            </div>
          </header>

          <nav className="video-agent-mobile-tabs" aria-label="知萃 Harness 功能">
            <button
              type="button"
              onClick={(event) => openSourcesPanel(event.currentTarget)}
              aria-controls="video-agent-sources-panel"
              aria-expanded={sourcesOpen}
            >
              <VideoCamera size={16} />
              视频
              <b>{activeSourceCount}</b>
            </button>
            <button type="button" className="is-active" aria-current="page">
              <ChatsCircle size={16} />
              对话
            </button>
            <button
              type="button"
              onClick={(event) => openStudioPanel(event.currentTarget)}
              aria-controls="video-agent-studio-panel"
              aria-expanded={studioOpen}
            >
              <Sparkle size={16} weight="fill" />
              成果
              <b>{artifactCount}</b>
            </button>
            <button type="button" onClick={() => setAutomationOpen(true)}>
              <Clock size={16} />
              摘要
            </button>
          </nav>

          {(notice || error) && (
            <div
              className={`video-agent-inline-status ${error ? 'is-error' : ''}`}
              role={error ? 'alert' : 'status'}
            >
              {error ? <X size={15} /> : <CheckCircle size={15} />}
              <span>{error || notice}</span>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
                aria-label="关闭提示"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <div
            ref={threadScrollRef}
            className="video-agent-thread"
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {threadLoading ? (
              <div className="video-agent-thread-skeleton" aria-label="正在打开任务">
                <i /><i /><i />
              </div>
            ) : messages.length === 0 ? (
              <div className="video-agent-welcome">
                <span className="video-agent-welcome-mark" aria-hidden="true">
                  <AgentMark variant="hero" />
                </span>
                <h2>选择视频，直接提问</h2>
                {canStartDraft ? (
                  <div className="video-agent-starters">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => void submitQuestion(undefined, starter)}
                      >
                        <span>{starter}</span>
                        <CaretRight size={15} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="video-agent-welcome-empty">
                    <span>还没有可阅读的视频文案</span>
                    <a href="/library">
                      添加视频
                      <CaretRight size={15} />
                    </a>
                  </div>
                )}
              </div>
            ) : (
              messages.map((message) => (
                <AgentMessageView
                  key={message.id}
                  message={message}
                  deliveryState={messageDeliveryStates[message.id]}
                  deliveryError={messageDeliveryErrors[message.id]}
                  streaming={message.id === streamingMessageId}
                  disabled={
                    sending
                    || Boolean(backgroundThreadId)
                    || analysisDecisionMessageId === message.id
                  }
                  onFollowUp={handleMessageFollowUp}
                  onRetry={handleMessageRetry}
                  onEdit={handleMessageEdit}
                  onVideoAnalysisDecision={handleVideoAnalysisDecision}
                />
              ))
            )}

            {sending && !streamingMessageId && (
              <div className="video-agent-thinking" role="status">
                <span><i /><i /><i /></span>
                {researchMode === 'deep'
                  ? '正在分批阅读资料并综合依据'
                  : researchMode === 'fast'
                    ? '正在检索完整文案并组织回答'
                    : '正在判断问题范围并选择研究深度'}
              </div>
            )}
            {!sending && backgroundThreadId && (
              <div className="video-agent-thinking" role="status" aria-live="polite">
                <span><i /><i /><i /></span>
                <span className="video-agent-thinking-copy">
                  <strong>
                    {activeThread?.active_turn?.cancellation_requested
                      ? '正在安全停止研究任务'
                      : streamProgress?.message || '后台仍在处理上一条回答'}
                  </strong>
                  <small>
                    {researchProgressDetail(streamProgress)
                      || '完成后会自动更新，刷新或切换页面不会丢失'}
                  </small>
                </span>
                {activeThread?.active_turn?.id && (
                  <button
                    type="button"
                    className="video-agent-turn-action"
                    disabled={
                      turnAction === 'cancel'
                      || activeThread.active_turn.cancellation_requested
                    }
                    onClick={() => void cancelCurrentTurn()}
                    aria-label="取消研究"
                  >
                    <X size={14} aria-hidden="true" />
                    {activeThread.active_turn.cancellation_requested
                      ? '正在停止'
                      : turnAction === 'cancel'
                        ? '正在取消'
                        : '取消研究'}
                  </button>
                )}
              </div>
            )}
            {!sending
              && !backgroundThreadId
              && terminalTurn
              && terminalTurn.thread_id === activeThread?.id && (
              <div className="video-agent-thinking is-terminal" role="status" aria-live="polite">
                <span className="video-agent-turn-terminal-icon" aria-hidden="true">
                  <X size={14} />
                </span>
                <span className="video-agent-thinking-copy">
                  <strong>
                    {terminalTurn.status === 'cancelled'
                      ? '本轮研究已取消'
                      : '本轮研究没有完成'}
                  </strong>
                  <small>
                    {terminalTurn.error_message || '已保留来源范围和安全事件，可以重新排队'}
                  </small>
                </span>
                <button
                  type="button"
                  className="video-agent-turn-action"
                  disabled={turnAction === 'retry'}
                  onClick={() => void retryTerminalTurn()}
                  aria-label="重试研究"
                >
                  <ArrowClockwise size={14} aria-hidden="true" />
                  {turnAction === 'retry' ? '正在排队' : '重试研究'}
                </button>
              </div>
            )}
            <div className="video-agent-to-bottom-slot" aria-hidden={!showBackToBottom}>
              <button
                type="button"
                className={`video-agent-back-to-bottom ${showBackToBottom ? 'is-visible' : ''}`}
                onClick={scrollThreadToBottom}
                aria-label="回到最新消息"
                title="回到最新消息"
                tabIndex={showBackToBottom ? 0 : -1}
              >
                <CaretDown size={17} weight="bold" />
              </button>
            </div>
            <div ref={messageEndRef} />
          </div>

          <AgentComposer
            ref={questionRef}
            activeSourceCount={activeSourceCount}
            accountPoints={chatModelCatalog?.account.available_points || 0}
            aiProviderConfig={aiProviderConfig}
            availableModels={availableChatModels}
            backgroundActive={
              Boolean(backgroundThreadId) || activeThread?.status === 'awaiting_approval'
            }
            customInstruction={customInstruction}
            modelCatalogLoading={modelCatalogLoading}
            modelError={modelError}
            modelSaving={modelSaving}
            modelConfigSaving={modelConfigSaving}
            outputLabel={OUTPUT_LABELS[outputStyle]}
            outputStyle={outputStyle}
            researchMode={researchMode}
            researchLabel={researchMode === 'deep' ? '深度' : researchMode === 'fast' ? '快速' : '自动'}
            selectedModel={selectedChatModel}
            sourceLabel={sourceScopeLabel(activeScope)}
            sourcesExpanded={isCompact ? sourcesOpen : undefined}
            statusMessage={
              modelCatalogLoading
                ? '正在准备回答'
                : modelSaving
                  ? '正在切换回答方式'
                  : sending
                    ? streamProgress?.message || '正在准备回答'
                    : `${researchMode === 'deep' ? '深度研究' : researchMode === 'fast' ? '快速回答' : '自动研究'} · ${activeSourceCount} 条视频`
            }
            webLabel={webScope === 'auto' ? '按需查证' : '仅视频'}
            webScope={webScope}
            sending={sending}
            onChangeCustomInstruction={setCustomInstruction}
            onChangeModel={handleComposerModelChange}
            onConfigureCustomModel={applyCustomModelConfig}
            onApplyOptions={handleComposerApplyOptions}
            onOpenSources={handleComposerOpenSources}
            onStop={handleComposerStop}
            onSubmitQuestion={handleComposerSubmit}
          />
        </ConversationContainer>

        <aside
          id="video-agent-sources-panel"
          className={`video-agent-sources ${sourcesOpen ? 'is-open' : ''}`}
          role={isCompact ? 'dialog' : undefined}
          aria-modal={isCompact && sourcesOpen ? true : undefined}
          aria-labelledby="video-agent-sources-title"
          aria-hidden={isCompact ? !sourcesOpen : false}
          inert={isCompact && !sourcesOpen}
        >
          <header className="video-agent-panel-heading">
            <div>
              <strong id="video-agent-sources-title">
                选择视频
              </strong>
            </div>
            <div className="video-agent-source-heading-actions">
              <button
                type="button"
                className="video-agent-source-sync-link"
                onClick={() => setSourceSyncOpen(true)}
                aria-label="同步视频"
                title="同步视频"
              >
                <ArrowClockwise size={18} aria-hidden="true" />
              </button>
              <button
                ref={sourcesCloseRef}
                type="button"
                className="video-agent-mobile-close"
                onClick={() => { leaveRemoveSelectionMode(); setSourcesOpen(false); }}
                aria-label="关闭资料面板"
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <nav className="video-agent-platform-tabs" aria-label="视频平台">
            {SOURCE_PLATFORMS.map((platform) => (
              <button
                key={platform.value}
                type="button"
                className={sourcePlatform === platform.value ? 'is-active' : ''}
                aria-current={sourcePlatform === platform.value ? 'page' : undefined}
                onClick={() => { setPendingBatchDeleteIds(null); setSourcePlatform(platform.value); }}
                disabled={deletingBatch}
                aria-label={platform.label}
                title={platform.label}
              >
                <SourcePlatformIcon platform={platform.value} />
                <span className="video-agent-platform-label">{platform.label}</span>
              </button>
            ))}
          </nav>

          <form className="video-agent-source-search" onSubmit={runSmartSourceSearch}>
            <input
              type="search"
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.target.value.slice(0, 120))}
              placeholder="搜索标题或内容"
              aria-label="搜索视频"
            />
            <button
              type="submit"
              disabled={sourceLoading || sourceQuery.trim().length < 2}
              aria-label="搜索视频"
            >
              {sourceLoading
                ? <ArrowClockwise size={15} className="animate-spin" />
                : <MagnifyingGlass size={15} />}
            </button>
            {(sourceQuery || sourceAppliedQuery) && (
              <button type="button" onClick={clearSourceSearch} aria-label="清空搜索">
                <X size={15} />
              </button>
            )}
          </form>

          <div className="video-agent-source-mode" role="group" aria-label="新会话资料范围">
            <button
              type="button"
              className={draftSourceMode === 'scope' ? 'is-active' : ''}
              aria-pressed={draftSourceMode === 'scope'}
              onClick={useOverallSourceScope}
              disabled={deletingBatch || removeSelectionMode}
            >
              <FolderOpen size={16} aria-hidden="true" />
              <span>
                <strong>全部视频</strong>
              </span>
              <b>{sourcePlatform === 'all' ? scopeReadyCount : platformSources.length}</b>
            </button>
            <button
              type="button"
              className={draftSourceMode === 'selected' ? 'is-active' : ''}
              aria-pressed={draftSourceMode === 'selected'}
              onClick={useManualSourceSelection}
              disabled={deletingBatch || removeSelectionMode}
            >
              <SelectionAll size={17} weight="duotone" aria-hidden="true" />
              <span>
                <strong>仅已选</strong>
              </span>
              <b>{selectedSourceIds.size}</b>
            </button>
          </div>

          <div className="video-agent-source-selection-bar">
            {draftSourceMode === 'selected' ? (
              <span className="video-agent-selection-count" role="status">
                已选 <strong>{displayedSourceSelection.size}</strong>/{MAX_SELECTED_SOURCES}
              </span>
            ) : (
              <span
                className="video-agent-selection-count"
                role="status"
                title={sourceAppliedQuery
                  ? `${sourceSearchMode === 'keyword_fallback' ? '关键词匹配' : '智能匹配'}，扫描 ${sourceScannedCount} 条${sourceExpandedQueries.length ? `，检索词：${sourceExpandedQueries.join('、')}` : ''}`
                  : undefined}
              >
                {sourceLoading
                  ? '正在读取'
                  : `${platformSources.length} 条视频`}
              </span>
            )}
            <div>
              <button
                type="button"
                onClick={toggleVisibleSources}
                disabled={platformSources.length === 0 || deletingBatch}
              >
                {allVisibleSourcesSelected ? '取消全选' : '全选'}
              </button>
              {draftSourceMode === 'selected' && (
                <button type="button" onClick={clearSelectedSources} disabled={selectedSourceIds.size === 0 || deletingBatch}>清空全部</button>
              )}
              {!removeSelectionMode && (
                <button
                  type="button"
                  className="is-remove-mode"
                  onClick={enterRemoveSelectionMode}
                  disabled={deletingBatch}
                  aria-label="选择要永久移除的视频"
                  title="永久移除视频"
                >
                  <Trash size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {(selectedSourceIds.size > 0 || removeSelectionMode) && (
            <div className={`video-agent-source-batch-actions ${pendingBatchDeleteIds ? 'is-confirming' : ''} ${removeSelectionMode ? 'is-removing' : ''}`}>
              {pendingBatchDeleteIds ? (
                <>
                  <span>永久移除 {pendingBatchDeleteIds.length} 条？此操作不可撤销</span>
                  <button type="button" onClick={() => setPendingBatchDeleteIds(null)} disabled={deletingBatch}>取消</button>
                  <button type="button" className="is-danger-confirm" onClick={() => void permanentlyDeleteSelectedSources()} disabled={deletingBatch}>
                    {deletingBatch ? '移除中' : '确认移除'}
                  </button>
                </>
              ) : removeSelectionMode ? (
                <>
                  <button type="button" onClick={leaveRemoveSelectionMode} disabled={deletingBatch}>取消</button>
                  <button
                    type="button"
                    className="is-danger"
                    onClick={() => void permanentlyDeleteSelectedSources()}
                    disabled={selectedSourceIds.size === 0 || deletingBatch}
                  >
                    <Trash size={14} aria-hidden="true" />
                    永久移除 · {selectedSourceIds.size}
                  </button>
                </>
              ) : (
                <>
                  <VideoAnalysisBatchAction
                    noteIds={Array.from(selectedSourceIds)}
                    selectedCount={selectedSourceIds.size}
                    unsupportedCount={0}
                    disabled={deletingBatch}
                    label={`解析画面 · ${selectedSourceIds.size}`}
                    onStarted={(cachedOnly) => setNotice(cachedOnly
                      ? '已复用现有画面解析结果，不消耗萃点'
                      : '详细视频解析已进入后台，完成后会更新摘要与回答依据')}
                  />
                </>
              )}
            </div>
          )}

          <p id="video-agent-marquee-help" className="sr-only">
            桌面端可用鼠标拖动框选视频来源；再次框住已选视频即可取消选择，按住 Ctrl 或 Command 拖动可追加选择。
          </p>
          <div
            ref={sourceSelectionSurfaceRef}
            className="video-agent-source-list"
            role="group"
            aria-label="视频来源列表"
            aria-describedby="video-agent-marquee-help"
            {...sourceMarquee.surfaceProps}
          >
            {sourceLoading ? (
              <div className="video-agent-source-skeleton" aria-label="正在整理资料">
                <i /><i /><i /><i />
              </div>
            ) : sourceError ? (
              <div className="video-agent-source-empty">
                <FolderOpen size={22} />
                <strong>资料暂时不可用</strong>
                <span>{sourceError}</span>
                <button
                  type="button"
                  onClick={() => {
                    if (sourceQuery.trim().length >= 2) {
                      void runSmartSourceSearch();
                    } else {
                      void loadSources(browseScope);
                    }
                  }}
                >
                  重新读取
                </button>
              </div>
            ) : platformSources.length === 0 && visibleSelectedSources.length === 0 ? (
              <div className="video-agent-source-empty">
                <VideoCamera size={22} />
                <strong>
                  {selectedSourceIds.size > 0
                    ? '已选资料暂时不可用'
                    : sourceAppliedQuery
                      ? '没有找到匹配视频'
                      : '还没有可用视频'}
                </strong>
                <span>
                  {selectedSourceIds.size > 0
                    ? `${selectedSourceIds.size} 条已选视频暂时不可用。`
                    : sourceAppliedQuery
                      ? '换个关键词试试。'
                      : '同步视频后会显示在这里。'}
                </span>
                {!sourceAppliedQuery && selectedSourceIds.size === 0 && (
                  <button type="button" onClick={() => setSourceSyncOpen(true)}>同步视频</button>
                )}
              </div>
            ) : (
              <>
                {sourcePlatform === 'all' && selectedSourceIds.size > selectedSources.length && (
                  <p className="video-agent-source-resolution-note" role="status">
                    {selectedSourceIds.size - selectedSources.length} 条已选资料暂时无法读取，提交前会再次校验
                  </p>
                )}

                <section
                  className="video-agent-source-group"
                  aria-labelledby="video-agent-available-sources-heading"
                >
                  <h3 id="video-agent-available-sources-heading">
                    <span>可选视频</span>
                    <strong>{platformSources.length}</strong>
                  </h3>
                  <div>
                    {platformSources.map((source) => (
                      <AgentSourceOption
                        key={source.note_id}
                        source={source}
                        selected={displayedSourceSelection.has(source.note_id)}
                        onToggle={toggleSource}
                        disabled={deletingBatch}
                      />
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>

          {!removeSelectionMode && (activeThread ? (
            <button
              type="button"
              className="video-agent-apply-sources"
              disabled={!canStartDraft}
              onClick={startNewTask}
            >
              <Plus size={16} weight="bold" />
              {draftSourceMode === 'scope'
                ? '开始整体提问'
                : `用已选 ${selectedSourceIds.size} 条开始`}
            </button>
          ) : (
            <button
              type="button"
              className="video-agent-apply-sources"
              disabled={!canStartDraft}
              onClick={() => {
                setSourcesOpen(false);
                setNotice(draftSourceMode === 'scope'
                  ? `将整体参考${sourceScopeLabel(browseScope)}，现在可以直接提问。`
                  : `已选择 ${selectedSourceIds.size} 条视频，现在可以直接提问。`);
                window.requestAnimationFrame(() => questionRef.current?.focus());
              }}
            >
              {draftSourceMode === 'scope'
                ? <FolderOpen size={16} weight="fill" />
                : <CheckCircle size={16} weight="fill" />}
              {draftSourceMode === 'scope'
                ? '整体提问'
                : `使用已选 ${selectedSourceIds.size} 条`}
            </button>
          ))}
        </aside>

        <MarqueeSelectionOverlay rect={sourceMarquee.marqueeRect} />

        <aside
          id="video-agent-studio-panel"
          className={`video-agent-studio ${studioOpen ? 'is-open' : ''}`}
          role={isCompact ? 'dialog' : undefined}
          aria-modal={isCompact && studioOpen ? true : undefined}
          aria-labelledby="video-agent-studio-title"
          aria-hidden={isCompact ? !studioOpen : false}
          inert={isCompact && !studioOpen}
        >
          <header className="video-agent-panel-heading">
            <div>
              <span>成果</span>
              <strong id="video-agent-studio-title">
                {artifactCount > 0
                  ? `${artifactCount} 份可复用成果`
                  : '把对话沉淀成可复用内容'}
              </strong>
            </div>
            <button
              ref={studioCloseRef}
              type="button"
              className="video-agent-mobile-close"
              onClick={() => setStudioOpen(false)}
              aria-label="关闭成果面板"
            >
              <X size={18} />
            </button>
          </header>

          {isCompact && studioOpen && (notice || error) && (
            <div
              className={`video-agent-studio-feedback ${error ? 'is-error' : ''}`}
              role={error ? 'alert' : 'status'}
            >
              {error ? <X size={15} /> : <CheckCircle size={15} />}
              <span>{error || notice}</span>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setNotice('');
                }}
                aria-label="关闭成果提示"
              >
                <X size={14} />
              </button>
            </div>
          )}

          <div className="video-agent-studio-body">
            <section
              className="video-agent-studio-create"
              aria-labelledby="video-agent-studio-create-title"
            >
              <div className="video-agent-studio-section-heading">
                <div>
                  <span>基于当前视频</span>
                  <h2 id="video-agent-studio-create-title">生成新成果</h2>
                </div>
                <Sparkle size={17} weight="fill" aria-hidden="true" />
              </div>

              <div className="video-agent-studio-shortcuts">
                {STUDIO_SHORTCUTS.map(({ value, label, description, Icon }) => (
                  <button
                    type="button"
                    key={value}
                    disabled={studioActionsDisabled}
                    onClick={() => void generateStudioResult(value)}
                    aria-label={`生成${label}：${description}`}
                  >
                    <span><Icon size={18} weight="duotone" /></span>
                    <strong>{label}</strong>
                    <small>{description}</small>
                    <CaretRight size={14} aria-hidden="true" />
                  </button>
                ))}
                <button
                  type="button"
                  className={studioCustomOpen ? 'is-active' : ''}
                  disabled={studioActionsDisabled}
                  onClick={() => setStudioCustomOpen((current) => !current)}
                  aria-expanded={studioCustomOpen}
                  aria-controls="video-agent-studio-custom"
                >
                  <span><FileText size={18} weight="duotone" /></span>
                  <strong>自定义</strong>
                  <small>指定结构、重点或使用场景</small>
                  <CaretRight size={14} aria-hidden="true" />
                </button>
              </div>

              {studioCustomOpen && (
                <form
                  id="video-agent-studio-custom"
                  className="video-agent-studio-custom"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!customInstruction.trim()) return;
                    setStudioCustomOpen(false);
                    void generateStudioResult(
                      'custom',
                      '请基于当前视频资料，严格按照我给出的自定义要求生成一份可复用成果。',
                    );
                  }}
                >
                  <label htmlFor="video-agent-studio-custom-input">
                    你希望得到什么
                  </label>
                  <textarea
                    id="video-agent-studio-custom-input"
                    rows={3}
                    maxLength={600}
                    value={customInstruction}
                    onChange={(event) => setCustomInstruction(event.target.value)}
                    placeholder="例如：整理成一页项目复盘模板，包含结论、依据和下周动作"
                  />
                  <div>
                    <span>{customInstruction.length}/600</span>
                    <button
                      type="submit"
                      disabled={studioActionsDisabled || !customInstruction.trim()}
                    >
                      生成自定义成果
                    </button>
                  </div>
                </form>
              )}

              {studioGeneratingType && (
                <div className="video-agent-studio-generating" role="status">
                  <span><i /><i /><i /></span>
                  正在生成{studioResultTypeLabel(studioGeneratingType)}
                </div>
              )}
            </section>

            <section
              className="video-agent-studio-library"
              aria-labelledby="video-agent-studio-library-title"
            >
              <div className="video-agent-studio-section-heading">
                <div>
                  <span>当前研究</span>
                  <h2 id="video-agent-studio-library-title">已生成</h2>
                </div>
                <b>{studioResults.length}</b>
              </div>

              {threadLoading ? (
                <div className="video-agent-studio-skeleton" aria-label="正在恢复成果">
                  <i /><i /><i />
                </div>
              ) : studioResults.length === 0 ? (
                <div className="video-agent-studio-empty">
                  <span><Sparkle size={22} weight="duotone" /></span>
                  <strong>成果会保存在这里</strong>
                  <p>
                    先从上方生成总结、对比或行动方案。只展示真实生成并保存的内容。
                  </p>
                  {!canGenerateStudioResult && (
                    <button
                      type="button"
                      onClick={(event) => openSourcesPanel(event.currentTarget)}
                    >
                      先选择视频
                      <CaretRight size={14} />
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="video-agent-studio-list">
                    {studioResults.map((result) => (
                      <button
                        type="button"
                        key={result.id}
                        className={`${
                          selectedStudioResult?.id === result.id ? 'is-selected' : ''
                        } ${result.isArtifact ? 'is-artifact' : 'is-answer'}`}
                        onClick={() => setSelectedStudioResultId(result.id)}
                        aria-pressed={selectedStudioResult?.id === result.id}
                      >
                        <span className="video-agent-studio-result-type">
                          {result.type === 'action_plan'
                            ? <ListChecks size={15} />
                            : result.type === 'comparison'
                              ? <Scales size={15} />
                              : result.type === 'summary'
                                ? <Notebook size={15} />
                                : <FileText size={15} />}
                          {result.label}
                        </span>
                        <strong>{result.title}</strong>
                        <small>{result.preview}</small>
                        <i>
                          {formatCompactTime(result.createdAt)}
                          {' · '}
                          {result.sourceCount} 个视频
                        </i>
                      </button>
                    ))}
                  </div>

                  {selectedStudioResult && (
                    <article className="video-agent-studio-detail">
                      <header>
                        <div>
                          <span>{selectedStudioResult.label}</span>
                          <h3>{selectedStudioResult.title}</h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => void copyStudioResult(selectedStudioResult)}
                          aria-label="复制当前成果"
                          title="复制成果"
                        >
                          <ClipboardText size={16} />
                        </button>
                      </header>
                      <div className="video-agent-studio-detail-meta">
                        <span>{selectedStudioResult.sourceCount} 个视频</span>
                        <span>{selectedStudioResult.evidenceCount} 条依据</span>
                      </div>
                      <MessageResponse className="video-agent-studio-markdown">
                        {selectedStudioResult.content}
                      </MessageResponse>
                      <footer>
                        <button
                          type="button"
                          onClick={() => void copyStudioResult(selectedStudioResult)}
                        >
                          <ClipboardText size={15} />
                          复制成果
                        </button>
                        <button
                          type="button"
                          onClick={() => revealStudioResultInConversation(selectedStudioResult)}
                        >
                          <ArrowsOut size={15} />
                          在对话中查看
                        </button>
                      </footer>
                    </article>
                  )}
                </>
              )}
            </section>
          </div>
        </aside>
      </section>

      <section
        className={`video-agent-automation-sheet ${automationOpen ? 'is-open' : ''}`}
        role="dialog"
        aria-modal={automationOpen || undefined}
        aria-label="定时摘要"
        aria-hidden={!automationOpen}
        inert={!automationOpen}
      >
        <header>
          <div>
            <span><EnvelopeSimple size={17} /></span>
            <div>
              <p>自动化</p>
              <h2>每天收到真正看得完的摘要</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAutomationOpen(false)}
            aria-label="关闭定时摘要"
          >
            <X size={18} />
          </button>
        </header>

        {automationError && (
          <div className="video-agent-automation-error" role="alert">
            <X size={16} />
            <span>{automationError}</span>
            <button
              type="button"
              onClick={() => setAutomationError('')}
              aria-label="关闭定时摘要错误提示"
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div className="video-agent-automation-body">
          <form className="video-agent-automation-form" onSubmit={saveAutomation}>
            <div className="video-agent-automation-form-heading">
              <div>
                <strong>{editingAutomationId ? '调整摘要任务' : '新建摘要任务'}</strong>
                <span>系统按知萃中的整理时间筛选，不声称这是抖音的准确收藏时间。</span>
              </div>
              {editingAutomationId && (
                <button type="button" onClick={resetAutomationDraft}>取消编辑</button>
              )}
            </div>

            <label>
              <span>任务名称</span>
              <input
                value={automationDraft.name}
                maxLength={80}
                onChange={(event) => setAutomationDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))}
                placeholder="每日收藏摘要"
              />
            </label>

            <div className="video-agent-automation-form-row">
              <label>
                <span>每天几点发送</span>
                <input
                  type="time"
                  value={automationDraft.schedule_time}
                  onChange={(event) => setAutomationDraft((current) => ({
                    ...current,
                    schedule_time: event.target.value,
                  }))}
                />
              </label>
              <div className="video-agent-automation-field">
                <span>参考范围</span>
                <div className="video-agent-automation-fixed-scope">
                  <ClockCounterClockwise size={17} aria-hidden="true" />
                  <span>
                    <strong>昨天新整理的内容</strong>
                    <small>每天只处理新增视频，不重复打扰</small>
                  </span>
                </div>
              </div>
            </div>

            <fieldset className="video-agent-automation-field">
              <legend>内容来源</legend>
              <div
                className="video-agent-automation-source-picker"
                role="group"
                aria-label="定时摘要内容来源"
              >
                {AUTOMATION_SOURCE_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    aria-pressed={automationDraft.source_mode === mode.value}
                    className={
                      automationDraft.source_mode === mode.value
                        ? 'is-selected'
                        : ''
                    }
                    onClick={() => {
                      const nextMode = mode.value;
                      setAutomationDraft((current) => {
                        const shouldRefreshInstruction = current.instruction === defaultAutomationInstruction(
                          current.source_mode,
                        );
                        return {
                          ...current,
                          source_mode: nextMode,
                          instruction: shouldRefreshInstruction
                            ? defaultAutomationInstruction(nextMode)
                            : current.instruction,
                        };
                      });
                    }}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
              <small className="video-agent-automation-field-note">
                默认总结收藏内容。
              </small>
            </fieldset>

            <label>
              <span>注册邮箱</span>
              <input
                type="email"
                value={automationDraft.recipient_email}
                readOnly
                aria-readonly="true"
                placeholder="name@example.com"
              />
              <div
                className={`video-agent-email-status ${
                  emailStatus?.email_verified ? 'is-verified' : 'is-pending'
                }`}
              >
                <div>
                  <span aria-hidden="true">
                    {emailStatus?.email_verified ? (
                      <CheckCircle size={16} weight="fill" />
                    ) : (
                      <EnvelopeSimple size={16} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {emailStatusLoading
                        ? '正在读取验证状态'
                        : emailStatus?.email_verified
                          ? '邮箱已验证'
                          : '邮箱待验证'}
                    </strong>
                    <small>
                      {emailStatus?.email_verified
                        ? '定时摘要生成后，会提交到这个注册邮箱。'
                        : emailStatus && !emailStatus.delivery.configured
                          ? '邮件服务尚未启用；摘要仍会生成并保存在知萃中。'
                          : '验证后，定时摘要才会提交到这个注册邮箱。'}
                    </small>
                  </div>
                </div>
                {!emailStatusLoading && !emailStatus?.email_verified && (
                  <button
                    type="button"
                    disabled={
                      emailVerificationSending
                      || !emailStatus?.delivery.configured
                    }
                    onClick={() => void requestEmailVerification()}
                  >
                    {emailVerificationSending ? (
                      <ArrowClockwise size={14} className="animate-spin" />
                    ) : (
                      <EnvelopeSimple size={14} />
                    )}
                    {emailVerificationSending ? '正在提交' : '发送验证邮件'}
                  </button>
                )}
              </div>
              {emailVerificationFeedback && (
                <small
                  className={`video-agent-email-feedback is-${emailVerificationFeedback.tone}`}
                  role={emailVerificationFeedback.tone === 'error' ? 'alert' : 'status'}
                >
                  {emailVerificationFeedback.message}
                </small>
              )}
              <small className="video-agent-automation-field-note">
                为保护账号安全，当前只使用你的知萃注册邮箱。
              </small>
            </label>

            <label>
              <span>摘要要求</span>
              <textarea
                rows={4}
                maxLength={1000}
                value={automationDraft.instruction}
                onChange={(event) => setAutomationDraft((current) => ({
                  ...current,
                  instruction: event.target.value,
                }))}
              />
            </label>

            <button
              type="submit"
              className="video-agent-automation-save"
              disabled={automationSaving}
            >
              {automationSaving ? (
                <ArrowClockwise size={16} className="animate-spin" />
              ) : editingAutomationId ? (
                <CheckCircle size={16} weight="fill" />
              ) : (
                <Plus size={16} weight="bold" />
              )}
              {automationSaving
                ? '正在保存'
                : editingAutomationId
                  ? '保存调整'
                  : '创建定时摘要'}
            </button>
          </form>

          <div className="video-agent-automation-list">
            <header>
              <strong>已有任务</strong>
              <span>{automations.length} 个</span>
            </header>
            {automationsLoading ? (
              <div className="video-agent-rail-state">
                <ArrowClockwise size={17} className="animate-spin" />
                正在读取定时摘要
              </div>
            ) : automations.length === 0 ? (
              <div className="video-agent-automation-empty">
                <CalendarBlank size={24} />
                <strong>还没有定时摘要</strong>
                <span>先创建一个摘要任务。</span>
              </div>
            ) : (
              automations.map((automation) => (
                <article
                  key={automation.id}
                  className={!automation.enabled ? 'is-paused' : ''}
                >
                  {(() => {
                    const latestRun = automationRuns[automation.id];
                    return latestRun ? (
                      <div className="video-agent-automation-run">
                        <div>
                          <span className={`is-${latestRun.status}`} />
                          <strong>{automationRunStatus(latestRun)}</strong>
                          <small>{automationDeliveryStatus(latestRun)}</small>
                        </div>
                        {latestRun.result_text && (
                          <p>{latestRun.result_text}</p>
                        )}
                        {latestRun.delivery_error && (
                          <p className="is-error">{latestRun.delivery_error}</p>
                        )}
                        {latestRun.agent_thread_id && (
                          <a href={`/harness?thread=${encodeURIComponent(latestRun.agent_thread_id)}`}>
                            继续这次对话
                            <CaretRight size={13} />
                          </a>
                        )}
                      </div>
                    ) : null;
                  })()}
                  <div className="video-agent-automation-card-heading">
                    <div>
                      <span className={automation.enabled ? 'is-on' : ''} />
                      <strong>{automation.name}</strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => void toggleAutomation(automation)}
                    >
                      {automation.enabled ? '运行中' : '已暂停'}
                    </button>
                  </div>
                  <p>
                    {sourceScopeLabel(automation.source_scope)}
                    {' · '}
                    {automationSourceModeLabel(automation.source_mode || 'collect')}
                  </p>
                  <dl>
                    <div>
                      <dt>每天</dt>
                      <dd>{automation.schedule_time}</dd>
                    </div>
                    <div>
                      <dt>发送到</dt>
                      <dd>{automation.recipient_email}</dd>
                    </div>
                    <div>
                      <dt>上次运行</dt>
                      <dd>{formatCompactTime(automation.last_run_at)}</dd>
                    </div>
                  </dl>
                  <div className="video-agent-automation-card-actions">
                    <button type="button" onClick={() => editAutomation(automation)}>
                      <PencilSimple size={14} />
                      调整
                    </button>
                    <button
                      type="button"
                      disabled={runningAutomationId === automation.id}
                      onClick={() => void runAutomationNow(automation.id)}
                    >
                      {runningAutomationId === automation.id ? (
                        <ArrowClockwise size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} weight="fill" />
                      )}
                      立即生成一次
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setPendingThreadDelete(null);
                        setPendingAutomationDelete(automation.id);
                      }}
                    >
                      <Trash size={14} />
                      删除
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
      <AgentSourceSyncSheet
        open={sourceSyncOpen}
        onClose={() => setSourceSyncOpen(false)}
        onSynced={() => loadSources(browseScope)}
        onManageSources={() => {
          setSourceSyncOpen(false);
          enterRemoveSelectionMode();
        }}
        onBackgrounded={(message) => setNotice(message)}
        onCompleted={(message, success) => {
          setNotice(success ? message : `后台同步未完成 · ${message}`);
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(success ? '视频文稿已准备完成' : '视频同步需要处理', {
              body: message,
              icon: '/icons/icon-192.png',
            });
          }
        }}
      />
      <NativeModal
        open={Boolean(threadDeleteTarget || automationDeleteTarget)}
        title={threadDeleteTarget ? '删除会话' : '删除定时摘要'}
        onClose={closeDeleteConfirmation}
        className={`video-agent-delete-dialog ${destructivePending ? 'is-pending' : ''}`}
      >
        <div className="video-agent-delete-confirm">
          <p>
            {threadDeleteTarget
              ? `删除“${threadDeleteTarget.title || '未命名会话'}”后，该会话和对话记录将无法恢复。`
              : automationDeleteTarget
                ? `删除“${automationDeleteTarget.name}”后，将不再按计划生成摘要，且无法恢复。`
                : ''}
          </p>
          <div>
            <button
              type="button"
              onClick={closeDeleteConfirmation}
              disabled={destructivePending}
            >
              取消
            </button>
            <button
              type="button"
              className="is-danger"
              disabled={destructivePending}
              onClick={() => {
                if (threadDeleteTarget) void removeThread(threadDeleteTarget.id);
                else if (automationDeleteTarget) void removeAutomation(automationDeleteTarget.id);
              }}
            >
              {destructivePending && <ArrowClockwise size={15} className="animate-spin" />}
              {destructivePending ? '正在删除' : '确认删除'}
            </button>
          </div>
        </div>
      </NativeModal>
    </div>
  );
}
