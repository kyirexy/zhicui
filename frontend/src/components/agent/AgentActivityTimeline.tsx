'use client';

import { useEffect, useId, useState } from 'react';
import {
  CaretDown,
  CheckCircle,
  CircleNotch,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  DEFAULT_AGENT_ACTIVITY_EXPANDED,
  nextAgentActivityExpanded,
  type AgentActivityItem,
} from '@/lib/agentTurnUi';

interface AgentActivityTimelineProps {
  activities: AgentActivityItem[];
  cancellationRequested?: boolean;
  cancelling?: boolean;
  canCancel?: boolean;
  onCancel?: () => void;
  answerStarted?: boolean;
}

function ActivityIcon({ status }: { status: AgentActivityItem['status'] }) {
  if (status === 'completed') {
    return <CheckCircle size={15} weight="fill" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return <WarningCircle size={15} weight="fill" aria-hidden="true" />;
  }
  return <CircleNotch size={15} aria-hidden="true" />;
}

export default function AgentActivityTimeline({
  activities,
  cancellationRequested = false,
  cancelling = false,
  canCancel = false,
  onCancel,
  answerStarted = false,
}: AgentActivityTimelineProps) {
  const disclosureId = useId();
  const [expanded, setExpanded] = useState(DEFAULT_AGENT_ACTIVITY_EXPANDED);

  useEffect(() => {
    if (!answerStarted) return;
    setExpanded((current) => nextAgentActivityExpanded(current, 'answer-started'));
  }, [answerStarted]);

  const runningActivity = [...activities].reverse().find(
    (activity) => activity.status === 'running',
  );
  const latestActivity = activities.at(-1);
  const currentLabel = cancellationRequested
    ? '正在停止本次回答'
    : answerStarted
      ? '正在生成回答'
      : runningActivity?.label
        || (latestActivity?.status === 'failed' ? latestActivity.label : '正在准备回答');
  const summaryMeta = cancellationRequested
    ? '已经生成的内容会继续保留'
    : answerStarted
      ? '正文与依据正在连续显示'
      : runningActivity?.detail || '正在执行当前任务';
  const hasDetails = activities.length > 1 || activities.some(
    (activity) => activity.status !== 'running',
  );
  const detailsExpanded = hasDetails && expanded;

  return (
    <section
      className={`video-agent-activity ${detailsExpanded ? 'is-expanded' : 'is-collapsed'} ${
        answerStarted ? 'has-answer' : ''
      }`}
      aria-label="知萃回答生成进度"
    >
      <header className="video-agent-activity-current">
        <button
          type="button"
          className="video-agent-activity-summary"
          aria-expanded={detailsExpanded}
          aria-controls={disclosureId}
          aria-label={detailsExpanded ? '收起最近研究动作' : '展开最近研究动作'}
          disabled={!hasDetails}
          onClick={() => {
            setExpanded((current) => nextAgentActivityExpanded(current, 'toggle'));
          }}
        >
          <span className="video-agent-activity-current-icon" aria-hidden="true">
            <CircleNotch size={15} />
          </span>
          <span className="video-agent-activity-summary-copy">
            <strong>{currentLabel}</strong>
            <small>{summaryMeta}</small>
          </span>
          {hasDetails ? (
            <CaretDown
              className="video-agent-activity-chevron"
              size={14}
              aria-hidden="true"
            />
          ) : null}
        </button>
        {canCancel && onCancel ? (
          <button
            type="button"
            className="video-agent-turn-action"
            disabled={cancelling || cancellationRequested}
            onClick={onCancel}
            aria-label="停止本次回答"
            title="停止本次回答"
          >
            <X size={14} aria-hidden="true" />
            {cancellationRequested
              ? '正在停止'
              : cancelling
                ? '正在停止'
                : '停止生成'}
          </button>
        ) : null}
      </header>

      <span className="video-agent-visually-hidden" role="status" aria-live="polite">
        {currentLabel}
      </span>

      {detailsExpanded ? (
        <ol
          id={disclosureId}
          className="video-agent-activity-list"
          aria-label="最近研究动作"
        >
          {activities.map((activity) => (
            <li
              key={activity.id}
              className={`is-${activity.status}`}
            >
              <span className="video-agent-activity-icon">
                <ActivityIcon status={activity.status} />
              </span>
              <span className="video-agent-activity-copy">
                <span>{activity.label}</span>
                {activity.detail ? <small>{activity.detail}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <span id={disclosureId} hidden />
      )}
    </section>
  );
}
