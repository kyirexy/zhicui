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
  ArrowClockwise,
  CalendarBlank,
  CaretRight,
  ChatsCircle,
  CheckCircle,
  Clock,
  ClockCounterClockwise,
  EnvelopeSimple,
  FileText,
  FolderOpen,
  MagnifyingGlass,
  PaperPlaneTilt,
  PencilSimple,
  Play,
  Plus,
  SidebarSimple,
  SlidersHorizontal,
  Stop,
  Trash,
  VideoCamera,
  X,
} from '@phosphor-icons/react';
import AgentMark from '@/components/agent/AgentMark';
import AgentOptionsSheet from '@/components/agent/AgentOptionsSheet';
import AgentMessageView from '@/components/agent/AgentMessageView';
import type { AgentMessageDeliveryState } from '@/components/agent/AgentMessageView';
import styles from '@/components/agent/AgentWorkspace.module.css';
import {
  createAgentAutomation,
  createAgentThread,
  confirmAgentEmailVerification,
  deleteAgentAutomation,
  deleteAgentThread,
  getAgentThread,
  getAgentEmailStatus,
  listAgentAutomationRuns,
  listAgentAutomations,
  listAgentSources,
  listAgentThreads,
  runAgentAutomation,
  sendAgentEmailVerification,
  sendAgentMessage,
  updateAgentAutomation,
} from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
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
  AgentThread,
  LibraryOutputStyle,
  LibraryResearchMode,
  ResearchScope,
} from '@/lib/types';

const MAX_SELECTED_SOURCES = 100;

const SOURCE_SCOPES: Array<{
  value: AgentSourceScope;
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
  {
    value: 'selected',
    label: '手选',
    description: '最多选择 100 条视频',
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

export default function VideoAgentWorkspace() {
  const { user } = useAuth();
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [activeThread, setActiveThread] = useState<AgentThread | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [messageDeliveryStates, setMessageDeliveryStates] = useState<
    Record<string, AgentMessageDeliveryState>
  >({});
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState(false);

  const [draftScope, setDraftScope] = useState<AgentSourceScope>('all_ready');
  const [sources, setSources] = useState<AgentSource[]>([]);
  const [sourceCount, setSourceCount] = useState(0);
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceError, setSourceError] = useState('');
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());

  const [question, setQuestion] = useState('');
  const [researchMode, setResearchMode] = useState<LibraryResearchMode>('fast');
  const [outputStyle, setOutputStyle] = useState<LibraryOutputStyle>('answer');
  const [webScope, setWebScope] = useState<ResearchScope>('auto');
  const [customInstruction, setCustomInstruction] = useState('');
  const [sending, setSending] = useState(false);
  const [backgroundThreadId, setBackgroundThreadId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingThreadDelete, setPendingThreadDelete] = useState<string | null>(null);

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
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const questionRef = useRef<HTMLTextAreaElement | null>(null);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);
  const historyCloseRef = useRef<HTMLButtonElement | null>(null);
  const historyWasOpenRef = useRef(false);
  const sourcesCloseRef = useRef<HTMLButtonElement | null>(null);
  const lastSourcesTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcesWereOpenRef = useRef(false);

  const loadThreads = useCallback(async (selectFirst = false) => {
    setThreadsLoading(true);
    const response = await listAgentThreads();
    setThreadsLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法读取视频 Agent 任务');
      return;
    }
    const nextThreads = response.data.items || [];
    setThreads(nextThreads);
    if (selectFirst && !activeThread && nextThreads[0]) {
      const detailResponse = await getAgentThread(nextThreads[0].id);
      if (detailResponse.success && detailResponse.data) {
        setActiveThread(detailResponse.data);
        setMessages(detailResponse.data.messages || []);
        setMessageDeliveryStates({});
        if (detailResponse.data.status === 'running') {
          setBackgroundThreadId(detailResponse.data.id);
        }
      }
    }
  }, [activeThread]);

  const loadSources = useCallback(async (
    scope: AgentSourceScope,
    query: string,
  ) => {
    const requestScope = scope === 'selected' ? 'all_ready' : scope;
    setSourceLoading(true);
    setSourceError('');
    const response = await listAgentSources(requestScope, query);
    setSourceLoading(false);
    if (!response.success || !response.data) {
      setSources([]);
      setSourceCount(0);
      setSourceError(response.error || '暂时无法读取可用视频资料');
      return;
    }
    setSources(response.data.items || []);
    setSourceCount(response.data.ready_count ?? response.data.total ?? 0);
  }, []);

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
    const requestedThreadId = new URLSearchParams(window.location.search).get('thread');
    if (!requestedThreadId) {
      void loadThreads(true);
      return;
    }

    void loadThreads(false);
    let active = true;
    setThreadLoading(true);
    void getAgentThread(requestedThreadId).then((response) => {
      if (!active) return;
      setThreadLoading(false);
      if (!response.success || !response.data) {
        setError(response.error || '邮件摘要关联的任务暂时无法打开');
        return;
      }
      setActiveThread(response.data);
      setMessages(response.data.messages || []);
      setMessageDeliveryStates({});
      setDraftScope(response.data.source_scope);
      setSelectedSourceIds(new Set(response.data.source_ids || []));
      if (response.data.status === 'running') {
        setBackgroundThreadId(response.data.id);
      }
    });
    return () => {
      active = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSources(draftScope, sourceQuery);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [draftScope, loadSources, sourceQuery]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 959px)');
    const updateViewport = () => setIsMobile(media.matches);
    updateViewport();
    media.addEventListener('change', updateViewport);
    return () => media.removeEventListener('change', updateViewport);
  }, []);

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
    if (!isMobile) {
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
  }, [isMobile, sourcesOpen]);

  useEffect(() => {
    if (!historyOpen && !sourcesOpen && !automationOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setHistoryOpen(false);
      setSourcesOpen(false);
      setAutomationOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [automationOpen, historyOpen, sourcesOpen]);

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
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messageEndRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [messages, sending]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const activeScope = activeThread?.source_scope || draftScope;
  const activeSourceCount = activeThread?.source_count
    ?? (draftScope === 'selected' ? selectedSourceIds.size : sourceCount);
  const canStartDraft = draftScope === 'selected'
    ? selectedSourceIds.size > 0
    : sourceCount > 0;

  const selectedSources = useMemo(
    () => sources.filter((source) => selectedSourceIds.has(source.note_id)),
    [selectedSourceIds, sources],
  );

  const openThread = async (threadId: string) => {
    abortRef.current?.abort();
    setSending(false);
    setThreadLoading(true);
    setError('');
    const response = await getAgentThread(threadId);
    setThreadLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法打开这项任务');
      return;
    }
    setActiveThread(response.data);
    setMessages(response.data.messages || []);
    setMessageDeliveryStates({});
    setDraftScope(response.data.source_scope);
    setSelectedSourceIds(new Set(response.data.source_ids || []));
    if (response.data.status === 'running') {
      setBackgroundThreadId(response.data.id);
    }
    setHistoryOpen(false);
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const startNewTask = (nextScope = draftScope) => {
    if (backgroundThreadId) {
      setNotice('上一条回答仍在后台处理中；完成后会自动更新，再开始新任务。');
      return;
    }
    abortRef.current?.abort();
    setSending(false);
    setActiveThread(null);
    setMessages([]);
    setMessageDeliveryStates({});
    setQuestion('');
    setError('');
    setNotice(`新任务将参考“${sourceScopeLabel(nextScope)}”`);
    setHistoryOpen(false);
    setSourcesOpen(false);
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const chooseDraftScope = (scope: AgentSourceScope) => {
    setDraftScope(scope);
    setSourceQuery('');
    setSourceError('');
    if (activeThread) {
      setNotice('资料范围已准备好，点击“用这个范围开始新任务”后生效，当前对话资料不会被替换。');
    }
  };

  const toggleSource = (noteId: string) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) {
        next.delete(noteId);
        return next;
      }
      if (next.size >= MAX_SELECTED_SOURCES) {
        setNotice(`每个任务最多参考 ${MAX_SELECTED_SOURCES} 条视频`);
        return current;
      }
      next.add(noteId);
      return next;
    });
  };

  const refreshThreadList = useCallback(async () => {
    const response = await listAgentThreads();
    if (response.success && response.data) {
      setThreads(response.data.items || []);
    }
  }, []);

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
        setMessages(response.data.messages || []);
        setMessageDeliveryStates({});
      }

      if (response.data.status === 'running') {
        timer = window.setTimeout(pollThread, 2000);
        return;
      }

      setBackgroundThreadId((current) => (
        current === threadId ? null : current
      ));
      setNotice(
        response.data.status === 'ready'
          ? '后台回答已完成，内容已自动更新。'
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

  const submitQuestion = async (
    event?: FormEvent,
    suggestion?: string,
  ) => {
    event?.preventDefault();
    const content = (suggestion ?? question).trim();
    if (!content || sending) return;
    if (backgroundThreadId || activeThread?.status === 'running') {
      if (!backgroundThreadId && activeThread?.id) {
        setBackgroundThreadId(activeThread.id);
      }
      setNotice('上一条回答仍在后台处理中；完成后会自动更新，再继续提问。');
      return;
    }
    if (!activeThread && !canStartDraft) {
      setSourcesOpen(true);
      setError(
        draftScope === 'selected'
          ? '请先选择至少一条已有完整文案的视频'
          : '当前范围还没有可用文案，请先同步视频',
      );
      return;
    }

    setSending(true);
    setError('');
    setNotice('');
    setQuestion('');

    let thread = activeThread;
    if (!thread) {
      const created = await createAgentThread({
        title: content.slice(0, 48),
        source_scope: draftScope,
        source_ids: draftScope === 'selected'
          ? Array.from(selectedSourceIds).slice(0, MAX_SELECTED_SOURCES)
          : undefined,
      });
      if (!created.success || !created.data) {
        setSending(false);
        setQuestion(content);
        setError(created.error || '暂时无法创建视频 Agent 任务');
        return;
      }
      thread = created.data;
      setActiveThread(thread);
      setMessages(thread.messages || []);
    }

    const optimistic = createOptimisticMessage(thread.id, content);
    setMessages((current) => [...current, optimistic]);
    setMessageDeliveryStates((current) => ({
      ...current,
      [optimistic.id]: 'sending',
    }));
    const controller = new AbortController();
    abortRef.current = controller;
    const response = await sendAgentMessage(
      thread.id,
      {
        content,
        research_mode: researchMode,
        output_style: outputStyle,
        custom_instruction: customInstruction,
        web_scope: webScope,
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    setSending(false);
    abortRef.current = null;
    if (!response.success || !response.data) {
      setMessageDeliveryStates((current) => ({
        ...current,
        [optimistic.id]: 'failed',
      }));
      setError(response.error || '视频 Agent 暂时无法回答，请稍后重试');
      return;
    }

    const nextThread = response.data.thread;
    setActiveThread(nextThread);
    setMessageDeliveryStates((current) => {
      const next = { ...current };
      delete next[optimistic.id];
      return next;
    });
    setMessages(
      nextThread.messages?.length
        ? nextThread.messages
        : [
            optimistic,
            response.data.assistant_message,
          ],
    );
    void refreshThreadList();
  };

  const removeOptimisticMessage = (messageId: string) => {
    setMessages((current) => current.filter((message) => message.id !== messageId));
    setMessageDeliveryStates((current) => {
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
    setQuestion(message.content);
    setError('');
    window.requestAnimationFrame(() => questionRef.current?.focus());
  };

  const stopSending = () => {
    const threadId = activeThread?.id;
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
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

  const removeThread = async (threadId: string) => {
    if (pendingThreadDelete !== threadId) {
      setPendingThreadDelete(threadId);
      return;
    }
    const response = await deleteAgentThread(threadId);
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
    if (pendingAutomationDelete !== automationId) {
      setPendingAutomationDelete(automationId);
      return;
    }
    const response = await deleteAgentAutomation(automationId);
    setPendingAutomationDelete(null);
    if (!response.success) {
      setAutomationError(response.error || '删除定时摘要失败');
      return;
    }
    setAutomations((current) => current.filter((item) => item.id !== automationId));
    if (editingAutomationId === automationId) resetAutomationDraft();
  };

  return (
    <div className={`${styles.root} video-agent-page video-agent-refined desktop-core-page`}>
      <div
        className={`video-agent-backdrop ${
          historyOpen || (isMobile && sourcesOpen) || automationOpen
            ? 'is-visible'
            : ''
        }`}
        onClick={() => {
          setHistoryOpen(false);
          setSourcesOpen(false);
          setAutomationOpen(false);
        }}
        aria-hidden="true"
      />

      <section
        className="video-agent-shell"
        aria-label="视频 Agent 工作台"
      >
        <aside
          id="video-agent-history-panel"
          className={`video-agent-history ${historyOpen ? 'is-open' : ''}`}
          role="dialog"
          aria-modal={historyOpen || undefined}
          aria-label="最近视频任务"
          aria-hidden={!historyOpen}
          inert={!historyOpen}
        >
          <header className="video-agent-panel-heading">
            <div>
              <span>视频 Agent</span>
              <strong>最近任务</strong>
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

          <button
            type="button"
            className="video-agent-new-task"
            onClick={() => startNewTask()}
          >
            <Plus size={17} weight="bold" />
            新建视频任务
          </button>

          <div className="video-agent-history-list">
            {threadsLoading ? (
              <div className="video-agent-rail-skeleton" aria-label="正在读取任务">
                <i /><i /><i />
              </div>
            ) : threads.length === 0 ? (
              <div className="video-agent-rail-empty">
                <ChatsCircle size={22} />
                <strong>还没有任务</strong>
                <span>第一次提问后会保存在这里</span>
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
                    className={`video-agent-history-delete ${
                      pendingThreadDelete === thread.id ? 'is-confirming' : ''
                    }`}
                    onClick={() => void removeThread(thread.id)}
                    aria-label={
                      pendingThreadDelete === thread.id
                        ? '再次点击确认删除'
                        : '删除任务'
                    }
                    title={
                      pendingThreadDelete === thread.id
                        ? '再次点击确认删除'
                        : '删除任务'
                    }
                  >
                    <Trash size={14} />
                  </button>
                </article>
              ))
            )}
          </div>

          <button
            type="button"
            className="video-agent-automation-entry"
            onClick={() => setAutomationOpen(true)}
          >
            <ClockCounterClockwise size={18} />
            <span>
              <strong>定时摘要</strong>
              <small>每天生成摘要，可提交到邮箱</small>
            </span>
            <CaretRight size={15} />
          </button>
        </aside>

        <main className="video-agent-main">
          <header className="video-agent-topbar">
            <div className="video-agent-topbar-leading">
              <button
                ref={historyTriggerRef}
                type="button"
                className="video-agent-topbar-icon is-history"
                onClick={() => setHistoryOpen(true)}
                aria-expanded={historyOpen}
                aria-controls="video-agent-history-panel"
                aria-label="打开最近任务"
                title="最近任务"
              >
                <SidebarSimple size={19} />
              </button>
              <span className="video-agent-avatar" aria-hidden="true">
                <AgentMark variant="nav" />
              </span>
              <div>
                <h1>{activeThread?.title || '向你的视频资料提问'}</h1>
                <p>
                  {activeThread
                    ? '本对话使用创建时的资料快照'
                    : '先选择视频资料，再开始提问'}
                </p>
              </div>
            </div>
            <div className="video-agent-topbar-actions">
              <button
                type="button"
                className="is-icon"
                onClick={() => window.dispatchEvent(
                  new CustomEvent('zhicui:open-feedback'),
                )}
                aria-label="提交反馈"
                title="提交反馈"
              >
                <ChatsCircle size={16} />
                <span className="sr-only">反馈</span>
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
                  if (isMobile) {
                    lastSourcesTriggerRef.current = event.currentTarget;
                    setSourcesOpen(true);
                    return;
                  }
                  document
                    .getElementById('video-agent-sources-panel')
                    ?.querySelector<HTMLElement>('button, input')
                    ?.focus();
                }}
                aria-expanded={isMobile ? sourcesOpen : undefined}
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
            </div>
          </header>

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
                <p>只依据你整理进知萃的视频资料</p>
                <h2>问你的收藏，而不是问一个空白 AI</h2>
                <span className="video-agent-welcome-copy">
                  选择全部资料、昨天新整理进知萃的内容，或手选几条视频。
                  回答会标出实际阅读的文案和原文依据。
                </span>
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
                      去视频库同步
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
                  disabled={sending || Boolean(backgroundThreadId)}
                  onFollowUp={(followUp) => {
                    void submitQuestion(undefined, followUp);
                  }}
                  onRetry={retryMessage}
                  onEdit={editMessage}
                />
              ))
            )}

            {sending && (
              <div className="video-agent-thinking" role="status">
                <span><i /><i /><i /></span>
                {researchMode === 'deep'
                  ? '正在分批阅读资料并综合依据'
                  : '正在检索完整文案并组织回答'}
              </div>
            )}
            {!sending && backgroundThreadId && (
              <div className="video-agent-thinking" role="status" aria-live="polite">
                <span><i /><i /><i /></span>
                后台仍在处理上一条回答，完成后会自动更新
              </div>
            )}
            <div ref={messageEndRef} />
          </div>

          <footer className="video-agent-composer-region">
            <form className="video-agent-composer" onSubmit={submitQuestion}>
              <textarea
                ref={questionRef}
                rows={2}
                maxLength={600}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter'
                    && !event.shiftKey
                    && !event.nativeEvent.isComposing
                    && !sending
                    && !backgroundThreadId
                  ) {
                    event.preventDefault();
                    void submitQuestion();
                  }
                }}
                placeholder={
                  sending || backgroundThreadId
                    ? '可以先写下一问，当前回答完成后再发送'
                    : '问这些视频，或让知萃把结论变成计划…'
                }
                aria-label="向视频 Agent 提问"
                aria-describedby="video-agent-composer-hint"
              />

              {outputStyle === 'custom' && (
                <input
                  className="video-agent-custom-instruction"
                  value={customInstruction}
                  maxLength={600}
                  onChange={(event) => setCustomInstruction(event.target.value)}
                  placeholder="写下你希望的结构、重点或语气"
                />
              )}

              <div className="video-agent-composer-toolbar">
                <div className="video-agent-composer-controls">
                  <button
                    type="button"
                    className="video-agent-composer-context"
                    onClick={(event) => {
                      if (isMobile) {
                        lastSourcesTriggerRef.current = event.currentTarget;
                        setSourcesOpen(true);
                        return;
                      }
                      document
                        .getElementById('video-agent-sources-panel')
                        ?.querySelector<HTMLElement>('button, input')
                        ?.focus();
                    }}
                    aria-expanded={isMobile ? sourcesOpen : undefined}
                    aria-controls="video-agent-sources-panel"
                    aria-label={`当前参考${sourceScopeLabel(activeScope)}，共${activeSourceCount}条视频`}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    <span>{sourceScopeLabel(activeScope)}</span>
                    <b>{activeSourceCount}</b>
                  </button>
                  <button
                    type="button"
                    className="video-agent-options-trigger"
                    disabled={sending || Boolean(backgroundThreadId)}
                    onClick={() => setOptionsOpen(true)}
                    aria-label={`调整回答方式：${researchMode === 'deep' ? '深度' : '快速'}，${OUTPUT_LABELS[outputStyle]}，${webScope === 'auto' ? '按需查证' : '仅视频'}`}
                  >
                    <SlidersHorizontal size={16} aria-hidden="true" />
                    <span>回答设置</span>
                    <small>
                      {OUTPUT_LABELS[outputStyle]}
                      {' · '}
                      {webScope === 'auto' ? '按需查证' : '仅视频'}
                    </small>
                  </button>
                </div>
                {sending ? (
                  <button
                    type="button"
                    className="video-agent-send is-stop"
                    onClick={stopSending}
                    aria-label="停止等待，后台继续处理"
                    title="停止等待，后台继续处理"
                  >
                    <Stop size={16} weight="fill" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="video-agent-send"
                    disabled={!question.trim() || Boolean(backgroundThreadId)}
                    aria-label="发送问题"
                  >
                    <PaperPlaneTilt size={17} weight="fill" />
                  </button>
                )}
              </div>
            </form>
            <p id="video-agent-composer-hint">
              回答优先使用视频资料，联网内容会单独标明
            </p>
          </footer>
        </main>

        <aside
          id="video-agent-sources-panel"
          className={`video-agent-sources ${sourcesOpen ? 'is-open' : ''}`}
          role={isMobile ? 'dialog' : undefined}
          aria-modal={isMobile && sourcesOpen ? true : undefined}
          aria-hidden={isMobile ? !sourcesOpen : false}
          inert={isMobile && !sourcesOpen}
        >
          <header className="video-agent-panel-heading">
            <div>
              <span>{activeThread ? '新任务资料' : '资料范围'}</span>
              <strong>
                {activeThread
                  ? '为下一个任务选择资料'
                  : '选择 Agent 要读什么'}
              </strong>
            </div>
            <button
              ref={sourcesCloseRef}
              type="button"
              className="video-agent-mobile-close"
              onClick={() => setSourcesOpen(false)}
              aria-label="关闭资料面板"
            >
              <X size={18} />
            </button>
          </header>

          <div className="video-agent-scope-list" role="group" aria-label="视频资料范围">
            {SOURCE_SCOPES.map((option) => (
              <button
                type="button"
                aria-pressed={draftScope === option.value}
                className={draftScope === option.value ? 'is-active' : ''}
                key={option.value}
                onClick={() => chooseDraftScope(option.value)}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                <i aria-hidden="true" />
              </button>
            ))}
          </div>

          {draftScope === 'selected' && (
            <label className="video-agent-source-search">
              <MagnifyingGlass size={15} />
              <span className="sr-only">搜索视频资料</span>
              <input
                value={sourceQuery}
                onChange={(event) => setSourceQuery(event.target.value)}
                placeholder="搜索标题或作者"
              />
              {sourceQuery && (
                <button
                  type="button"
                  onClick={() => setSourceQuery('')}
                  aria-label="清空搜索"
                >
                  <X size={13} />
                </button>
              )}
            </label>
          )}

          <div className="video-agent-source-summary">
            <span>
              {sourceLoading
                ? '正在读取'
                : `${sourceCount} 个视频文案可用`}
            </span>
            {draftScope === 'selected' && (
              <strong>{selectedSourceIds.size}/{MAX_SELECTED_SOURCES} 已选</strong>
            )}
          </div>

          <div className="video-agent-source-list">
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
                  onClick={() => void loadSources(draftScope, sourceQuery)}
                >
                  重新读取
                </button>
              </div>
            ) : sources.length === 0 ? (
              <div className="video-agent-source-empty">
                <VideoCamera size={22} />
                <strong>这个范围还没有文案</strong>
                <span>从视频库同步后，文案会自动出现在这里。</span>
              </div>
            ) : draftScope !== 'selected' ? (
              <div className="video-agent-source-overview">
                <span className="video-agent-source-overview-icon">
                  <FolderOpen size={22} weight="duotone" />
                </span>
                <strong>{sourceScopeLabel(draftScope)}已连接</strong>
                <p>
                  提问时会自动检索这个范围内的完整视频文案，
                  不需要逐条勾选。
                </p>
                <div>
                  {sources.slice(0, 3).map((source) => (
                    <span key={source.note_id}>
                      <i>
                        <VideoCamera size={13} />
                        {source.cover_url && (
                          <img
                            src={source.cover_url}
                            alt=""
                            loading="lazy"
                            onError={(event) => {
                              event.currentTarget.hidden = true;
                            }}
                          />
                        )}
                      </i>
                      <b>{source.title}</b>
                    </span>
                  ))}
                </div>
                {sourceCount > 3 && (
                  <small>以及另外 {sourceCount - 3} 个视频</small>
                )}
              </div>
            ) : (
              sources.map((source) => {
                const selected = selectedSourceIds.has(source.note_id);
                return (
                  <button
                    type="button"
                    key={source.note_id}
                    className={`video-agent-source-item ${
                      draftScope === 'selected' && selected ? 'is-selected' : ''
                    }`}
                    onClick={() => {
                      toggleSource(source.note_id);
                    }}
                    aria-pressed={selected}
                  >
                    <span className="video-agent-source-cover">
                      <VideoCamera size={17} aria-hidden="true" />
                      {source.cover_url && (
                        <img
                          src={source.cover_url}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.hidden = true;
                          }}
                        />
                      )}
                    </span>
                    <span className="video-agent-source-copy">
                      <strong>{source.title}</strong>
                      <small>
                        {source.author_name || '抖音视频'}
                        {' · '}
                        {source.transcript_chars.toLocaleString('zh-CN')} 字
                      </small>
                    </span>
                    <i aria-hidden="true">
                      {selected && <CheckCircle size={16} weight="fill" />}
                    </i>
                  </button>
                );
              })
            )}
          </div>

          {activeThread ? (
            <button
              type="button"
              className="video-agent-apply-sources"
              disabled={!canStartDraft}
              onClick={() => startNewTask(draftScope)}
            >
              <Plus size={16} weight="bold" />
              用这个范围开始新任务
            </button>
          ) : (
            <button
              type="button"
              className="video-agent-apply-sources"
              disabled={!canStartDraft}
              onClick={() => {
                setSourcesOpen(false);
                setNotice(`已选择“${sourceScopeLabel(draftScope)}”，现在可以直接提问。`);
                window.requestAnimationFrame(() => questionRef.current?.focus());
              }}
            >
              <CheckCircle size={16} weight="fill" />
              使用这个范围
            </button>
          )}
        </aside>
      </section>

      <AgentOptionsSheet
        open={optionsOpen}
        onClose={() => setOptionsOpen(false)}
        researchMode={researchMode}
        outputStyle={outputStyle}
        webScope={webScope}
        disabled={sending || Boolean(backgroundThreadId)}
        onResearchModeChange={setResearchMode}
        onOutputStyleChange={setOutputStyle}
        onWebScopeChange={setWebScope}
      />

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
                默认只总结收藏；需要时可切换到喜欢、我的作品或全部来源。
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
                <span>先建立一个任务，之后可以随时调整。</span>
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
                          <a href={`/agent?thread=${encodeURIComponent(latestRun.agent_thread_id)}`}>
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
                      className={
                        pendingAutomationDelete === automation.id
                          ? 'is-confirming'
                          : 'is-danger'
                      }
                      onClick={() => void removeAutomation(automation.id)}
                    >
                      <Trash size={14} />
                      {pendingAutomationDelete === automation.id ? '确认删除' : '删除'}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
