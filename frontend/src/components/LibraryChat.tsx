'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  FileSearch,
  ExternalLink,
  Globe2,
  Layers3,
  LoaderCircle,
  Send,
  SlidersHorizontal,
  Sparkles,
  Video,
  Workflow,
} from 'lucide-react';
import { askVideoLibrary } from '@/lib/api';
import type {
  LibraryAskResult,
  LibraryOutputStyle,
  LibraryResearchMode,
  NoteChatTurn,
  ResearchScope,
} from '@/lib/types';

export interface LibraryChatSource {
  noteId: string;
  title: string;
  transcriptChars: number;
}

interface LibraryChatProps {
  allSources: LibraryChatSource[];
  selectedSources: LibraryChatSource[];
  selectedCount: number;
}

type LibraryChatScope = 'all' | 'selected';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  result?: LibraryAskResult;
}

const STARTERS = [
  '这些视频反复强调的核心观点是什么？',
  '不同视频之间有哪些共同点和分歧？',
];

export default function LibraryChat({
  allSources,
  selectedSources,
  selectedCount,
}: LibraryChatProps) {
  const [scope, setScope] = useState<LibraryChatScope>('all');
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [researchMode, setResearchMode] = useState<LibraryResearchMode>('fast');
  const [outputStyle, setOutputStyle] = useState<LibraryOutputStyle>('answer');
  const [customInstruction, setCustomInstruction] = useState('');
  const [webScope, setWebScope] = useState<ResearchScope>('auto');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const sources = scope === 'all' ? allSources : selectedSources;
  const sourceKey = `${scope}:${sources.map((source) => source.noteId).sort().join(',')}`;
  const transcriptChars = sources.reduce(
    (total, source) => total + source.transcriptChars,
    0,
  );

  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError('');
    setLoading(false);
  }, [sourceKey]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const history = useMemo<NoteChatTurn[]>(
    () => messages.map(({ role, content }) => ({ role, content })).slice(-6),
    [messages],
  );

  const submitQuestion = async (event?: FormEvent, suggestion?: string) => {
    event?.preventDefault();
    const cleanQuestion = (suggestion ?? question).trim();
    if (!cleanQuestion || loading || sources.length === 0) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: cleanQuestion,
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion('');
    setError('');
    setLoading(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const response = await askVideoLibrary(
      sources.map((source) => source.noteId),
      cleanQuestion,
      history,
      controller.signal,
      {
        researchMode,
        outputStyle,
        customInstruction,
        webScope,
      },
    );
    if (controller.signal.aborted) return;
    setLoading(false);
    if (!response.success || !response.data) {
      setError(response.error || 'AI 暂时无法回答，请稍后重试');
      return;
    }
    setMessages((current) => [
      ...current,
      {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: response.data!.answer,
        result: response.data,
      },
    ]);
  };

  return (
    <section className="library-chat" aria-label="基于视频文案问 AI">
      <header className="library-chat-header">
        <span className="library-chat-mark" aria-hidden="true">
          <Sparkles size={17} />
        </span>
        <div>
          <h2>基于文案问 AI</h2>
          <p>完整文案就能直接提问；已有知识卡时再辅助理解</p>
        </div>
      </header>

      <div className="library-chat-scope" role="group" aria-label="问答视频范围">
        <button
          type="button"
          className={scope === 'all' ? 'is-active' : ''}
          aria-pressed={scope === 'all'}
          disabled={loading}
          onClick={() => setScope('all')}
        >
          <Layers3 size={15} />
          <span>
            <strong>全部已有文案</strong>
            <small>无需勾选 · {allSources.length} 条</small>
          </span>
        </button>
        <button
          type="button"
          className={scope === 'selected' ? 'is-active' : ''}
          aria-pressed={scope === 'selected'}
          disabled={loading}
          onClick={() => setScope('selected')}
        >
          <CheckSquare2 size={15} />
          <span>
            <strong>仅勾选视频</strong>
            <small>{selectedSources.length}/{selectedCount} 条有文案</small>
          </span>
        </button>
      </div>

      <div className="library-chat-coverage">
        <span>
          <Video size={13} />
          {scope === 'all'
            ? `${sources.length} 条可问`
            : `${sources.length}/${selectedCount} 条可问`}
        </span>
        <span>
          <FileSearch size={13} />
          {transcriptChars.toLocaleString('zh-CN')} 字文案
        </span>
      </div>

      <details className="library-agent-settings">
        <summary>
          <SlidersHorizontal size={13} />
          <span>回答设置</span>
          <small>{researchMode === 'deep' ? '深度研究' : '快速研究'} · {
            outputStyle === 'answer' ? '直接回答'
              : outputStyle === 'summary' ? '全局总结'
                : outputStyle === 'comparison' ? '差异对比'
                  : outputStyle === 'action_plan' ? '行动方案'
                    : '自定义'
          } · {webScope === 'auto' ? '自动查证' : '仅视频'}</small>
          <ChevronDown size={13} />
        </summary>
        <div className="library-agent-controls">
          <label>
            <span><Workflow size={12} />研究模式</span>
            <select
              value={researchMode}
              disabled={loading}
              onChange={(event) => setResearchMode(event.target.value as LibraryResearchMode)}
            >
              <option value="fast">快速 · 规划 + 全局检索</option>
              <option value="deep">深度 · 分批研究 + 综合</option>
            </select>
          </label>
          <label>
            <span><SlidersHorizontal size={12} />输出形式</span>
            <select
              value={outputStyle}
              disabled={loading}
              onChange={(event) => setOutputStyle(event.target.value as LibraryOutputStyle)}
            >
              <option value="answer">直接回答</option>
              <option value="summary">全局总结</option>
              <option value="comparison">差异对比</option>
              <option value="action_plan">行动方案</option>
              <option value="custom">自定义</option>
            </select>
          </label>
          <label>
            <span><Globe2 size={12} />外部查证</span>
            <select
              value={webScope}
              disabled={loading}
              onChange={(event) => setWebScope(event.target.value as ResearchScope)}
            >
              <option value="auto">自动 · 缺信息时联网</option>
              <option value="video_only">仅视频 · 不访问网页</option>
            </select>
          </label>
          {(outputStyle === 'custom' || customInstruction) && (
            <label className="library-agent-custom">
              <span>定制要求</span>
              <input
                value={customInstruction}
                maxLength={600}
                disabled={loading}
                onChange={(event) => setCustomInstruction(event.target.value)}
                placeholder="例如：按产品、受众、证据强度分组"
              />
            </label>
          )}
          {researchMode === 'deep' && (
            <p className="library-agent-mode-note">
              <Layers3 size={12} />
              深度模式会把来源分批研究后再综合，覆盖更多视频，但耗时和模型调用更多。
            </p>
          )}
        </div>
      </details>

      {sources.length > 0 && (
        <div className="library-chat-sources" aria-label="当前问答来源">
          {sources.slice(0, 3).map((source, index) => (
            <span key={source.noteId} title={source.title}>
              {index + 1}. {source.title}
            </span>
          ))}
          {sources.length > 3 && <span>+{sources.length - 3} 条</span>}
        </div>
      )}

      <div className="library-chat-thread" aria-live="polite">
        {sources.length === 0 ? (
          <div className="library-chat-empty">
            <Bot size={24} />
            <h3>
              {scope === 'all'
                ? '还没有可问的完整文案'
                : '先勾选已有文案的视频'}
            </h3>
            <p>
              {scope === 'all'
                ? '从抖音同步后会自动提取文案，研究 Agent 最多扫描当前来源的 50 条文案。'
                : selectedCount > 0
                  ? '你勾选的视频文案还没准备好，可以点击“补提完整文案”。'
                  : '在左侧勾选视频，问答只会使用其中已有完整文案的条目。'}
            </p>
          </div>
        ) : messages.length === 0 ? (
          <div className="library-chat-starters">
            <p>可以这样问：</p>
            {STARTERS.map((starter) => (
              <button
                type="button"
                key={starter}
                onClick={() => submitQuestion(undefined, starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        ) : (
          messages.map((message) => (
            <article
              key={message.id}
              className={`library-chat-message is-${message.role}`}
            >
              <div>{message.content}</div>
              {message.result?.source_context && (
                <>
                  <p className="library-answer-scan">
                    <CheckCircle2 size={12} />
                    已扫描 {message.result.source_context.note_count} 条视频的
                    {' '}{message.result.source_context.transcript_chars.toLocaleString('zh-CN')} 字完整文案，
                    从 {message.result.source_context.scanned_chunks} 个分块召回
                    {' '}{message.result.source_context.selected_chunks} 个证据片段
                  </p>
                  <div className="library-agent-trace">
                    {message.result.source_context.agent_trace.map((stage) => (
                      <span key={stage.stage} title={stage.detail}>
                        <i />
                        {stage.label}
                      </span>
                    ))}
                  </div>
                </>
              )}
              {message.result?.evidence && message.result.evidence.length > 0 && (
                <div className="library-evidence-list">
                  {message.result.evidence.map((evidence, index) => (
                    <blockquote key={`${evidence.note_id}-${index}`}>
                      <strong>{evidence.title}</strong>
                      <p>“{evidence.quote}”</p>
                    </blockquote>
                  ))}
                </div>
              )}
              {message.result?.web_sources && message.result.web_sources.length > 0 && (
                <div className="library-web-sources">
                  <strong><Globe2 size={13} />外部查证</strong>
                  {message.result.web_sources.map((source) => (
                    <a
                      key={`${source.id}-${source.url}`}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span>{source.title}</span>
                      <small>{source.domain}</small>
                      <ExternalLink size={13} />
                    </a>
                  ))}
                </div>
              )}
              {message.result?.follow_up_questions && (
                <div className="library-follow-ups">
                  {message.result.follow_up_questions.map((followUp) => (
                    <button
                      type="button"
                      key={followUp}
                      onClick={() => submitQuestion(undefined, followUp)}
                    >
                      {followUp}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))
        )}
        {loading && (
          <div className="library-chat-thinking">
            <LoaderCircle size={15} className="animate-spin" />
            {researchMode === 'deep'
              ? `研究 Agent 正在规划、分批阅读${webScope === 'auto' ? '并按需联网查证' : ''}…`
              : `研究 Agent 正在扫描全部所选文案${webScope === 'auto' ? '，必要时联网查证' : ''}…`}
          </div>
        )}
      </div>

      {error && <p className="library-chat-error">{error}</p>}

      <form className="library-chat-form" onSubmit={submitQuestion}>
        <label htmlFor="library-question" className="sr-only">
          {scope === 'all' ? '向全部已有文案提问' : '向勾选视频提问'}
        </label>
        <textarea
          id="library-question"
          rows={2}
          value={question}
          maxLength={600}
          disabled={sources.length === 0 || loading}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submitQuestion();
            }
          }}
          placeholder={
            sources.length > 0
              ? scope === 'all'
                ? '直接问当前视频库里的任何信息…'
                : '问勾选视频里的任何信息…'
              : scope === 'all'
                ? '生成视频文案后即可提问'
                : '勾选有文案的视频后可提问'
          }
        />
        <button
          type="submit"
          disabled={!question.trim() || sources.length === 0 || loading}
          aria-label="发送问题"
        >
          <Send size={16} />
        </button>
      </form>
      <p className="library-chat-note">
        {webScope === 'auto'
          ? '优先使用视频文案，缺失的链接或当前信息会单独联网查证'
          : '回答以当前范围内的完整文案为准；已有 AI 摘要时才辅助使用'}
      </p>
    </section>
  );
}
