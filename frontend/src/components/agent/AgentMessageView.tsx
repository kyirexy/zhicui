'use client';

import { memo } from 'react';
import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  ClipboardText,
  FileText,
  GlobeHemisphereWest,
  ListChecks,
  PencilSimple,
  VideoCamera,
} from '@phosphor-icons/react';
import AgentMark from '@/components/agent/AgentMark';
import AgentVideoAnalysisCard, {
  type AgentVideoAnalysisDecision,
} from '@/components/agent/AgentVideoAnalysisCard';
import { MessageResponse } from '@/components/ai-elements/message';
import type { AgentMessage } from '@/lib/types';

export type AgentMessageDeliveryState = 'sending' | 'failed';

interface AgentMessageViewProps {
  message: AgentMessage;
  disabled?: boolean;
  deliveryState?: AgentMessageDeliveryState;
  deliveryError?: string;
  streaming?: boolean;
  onFollowUp: (question: string) => void;
  onRetry?: (message: AgentMessage) => void;
  onEdit?: (message: AgentMessage) => void;
  onVideoAnalysisDecision?: (
    message: AgentMessage,
    action: AgentVideoAnalysisDecision,
    options?: { offeringId?: string; useByok?: boolean },
  ) => void;
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

function formatTimestamp(milliseconds?: number): string {
  if (typeof milliseconds !== 'number' || milliseconds < 0) return '';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function AgentMessageView({
  message,
  disabled = false,
  deliveryState,
  deliveryError,
  streaming = false,
  onFollowUp,
  onRetry,
  onEdit,
  onVideoAnalysisDecision,
}: AgentMessageViewProps) {
  const isAssistant = message.role === 'assistant';
  // DSH rows keep assistant output full-width all the way through streaming; a
  // markdown-only pass has no `[object Object]`-style noise to hide, so it
  // stays as the last visible source.
  const liveContent = typeof message.content === 'string' ? message.content : '';
  const streamed = streaming && liveContent.trim() !== '';
  const claims = message.result?.claims || [];
  const evidenceCount = message.evidence?.length || 0;
  const transcriptEvidenceCount = message.evidence?.filter(
    (evidence) => evidence.source === 'transcript',
  ).length || 0;
  const visualEvidenceCount = message.evidence?.filter(
    (evidence) => evidence.source === 'visual',
  ).length || 0;
  const summaryEvidenceCount = evidenceCount
    - transcriptEvidenceCount
    - visualEvidenceCount;
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
    ? (streamed ? message.content : readableAssistantContent(message.content))
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
      id={`agent-message-${message.id}`}
      className={`video-agent-message is-${message.role} ${
        deliveryState ? `is-${deliveryState}` : ''
      } ${streaming ? 'is-streaming' : ''}`}
    >
      {isAssistant && (
        <div className="video-agent-message-author">
          <>
            <span className="video-agent-message-avatar">
              <AgentMark variant="avatar" />
            </span>
            <span className="video-agent-message-identity">
              <strong>知萃</strong>
              <small>{streaming ? '正在生成' : '基于视频资料'}</small>
            </span>
          </>
        </div>
      )}

      {isAssistant ? (
        displayContent ? (
          <MessageResponse
            className="video-agent-answer-markdown"
            isAnimating={streaming}
          >
            {displayContent}
          </MessageResponse>
        ) : null
      ) : (
        <div className="video-agent-message-content">{displayContent}</div>
      )}

      {isAssistant && !streaming && (
        <AgentVideoAnalysisCard
          message={message}
          disabled={disabled}
          onDecision={onVideoAnalysisDecision}
        />
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
              <span className="video-agent-message-failure-copy">
                <strong>回答生成中断</strong>
                <small>{deliveryError || '服务暂时没有完成这条回答'}</small>
              </span>
              <span className="video-agent-message-failure-actions">
                {onEdit && (
                  <button type="button" onClick={() => onEdit(message)}>
                    <PencilSimple size={14} />
                    修改问题
                  </button>
                )}
                {onRetry && (
                  <button type="button" onClick={() => onRetry(message)}>
                    <ArrowClockwise size={14} />
                    重新生成
                  </button>
                )}
              </span>
            </>
          )}
        </div>
      )}

      {isAssistant && !streaming && (
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
              {claims.length > 0 && (
                <section className="video-agent-grounding-section is-claims">
                  <header className="video-agent-grounding-section-header">
                    <ListChecks size={16} />
                    <h4>已验证观点</h4>
                    <span>{claims.length}</span>
                  </header>
                  <ol className="video-agent-grounding-claims">
                    {claims.map((claim, claimIndex) => (
                      <li key={claim.claim_id || `claim-${claimIndex}`}>
                        <header>
                          <span className="video-agent-grounding-index">
                            {claimIndex + 1}
                          </span>
                          <span>
                            <strong>{claim.text}</strong>
                            <small>
                              已核验 {claim.support_count} 条视频 · 研究范围 {claim.research_source_count} 条
                            </small>
                          </span>
                        </header>
                        {claim.explanation && <p>{claim.explanation}</p>}
                        <ul>
                          {claim.evidence.map((evidence, evidenceIndex) => (
                            <li key={`${claim.claim_id}-${evidence.note_id}-${evidenceIndex}`}>
                              <a href={`/notes?id=${encodeURIComponent(evidence.note_id)}`}>
                                {evidence.title || '视频原文'}
                              </a>
                              <small>
                                {evidence.source === 'transcript'
                                  ? '完整文案'
                                  : evidence.source === 'visual'
                                    ? `画面观察${formatTimestamp(evidence.timestamp_ms)
                                      ? ` · ${formatTimestamp(evidence.timestamp_ms)}`
                                      : ''}`
                                    : '摘要笔记'}
                              </small>
                              <blockquote>“{evidence.quote}”</blockquote>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {claims.length === 0 && evidenceCount > 0 && (
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
                        ? `${summaryEvidenceCount} 条摘要笔记`
                        : ''}
                      {(transcriptEvidenceCount > 0 || summaryEvidenceCount > 0)
                        && visualEvidenceCount > 0
                        ? ' · '
                        : ''}
                      {visualEvidenceCount > 0
                        ? `${visualEvidenceCount} 条画面观察`
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
                              : evidence.source === 'visual'
                                ? `AI 画面观察${formatTimestamp(evidence.timestamp_ms)
                                  ? ` · ${formatTimestamp(evidence.timestamp_ms)}`
                                  : ''}`
                                : '摘要笔记'}
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

      {isAssistant && !streaming && (
        <div className="video-agent-answer-actions" aria-label="回答操作">
          <button type="button" onClick={() => void copyAnswer()}>
            <ClipboardText size={15} />
            复制回答
          </button>
        </div>
      )}

      {isAssistant && !streaming && message.follow_up_questions?.length ? (
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

export default memo(AgentMessageView);
