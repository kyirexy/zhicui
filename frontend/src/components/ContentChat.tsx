'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  ArrowClockwise,
  BookOpenText,
  Brain,
  ChatCircleDots,
  CheckCircle,
  FileText,
  LightbulbFilament,
  ListChecks,
  MagnifyingGlass,
  PaperPlaneTilt,
  Quotes,
  ShieldCheck,
  Sparkle,
  TrashSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { askNote } from '@/lib/api';
import type {
  CardType,
  NoteAnswerMode,
  NoteChatTurn,
  NoteEvidence,
  NoteSourceContext,
} from '@/lib/types';

interface ContentChatProps {
  noteId: string;
  cardType: CardType;
  title?: string;
}

interface ChatMessage extends NoteChatTurn {
  id: string;
  answerMode?: NoteAnswerMode;
  evidence?: NoteEvidence[];
  grounded?: boolean;
  followUps?: string[];
  sourceContext?: NoteSourceContext;
}

interface ActiveRequest {
  id: number;
  controller: AbortController;
}

const MAX_STORED_MESSAGES = 18;

const COMMON_QUESTIONS = [
  '基于完整文稿，用三句话概括最重要的信息',
  '哪些观点需要我进一步验证？',
  '把这段内容整理成行动清单',
];

const TYPE_QUESTIONS: Partial<Record<CardType, string[]>> = {
  recipe: ['把做法整理成按顺序的步骤', '有哪些容易失败的地方？', '原文提到了哪些用量或火候？'],
  insight: ['这个观点的核心逻辑是什么？', '它适用于哪些具体场景？', '有哪些可能的反例或局限？'],
  history: ['按时间线梳理关键事件', '涉及了哪些人物和因果关系？', '哪些细节值得进一步核实？'],
  product: ['总结产品的优点、缺点和适合人群', '原文给出了哪些购买依据？', '有哪些风险或营销话术要注意？'],
  plan: ['我今天最应该先做什么？', '把计划拆成前三个行动', '执行时最容易卡在哪里？'],
};

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
  };
}

function transcriptCoverageLabel(context: NoteSourceContext): string {
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
      answerMode: item.answerMode === 'creative' || item.answerMode === 'grounded'
        ? item.answerMode
        : undefined,
      evidence: Array.isArray(item.evidence) ? item.evidence as NoteEvidence[] : undefined,
      grounded: typeof item.grounded === 'boolean' ? item.grounded : undefined,
      followUps: Array.isArray(item.followUps)
        ? item.followUps.filter((question): question is string => typeof question === 'string')
        : undefined,
      sourceContext: parseSourceContext(item.sourceContext),
    }));
}

export default function ContentChat({ noteId, cardType, title }: ContentChatProps) {
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
  const storageKey = `zhicui_note_chat_${noteId}`;

  const suggestions = useMemo(
    () => TYPE_QUESTIONS[cardType] ?? COMMON_QUESTIONS,
    [cardType],
  );
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
  }, [noteId]);

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
      const response = await askNote(noteId, question, history, controller.signal);
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
    <section className="content-chat" aria-labelledby={`content-chat-${noteId}`}>
      <div className="content-chat__ambient" aria-hidden />
      <div className="content-chat__fixed-head">
        <header className="content-chat__header">
          <span className="content-chat__mark" aria-hidden>
            <ChatCircleDots size={23} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 id={`content-chat-${noteId}`} className="content-chat__title">向完整视频文稿提问</h3>
              <span className="content-chat__grounded">
                <ShieldCheck size={13} weight="duotone" aria-hidden />
                完整文稿 + AI 理解
              </span>
            </div>
            <p className="content-chat__subtitle">
              {title ? `基于《${title}》的完整文稿追问` : '扫描完整视频文稿，并结合 AI 已提炼的卡片信息回答。'}
            </p>
          </div>
          {messages.length > 0 && (
            <button type="button" onClick={clearConversation} className="content-chat__clear" aria-label="清空当前对话">
              <TrashSimple size={16} weight="duotone" aria-hidden />
              <span className="hidden sm:inline">清空</span>
            </button>
          )}
        </header>

        <div className="content-chat__source-contract" aria-label="回答使用的信息来源">
          <span>
            <FileText size={15} weight="duotone" aria-hidden />
            完整视频文稿
          </span>
          <i aria-hidden>+</i>
          <span>
            <Brain size={15} weight="duotone" aria-hidden />
            AI 卡片理解
          </span>
        </div>
      </div>

      <div className="content-chat__scroll-region">
        {messages.length === 0 && (
          <div className="content-chat__suggestions" aria-label="推荐问题">
            {suggestions.map((question, index) => (
              <button
                key={question}
                type="button"
                onClick={() => void submitQuestion(question)}
                className="content-chat__suggestion"
                disabled={sending}
              >
                <span className="content-chat__suggestion-icon" aria-hidden>
                  {index === 0
                    ? <Sparkle size={17} weight="duotone" />
                    : index === 1
                      ? <LightbulbFilament size={17} weight="duotone" />
                      : <ListChecks size={17} weight="duotone" />}
                </span>
                <span>{question}</span>
              </button>
            ))}
          </div>
        )}

        {messages.length > 0 && (
          <div className="content-chat__messages" role="log" aria-live="polite" aria-relevant="additions">
            {messages.map((message) => (
              <article key={message.id} className={`content-chat__message content-chat__message--${message.role}`}>
                <span className="content-chat__role">
                  {message.role === 'user' ? '你' : '知萃'}
                </span>
                <div className="content-chat__bubble">
                  <p>{message.content}</p>
                  {message.role === 'assistant' && (
                    <div className={`content-chat__answer-state ${
                      message.answerMode === 'creative'
                        ? 'is-creative'
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
                          : message.grounded
                            ? '回答依据已核对'
                            : '当前来源的依据不足'}
                      </span>
                    </div>
                  )}
                  {message.role === 'assistant' && message.sourceContext && (
                    <div className="content-chat__source-context" aria-label="本次回答的来源覆盖范围">
                      <span>
                        <MagnifyingGlass size={13} weight="duotone" aria-hidden />
                        {transcriptCoverageLabel(message.sourceContext)}
                      </span>
                      <span className={message.sourceContext.ai_summary_used ? 'is-active' : ''}>
                        <Brain size={13} weight="duotone" aria-hidden />
                        {message.sourceContext.ai_summary_used ? '已融合 AI 卡片理解' : '没有可用的 AI 卡片理解'}
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
                                : 'AI 卡片理解'}
                            </small>
                          </blockquote>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              </article>
            ))}
            {sending && (
              <div className="content-chat__thinking" role="status">
                <span className="content-chat__thinking-icon" aria-hidden><Sparkle size={16} weight="fill" /></span>
                正在扫描完整文稿，并结合 AI 卡片理解
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
            placeholder="基于完整视频文稿提问…"
            aria-label="输入关于完整视频文稿的问题"
            disabled={sending}
          />
          <span className="content-chat__count" aria-hidden>{input.length}/600</span>
          <button type="submit" disabled={!input.trim() || sending} aria-label="发送问题">
            <PaperPlaneTilt size={19} weight="fill" aria-hidden />
          </button>
        </form>
        <p className="content-chat__hint">Enter 发送 · 回答会标明全文覆盖方式和可核对依据</p>
      </div>
    </section>
  );
}
