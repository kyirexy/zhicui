'use client';

import {
  ArrowClockwise,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  ClipboardText,
  FileText,
  GlobeHemisphereWest,
  ListChecks,
  PencilSimple,
  VideoCamera,
} from '@phosphor-icons/react';
import AgentMark from '@/components/agent/AgentMark';
import { MessageResponse } from '@/components/ai-elements/message';
import type { AgentMessage } from '@/lib/types';

export type AgentMessageDeliveryState = 'sending' | 'failed';

interface AgentMessageViewProps {
  message: AgentMessage;
  disabled?: boolean;
  deliveryState?: AgentMessageDeliveryState;
  onFollowUp: (question: string) => void;
  onRetry?: (message: AgentMessage) => void;
  onEdit?: (message: AgentMessage) => void;
}

function readableAssistantContent(content: string): string {
  const original = typeof content === 'string' ? content.trim() : '';
  if (!original) return '';

  let candidate: unknown = original;
  for (let pass = 0; pass < 3; pass += 1) {
    if (typeof candidate !== 'string') break;
    const cleaned = candidate
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      candidate = JSON.parse(cleaned);
    } catch {
      break;
    }
  }

  if (
    candidate
    && typeof candidate === 'object'
    && 'answer' in candidate
    && typeof candidate.answer === 'string'
  ) {
    return candidate.answer.trim() || original;
  }

  return typeof candidate === 'string' ? candidate : original;
}

export default function AgentMessageView({
  message,
  disabled = false,
  deliveryState,
  onFollowUp,
  onRetry,
  onEdit,
}: AgentMessageViewProps) {
  const isAssistant = message.role === 'assistant';
  const evidenceCount = message.evidence?.length || 0;
  const transcriptEvidenceCount = message.evidence?.filter(
    (evidence) => evidence.source === 'transcript',
  ).length || 0;
  const summaryEvidenceCount = evidenceCount - transcriptEvidenceCount;
  const webSourceCount = message.web_sources?.length || 0;
  const sourceContext = message.source_context;
  const grounded = Boolean(message.grounded || evidenceCount);
  const groundingStatus = message.grounding_status
    ?? message.result?.grounding_status
    ?? (grounded ? 'grounded' : 'ungrounded');
  const citationCoverage = message.citation_coverage
    ?? message.result?.citation_coverage;
  const limitations = message.limitations
    ?? message.result?.limitations
    ?? [];
  const agentTrace = sourceContext?.agent_trace ?? [];
  const groundingSummaryParts = [
    evidenceCount > 0
      ? `${evidenceCount} 条依据`
      : grounded
        ? '基于视频资料'
        : '未形成直接引用',
    citationCoverage && citationCoverage.requested > 0
      ? `引用 ${citationCoverage.verified}/${citationCoverage.requested}`
      : null,
    sourceContext
      ? `已读 ${sourceContext.note_count} 个视频`
      : null,
    sourceContext
      ? `${sourceContext.transcript_chars.toLocaleString('zh-CN')} 字文稿`
      : null,
    webSourceCount > 0
      ? `${webSourceCount} 条外部查证`
      : null,
  ].filter((part): part is string => Boolean(part));
  const displayContent = isAssistant
    ? readableAssistantContent(message.content)
    : message.content;

  const copyAnswer = async () => {
    if (!displayContent) return;
    try {
      await navigator.clipboard.writeText(displayContent);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = displayContent;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
  };

  return (
    <article
      className={`video-agent-message is-${message.role} ${
        deliveryState ? `is-${deliveryState}` : ''
      }`}
    >
      <div className="video-agent-message-author">
        {isAssistant ? (
          <>
            <span><AgentMark variant="avatar" /></span>
            知萃
          </>
        ) : '你'}
      </div>

      {isAssistant ? (
        <MessageResponse className="video-agent-answer-markdown">
          {displayContent}
        </MessageResponse>
      ) : (
        <div className="video-agent-message-content">{displayContent}</div>
      )}

      {!isAssistant && deliveryState && (
        <div
          className={`video-agent-message-delivery is-${deliveryState}`}
          role={deliveryState === 'failed' ? 'alert' : 'status'}
        >
          {deliveryState === 'sending' ? (
            <>
              <span aria-hidden="true"><i /><i /><i /></span>
              正在发送
            </>
          ) : (
            <>
              <span>这条问题没有发出去</span>
              {onEdit && (
                <button type="button" onClick={() => onEdit(message)}>
                  <PencilSimple size={14} />
                  编辑
                </button>
              )}
              {onRetry && (
                <button type="button" onClick={() => onRetry(message)}>
                  <ArrowClockwise size={14} />
                  重试
                </button>
              )}
            </>
          )}
        </div>
      )}

      {isAssistant && (
        <details
          className={`video-agent-grounding ${
            groundingStatus === 'grounded' ? 'is-grounded' : 'is-limited'
          }`}
        >
          <summary className="video-agent-grounding-summary">
            <span className="video-agent-grounding-summary-label">
              <CheckCircle
                size={15}
                weight={groundingStatus === 'grounded' ? 'fill' : 'regular'}
              />
              <strong>
                {groundingStatus === 'grounded' ? '回答依据' : '依据有限'}
              </strong>
            </span>
            <span className="video-agent-grounding-summary-meta">
              {groundingSummaryParts.join(' · ')}
            </span>
            <CaretRight
              className="video-agent-grounding-chevron"
              size={14}
            />
          </summary>

          {(evidenceCount > 0
            || webSourceCount > 0
            || agentTrace.length > 0
            || limitations.length > 0) && (
            <div className="video-agent-grounding-body">
              {evidenceCount > 0 && (
                <section className="video-agent-grounding-section is-evidence">
                  <header className="video-agent-grounding-section-header">
                    <ListChecks size={16} />
                    <h4>视频依据</h4>
                    <span>
                      {transcriptEvidenceCount > 0
                        ? `${transcriptEvidenceCount} 条原文`
                        : ''}
                      {transcriptEvidenceCount > 0 && summaryEvidenceCount > 0
                        ? ' · '
                        : ''}
                      {summaryEvidenceCount > 0
                        ? `${summaryEvidenceCount} 条知识卡理解`
                        : ''}
                    </span>
                  </header>
                  <ol className="video-agent-grounding-evidence">
                    {message.evidence?.map((evidence, index) => (
                      <li key={`${evidence.note_id}-${index}`}>
                        <span className="video-agent-grounding-index">
                          {index + 1}
                        </span>
                        <blockquote>
                          <a
                            className="video-agent-grounding-source-title"
                            href={`/notes?id=${encodeURIComponent(evidence.note_id)}`}
                          >
                            {evidence.title || '视频原文'}
                          </a>
                          <small className="video-agent-grounding-source-meta">
                            {evidence.source === 'transcript'
                              ? '完整文案'
                              : '知识卡理解'}
                            {typeof evidence.position_percent === 'number'
                              ? ` · 文稿约 ${Math.round(evidence.position_percent)}% 处`
                              : ''}
                          </small>
                          <p>“{evidence.quote}”</p>
                        </blockquote>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {webSourceCount > 0 && (
                <section className="video-agent-grounding-section is-web">
                  <header className="video-agent-grounding-section-header">
                    <GlobeHemisphereWest size={16} />
                    <h4>外部查证</h4>
                    <span>{webSourceCount} 个来源</span>
                  </header>
                  <ul className="video-agent-grounding-links">
                    {message.web_sources?.map((source) => (
                      <li key={`${source.id}-${source.url}`}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span>{source.title}</span>
                          <small>{source.domain}</small>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {agentTrace.length > 0 && (
                <section className="video-agent-grounding-section is-process">
                  <header className="video-agent-grounding-section-header">
                    <VideoCamera size={16} />
                    <h4>处理过程</h4>
                    <span>{agentTrace.length} 个步骤</span>
                  </header>
                  <ol className="video-agent-grounding-process">
                    {agentTrace.map((stage) => (
                      <li
                        key={stage.stage}
                        data-status={stage.status || 'completed'}
                      >
                        <i aria-hidden="true" />
                        <span>
                          <strong>{stage.label}</strong>
                          <small>
                            {stage.detail}
                            {typeof stage.duration_ms === 'number'
                              ? ` · ${stage.duration_ms < 1000
                                ? `${stage.duration_ms}ms`
                                : `${(stage.duration_ms / 1000).toFixed(1)}s`}`
                              : ''}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {limitations.length > 0 && (
                <section className="video-agent-grounding-section is-limitations">
                  <header className="video-agent-grounding-section-header">
                    <FileText size={16} />
                    <h4>回答边界</h4>
                    <span>{limitations.length} 项</span>
                  </header>
                  <ul className="video-agent-grounding-limitations">
                    {limitations.map((limitation) => (
                      <li key={limitation}>{limitation}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </details>
      )}

      {isAssistant && (
        <div className="video-agent-answer-actions" aria-label="回答操作">
          <button type="button" onClick={() => void copyAnswer()}>
            <ClipboardText size={15} />
            复制回答
          </button>
          <button
            type="button"
            onClick={() => window.dispatchEvent(
              new CustomEvent('zhicui:open-feedback'),
            )}
          >
            <ChatCircleDots size={15} />
            反馈
          </button>
        </div>
      )}

      {isAssistant && message.follow_up_questions?.length ? (
        <div className="video-agent-followups">
          <strong>继续追问</strong>
          {message.follow_up_questions.map((followUp) => (
            <button
              type="button"
              key={followUp}
              disabled={disabled}
              onClick={() => onFollowUp(followUp)}
            >
              <span>{followUp}</span>
              <CaretRight size={14} />
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}
