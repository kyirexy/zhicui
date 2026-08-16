'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowClockwise,
  ArrowSquareOut,
  BookOpenText,
  Brain,
  ChatCircleDots,
  CheckCircle,
  FileText,
  GlobeHemisphereWest,
  MagnifyingGlass,
  PaperPlaneTilt,
  Quotes,
  ShieldCheck,
  Sparkle,
  TrashSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { askNote, askVisualLibraryItem } from '@/lib/api';
import type {
  CardType,
  NoteAnswerMode,
  NoteChatTurn,
  NoteEvidence,
  NoteSourceContext,
  ResearchAgentStage,
  ResearchScope,
  WebResearchSource,
} from '@/lib/types';

interface ContentChatProps {
  noteId?: string;
  cardType?: CardType;
  title?: string;
  visualSource?: {
    itemId: string;
    mediaType: 'gallery' | 'video';
    imageCount?: number;
  };
}

interface ChatMessage extends NoteChatTurn {
  id: string;
  answerMode?: NoteAnswerMode;
  evidence?: NoteEvidence[];
  grounded?: boolean;
  followUps?: string[];
  sourceContext?: NoteSourceContext;
  webSources?: WebResearchSource[];
  agentTrace?: ResearchAgentStage[];
  researchScope?: ResearchScope;
}

interface ActiveRequest {
  id: number;
  controller: AbortController;
}

const MAX_STORED_MESSAGES = 18;

function parseSourceContext(value: unknown): NoteSourceContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const context = value as Partial<NoteSourceContext>;
  if (
    !Number.isFinite(context.transcript_chars)
    || !Number.isFinite(context.scanned_chunks)
    || !Number.isFinite(context.selected_chunks)
    || !['full', 'retrieved', 'none'].includes(context.transcript_mode ?? '')
    || typeof context.ai_summary_used !== 'boolean'
  ) {
    return undefined;
  }
  return {
    transcript_chars: Number(context.transcript_chars),
    transcript_mode: context.transcript_mode as NoteSourceContext['transcript_mode'],
    scanned_chunks: Number(context.scanned_chunks),
    selected_chunks: Number(context.selected_chunks),
    ai_summary_used: context.ai_summary_used,
    research_scope: context.research_scope === 'video_only' ? 'video_only' : 'auto',
    web_search_used: Boolean(context.web_search_used),
    web_query_count: Number(context.web_query_count || 0),
    web_source_count: Number(context.web_source_count || 0),
    agent_trace: Array.isArray(context.agent_trace)
      ? context.agent_trace as ResearchAgentStage[]
      : [],
    source_mode: context.source_mode === 'visual' ? 'visual' : 'text',
    media_type: context.media_type === 'gallery' ? 'gallery' : context.media_type === 'video' ? 'video' : undefined,
    visual_evidence_count: Number(context.visual_evidence_count || 0),
  };
}

function transcriptCoverageLabel(context: NoteSourceContext): string {
  if (context.source_mode === 'visual') {
    const count = context.visual_evidence_count || 0;
    return context.media_type === 'gallery'
      ? `已读取 ${count} 张图集图片`
      : `已读取 ${count} 张视频画面`;
  }
  const size = context.transcript_chars.toLocaleString('zh-CN');
  if (context.transcript_mode === 'full') {
    return `完整文稿 ${size} 字已直接阅读`;
  }
  if (context.transcript_mode === 'retrieved') {
    return `已扫描完整文稿 ${size} 字（${context.scanned_chunks} 段），选取 ${context.selected_chunks} 段相关原文`;
  }
  return '当前内容没有可用的视频文稿';
}

function parseStoredMessages(value: string): ChatMessage[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => (
      typeof item.id === 'string'
      && (item.role === 'user' || item.role === 'assistant')
      && typeof item.content === 'string'
    ))
    .slice(-MAX_STORED_MESSAGES)
    .map((item) => ({
      id: item.id as string,
      role: item.role as ChatMessage['role'],
      content: item.content as string,
      answerMode: item.answerMode === 'creative' || item.answerMode === 'grounded' || item.answerMode === 'visual'
        ? item.answerMode
        : undefined,
      evidence: Array.isArray(item.evidence) ? item.evidence as NoteEvidence[] : undefined,
      grounded: typeof item.grounded === 'boolean' ? item.grounded : undefined,
      followUps: Array.isArray(item.followUps)
        ? item.followUps.filter((question): question is string => typeof question === 'string')
        : undefined,
      sourceContext: parseSourceContext(item.sourceContext),
      webSources: Array.isArray(item.webSources)
        ? item.webSources as WebResearchSource[]
        : [],
      agentTrace: Array.isArray(item.agentTrace)
        ? item.agentTrace as ResearchAgentStage[]
        : [],
      researchScope: item.researchScope === 'video_only' ? 'video_only' : 'auto',
    }));
}

export default function ContentChat({ noteId, title, visualSource }: ContentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [lastQuestion, setLastQuestion] = useState('');
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const nextId = useRef(1);
  const requestSequence = useRef(0);
  const activeRequest = useRef<ActiveRequest | null>(null);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const sourceKey = noteId || visualSource?.itemId || 'unknown';
  const isVisual = Boolean(visualSource && !noteId);
  const storageKey = isVisual
    ? `zhicui_visual_chat_${sourceKey}`
    : `zhicui_note_chat_${sourceKey}`;

  const researchScope: ResearchScope = 'video_only';
  const followUpSuggestions = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant' && message.followUps?.length) {
        return message.followUps;
      }
    }
    return [];
  }, [messages]);

  useEffect(() => () => {
    requestSequence.current += 1;
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
  }, [sourceKey]);

  useEffect(() => {
    setRestoredKey(null);
    setInput('');
    setSending(false);
    setError('');
    setLastQuestion('');
    try {
      const stored = sessionStorage.getItem(storageKey);
      setMessages(stored ? parseStoredMessages(stored) : []);
    } catch {
      sessionStorage.removeItem(storageKey);
      setMessages([]);
    } finally {
      setRestoredKey(storageKey);
    }
  }, [storageKey]);

  useEffect(() => {
    if (restoredKey !== storageKey) return;
    try {
      if (messages.length === 0) {
        sessionStorage.removeItem(storageKey);
        return;
      }
      sessionStorage.setItem(
        storageKey,
        JSON.stringify(messages.slice(-MAX_STORED_MESSAGES)),
      );
    } catch {
      // Storage may be unavailable or full; the in-memory conversation remains usable.
    }
  }, [messages, restoredKey, storageKey]);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    messageEndRef.current?.scrollIntoView({
      block: 'nearest',
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
  }, [messages, sending]);

  const createMessageId = () => `${Date.now()}-${nextId.current++}`;

  const submitQuestion = async (rawQuestion: string, appendUser = true) => {
    const question = rawQuestion.trim();
    if (!question || sending) return;

    let history: NoteChatTurn[] = messages.map(({ role, content }) => ({ role, content }));
    if (!appendUser) {
      const last = history[history.length - 1];
      if (last?.role === 'user' && last.content === question) history = history.slice(0, -1);
    }
    history = history.slice(-6);

    if (appendUser) {
      setMessages((prev) => [
        ...prev,
        { id: createMessageId(), role: 'user', content: question },
      ]);
    }
    setInput('');
    setError('');
    setLastQuestion(question);
    setSending(true);

    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    const controller = new AbortController();
    activeRequest.current = { id: requestId, controller };

    try {
      const response = isVisual && visualSource
        ? await askVisualLibraryItem(
            visualSource.itemId,
            question,
            history,
            controller.signal,
          )
        : await askNote(
            noteId!,
            question,
            history,
            controller.signal,
            researchScope,
          );
      if (requestSequence.current !== requestId) return;

      const answer = response.data;
      if (response.success && answer?.answer) {
        setMessages((prev) => [
          ...prev,
          {
            id: createMessageId(),
            role: 'assistant',
            content: answer.answer,
            answerMode: answer.answer_mode ?? 'grounded',
            evidence: answer.evidence ?? [],
            grounded: answer.grounded,
            followUps: answer.follow_up_questions ?? [],
            sourceContext: parseSourceContext(answer.source_context),
            webSources: answer.web_sources ?? [],
            agentTrace: answer.agent_trace ?? [],
            researchScope: answer.research_scope === 'visual_only'
              ? 'video_only'
              : answer.research_scope ?? researchScope,
          },
        ]);
        setLastQuestion('');
      } else {
        setError(response.error || '暂时没有得到回答，请稍后重试。');
      }
    } finally {
      if (requestSequence.current === requestId) {
        activeRequest.current = null;
        setSending(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitQuestion(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (input.trim()) void submitQuestion(input);
    }
  };

  const clearConversation = () => {
    requestSequence.current += 1;
    activeRequest.current?.controller.abort();
    activeRequest.current = null;
    setMessages([]);
    setInput('');
    setSending(false);
    setError('');
    setLastQuestion('');
    sessionStorage.removeItem(storageKey);
  };

  return (
    <section className="content-chat" aria-labelledby={`content-chat-${sourceKey}`}>
      <div className="content-chat__ambient" aria-hidden />
      <div className="content-chat__fixed-head">
        <header className="content-chat__header">
          <span className="content-chat__mark" aria-hidden>
            <ChatCircleDots size={23} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 id={`content-chat-${sourceKey}`} className="content-chat__title">
                {isVisual ? '问问这组图片' : '向完整视频文稿提问'}
              </h3>
              {!isVisual && <span className="content-chat__grounded">
                <ShieldCheck size={13} weight="duotone" aria-hidden />
                完整文稿优先
              </span>}
            </div>
            {!isVisual && <p className="content-chat__subtitle">
              {title ? `基于《${title}》的完整文稿追问` : '读取完整视频文稿；摘要笔记只在已有时辅助理解。'}
            </p>}
          </div>
          {messages.length > 0 && (
            <button type="button" onClick={clearConversation} className="content-chat__clear" aria-label="清空当前对话">
              <TrashSimple size={16} weight="duotone" aria-hidden />
              <span className="hidden sm:inline">清空</span>
            </button>
          )}
        </header>

        {!isVisual && <div className="content-chat__source-contract" aria-label="回答使用的信息来源">
          <span>
            <FileText size={15} weight="duotone" aria-hidden />
            完整视频文稿
          </span>
          <i aria-hidden>+</i>
          <span>
            <Brain size={15} weight="duotone" aria-hidden />
            可选摘要笔记
          </span>
        </div>}
      </div>

      <div className="content-chat__scroll-region">
        {messages.length > 0 && (
          <div className="content-chat__messages" role="log" aria-live="polite" aria-relevant="additions">
            {messages.map((message) => (
              <article key={message.id} className={`content-chat__message content-chat__message--${message.role}`}>
                <span className="content-chat__role">
                  {message.role === 'user' ? '你' : '知萃'}
                </span>
                <div className="content-chat__bubble">
                  <p>{message.content}</p>
                  {message.role === 'assistant' && message.answerMode !== 'visual' && (
                    <div className={`content-chat__answer-state ${
                      message.answerMode === 'creative'
                        ? 'is-creative'
                        : message.webSources?.length
                          ? 'is-researched'
                        : message.grounded
                          ? 'is-grounded'
                          : 'is-limited'
                    }`}>
                      {message.answerMode === 'creative'
                        ? <Sparkle size={14} weight="fill" aria-hidden />
                        : message.grounded
                          ? <CheckCircle size={14} weight="fill" aria-hidden />
                          : <WarningCircle size={14} weight="fill" aria-hidden />}
                      <span>
                        {message.answerMode === 'creative'
                          ? 'AI 生成示例 · 非原文内容'
                          : message.webSources?.length
                            ? `已联网查证 ${message.webSources.length} 个来源`
                          : message.grounded
                            ? '回答依据已核对'
                            : '当前来源的依据不足'}
                      </span>
                    </div>
                  )}
                  {message.role === 'assistant' && message.answerMode !== 'visual' && message.agentTrace && message.agentTrace.length > 0 && (
                    <div className="content-chat__agent-trace" aria-label="Agent 执行过程">
                      {message.agentTrace.map((stage) => (
                        <span key={`${stage.stage}-${stage.label}`} title={stage.detail}>
                          <i aria-hidden />
                          {stage.label}
                        </span>
                      ))}
                    </div>
                  )}
                  {message.role === 'assistant' && message.answerMode !== 'visual' && message.sourceContext && (
                    <div className="content-chat__source-context" aria-label="本次回答的来源覆盖范围">
                      <span>
                        <MagnifyingGlass size={13} weight="duotone" aria-hidden />
                        {transcriptCoverageLabel(message.sourceContext)}
                      </span>
                      <span className={message.sourceContext.ai_summary_used ? 'is-active' : ''}>
                        <Brain size={13} weight="duotone" aria-hidden />
                        {message.sourceContext.source_mode === 'visual'
                          ? '未使用或伪造文案'
                          : message.sourceContext.ai_summary_used ? '已参考摘要笔记' : '仅依据完整文稿'}
                      </span>
                    </div>
                  )}
                  {message.role === 'assistant' && message.evidence && message.evidence.length > 0 && (
                    <details className="content-chat__evidence">
                      <summary>
                        <BookOpenText size={15} weight="duotone" aria-hidden />
                        查看 {message.evidence.length} 条原文依据
                      </summary>
                      <div className="content-chat__evidence-list">
                        {message.evidence.map((item, index) => (
                          <blockquote key={`${item.source}-${item.quote}-${index}`}>
                            <Quotes size={14} weight="fill" aria-hidden />
                            <span>{item.quote}</span>
                            <small>
                              {item.source === 'transcript'
                                ? typeof item.position_percent === 'number'
                                  ? `视频转录 · 文稿约 ${item.position_percent}% 处`
                                  : '视频转录原文'
                                : '摘要笔记'}
                            </small>
                          </blockquote>
                        ))}
                      </div>
                    </details>
                  )}
                  {message.role === 'assistant' && message.webSources && message.webSources.length > 0 && (
                    <section className="content-chat__web-sources" aria-label="外部查证来源">
                      <header>
                        <GlobeHemisphereWest size={16} weight="duotone" aria-hidden />
                        <strong>外部查证</strong>
                        <span>与视频原文分开</span>
                      </header>
                      <div>
                        {message.webSources.map((source) => (
                          <a
                            key={`${source.id}-${source.url}`}
                            href={source.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span>
                              <strong>{source.title}</strong>
                              <small>{source.domain}{source.verified ? ' · 已读取页面' : ' · 搜索摘要'}</small>
                            </span>
                            <ArrowSquareOut size={15} weight="bold" aria-hidden />
                          </a>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </article>
            ))}
            {sending && (
              <div className="content-chat__thinking" role="status">
                <span className="content-chat__thinking-icon" aria-hidden>
                  <Sparkle size={16} weight="fill" />
                </span>
                {isVisual
                  ? '正在识别图片'
                  : '正在阅读完整文稿'}
                <span className="content-chat__dots" aria-hidden><i /><i /><i /></span>
              </div>
            )}
            <div ref={messageEndRef} aria-hidden />
          </div>
        )}

        {messages.length > 0 && followUpSuggestions.length > 0 && !sending && (
          <div className="content-chat__follow-ups" aria-label="继续追问">
            <span>继续追问</span>
            <div>
              {followUpSuggestions.map((question) => (
                <button key={question} type="button" onClick={() => void submitQuestion(question)}>
                  {question}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="content-chat__error" role="alert">
            <span>{error}</span>
            {lastQuestion && (
              <button type="button" onClick={() => void submitQuestion(lastQuestion, false)} disabled={sending}>
                <ArrowClockwise size={14} weight="bold" aria-hidden />
                重试
              </button>
            )}
          </div>
        )}
      </div>

      <div className="content-chat__composer-dock">
        <form onSubmit={handleSubmit} className="content-chat__composer">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value.slice(0, 600))}
            onKeyDown={handleKeyDown}
            rows={1}
            maxLength={600}
            placeholder={isVisual ? '问问图片内容…' : '基于完整视频文稿提问…'}
            aria-label={isVisual ? '输入关于当前作品图片的问题' : '输入关于完整视频文稿的问题'}
            disabled={sending}
          />
          <span className="content-chat__count" aria-hidden>{input.length}/600</span>
          <button type="submit" disabled={!input.trim() || sending} aria-label="发送问题">
            <PaperPlaneTilt size={19} weight="fill" aria-hidden />
          </button>
        </form>
      </div>
    </section>
  );
}
