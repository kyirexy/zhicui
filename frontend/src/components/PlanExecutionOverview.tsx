'use client';

import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle,
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
          <span className="plan-focus-task__plan truncate">{task.plan_title}</span>
          <span className="plan-focus-task__separator" aria-hidden="true">·</span>
          <span className="plan-focus-task__schedule">{executionMeta}</span>
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
  const hasFocus = overview.overdue.length > 0
    || overview.today.length > 0
    || overview.upcoming.length > 0;
  const priorityTasks = [
    ...overview.overdue.map(task => ({ task, tone: 'overdue' as const })),
    ...overview.today.map(task => ({ task, tone: 'today' as const })),
    ...overview.upcoming.map(task => ({ task, tone: 'upcoming' as const })),
  ].slice(0, 3);

  return (
    <section className="plan-overview" aria-labelledby="plan-overview-title">
      <div className="plan-overview__header">
        <div>
          <p className="plan-overview__eyebrow">今日聚焦</p>
          <h2 id="plan-overview-title">今天先做什么</h2>
        </div>
        <span className="plan-overview__summary">
          <strong>{overview.summary.open_tasks}</strong> 项待办
          <span aria-hidden="true">·</span>
          {overview.summary.active_plans} 个计划
        </span>
      </div>

      {!hasFocus ? (
        <div className="plan-overview__empty">
          <CheckCircle size={22} weight="duotone" />
          <span>今天没有要赶的任务，可以从一条视频开始新的计划。</span>
        </div>
      ) : (
        <div className="plan-overview__tasks">
          {priorityTasks.map(({ task, tone }) => (
            <FocusTask
              key={`${task.plan_id}-${task.task_id}`}
              task={task}
              tone={tone}
            />
          ))}
        </div>
      )}
    </section>
  );
}
