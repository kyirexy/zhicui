'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CalendarBlank,
  CheckCircle,
  ClockCountdown,
  Stack,
  WarningCircle,
} from '@phosphor-icons/react';
import type { PlanFocusTask, PlanOverview, PlanPriority } from '@/lib/types';
import { formatPlanDuration, formatPlanSchedule } from '@/lib/types';

const priorityLabels: Record<PlanPriority, string> = {
  high: '高优先',
  medium: '中优先',
  low: '低优先',
};

function FocusTask({
  task,
  tone,
}: {
  task: PlanFocusTask;
  tone: 'today' | 'overdue' | 'upcoming';
}) {
  const schedule = task.scheduled_at
    ? formatPlanSchedule(task.scheduled_at)
    : task.day
      ? `第 ${task.day} 天`
      : '待排期';
  const executionMeta = [
    schedule,
    formatPlanDuration(task.duration_minutes),
    task.frequency,
  ].filter(Boolean).join(' · ');

  return (
    <Link
      href={`/plans?id=${task.plan_id}`}
      className={`plan-focus-task is-${tone}`}
      aria-label={`打开计划：${task.plan_title}，任务：${task.title}`}
    >
      <span className="plan-focus-task__indicator" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="plan-focus-task__title">{task.title}</span>
        <span className="plan-focus-task__meta">
          <span className="truncate">{task.plan_title}</span>
          <span aria-hidden="true">·</span>
          <span>{executionMeta}</span>
          <span className={`plan-priority is-${task.priority}`}>
            {priorityLabels[task.priority]}
          </span>
        </span>
      </span>
      <ArrowRight size={15} weight="bold" className="plan-focus-task__arrow" />
    </Link>
  );
}

export default function PlanExecutionOverview({
  overview,
}: {
  overview: PlanOverview;
}) {
  const metrics = [
    {
      label: '进行中计划',
      value: overview.summary.active_plans,
      icon: Stack,
      tone: 'neutral',
    },
    {
      label: '未完成任务',
      value: overview.summary.open_tasks,
      icon: CheckCircle,
      tone: 'neutral',
    },
    {
      label: '今日聚焦',
      value: overview.summary.due_today,
      icon: ClockCountdown,
      tone: 'today',
    },
    {
      label: '已经逾期',
      value: overview.summary.overdue_tasks,
      icon: WarningCircle,
      tone: 'overdue',
    },
  ] as const;

  const hasFocus = overview.overdue.length > 0
    || overview.today.length > 0
    || overview.upcoming.length > 0;
  const priorityTasks = [
    ...overview.overdue.map(task => ({ task, tone: 'overdue' as const })),
    ...overview.today.map(task => ({ task, tone: 'today' as const })),
  ].slice(0, 5);

  return (
    <section className="plan-overview" aria-labelledby="plan-overview-title">
      <div className="plan-overview__header">
        <div>
          <p className="plan-overview__eyebrow">EXECUTION DESK</p>
          <h2 id="plan-overview-title">执行概览</h2>
        </div>
        <span className="plan-overview__date">
          <CalendarBlank size={16} />
          北京时间
        </span>
      </div>

      <div className="plan-overview__metrics" aria-label="计划执行指标">
        {metrics.map(({ label, value, icon: Icon, tone }) => (
          <div key={label} className={`plan-metric is-${tone}`}>
            <Icon size={18} weight="duotone" aria-hidden="true" />
            <span>
              <strong>{value}</strong>
              <small>{label}</small>
            </span>
          </div>
        ))}
      </div>

      {!hasFocus ? (
        <div className="plan-overview__empty">
          <CheckCircle size={22} weight="duotone" />
          <span>当前没有待推进的任务，可以从新视频中生成下一份行动计划。</span>
        </div>
      ) : (
        <div className="plan-overview__focus-grid">
          <div className="plan-focus-column">
            <div className="plan-focus-column__heading">
              <span>优先处理</span>
              <strong>{overview.overdue.length + overview.today.length}</strong>
            </div>
            {priorityTasks.map(({ task, tone }) => (
              <FocusTask
                key={`${task.plan_id}-${task.task_id}`}
                task={task}
                tone={tone}
              />
            ))}
            {overview.overdue.length + overview.today.length === 0 && (
              <p className="plan-focus-column__empty">今天没有紧急事项</p>
            )}
          </div>

          <div className="plan-focus-column">
            <div className="plan-focus-column__heading">
              <span>接下来</span>
              <strong>{overview.upcoming.length}</strong>
            </div>
            {overview.upcoming.slice(0, 4).map(task => (
              <FocusTask
                key={`${task.plan_id}-${task.task_id}`}
                task={task}
                tone="upcoming"
              />
            ))}
            {overview.upcoming.length === 0 && (
              <p className="plan-focus-column__empty">暂无后续排期</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
