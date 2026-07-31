'use client';

import Link from 'next/link';
import {
  Check,
  CheckCircle,
  ClockCountdown,
  SpinnerGap,
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
  busy,
  onToggle,
}: {
  task: PlanFocusTask;
  tone: 'today' | 'overdue' | 'upcoming';
  busy: boolean;
  onToggle: (task: PlanFocusTask) => void;
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
    <article
      className={`plan-workspace-focus-item is-${tone} flex min-w-0 items-center gap-3 rounded-2xl border border-card-border bg-card-bg px-3 py-3 md:px-4`}
    >
      <button
        type="button"
        onClick={() => onToggle(task)}
        disabled={busy}
        className="plan-workspace-focus-check inline-flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-card-border text-foreground-secondary transition-colors hover:border-foreground-muted hover:text-foreground disabled:opacity-50"
        aria-label={`完成任务：${task.title}`}
      >
        {busy ? <SpinnerGap size={17} className="animate-spin" /> : <Check size={17} weight="bold" />}
      </button>
      <Link
        href={`/plans?id=${task.plan_id}`}
        className="plan-workspace-focus-link min-w-0 flex-1 text-foreground no-underline"
        aria-label={`打开计划：${task.plan_title}，任务：${task.title}`}
      >
        <span className="plan-workspace-focus-title block text-[15px] font-semibold leading-snug text-foreground md:text-base">
          {task.title}
        </span>
        <span className="plan-workspace-focus-meta mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
          <span className="max-w-full truncate">{task.plan_title}</span>
          {executionMeta && (
            <span className="inline-flex items-center gap-1">
              <ClockCountdown size={12} />
              {executionMeta}
            </span>
          )}
          <span className={`plan-priority is-${task.priority}`}>
            {priorityLabels[task.priority]}
          </span>
        </span>
      </Link>
      <span
        className={`plan-workspace-focus-state flex-none text-xs font-semibold ${
          tone === 'today'
            ? 'text-foreground-secondary'
            : tone === 'overdue'
              ? 'text-accent-rose'
              : 'text-foreground-muted'
        }`}
      >
        {tone === 'today' ? '今天' : tone === 'overdue' ? '逾期' : '下一步'}
      </span>
    </article>
  );
}

export default function PlanExecutionOverview({
  overview,
  onToggle,
  mutatingIds,
}: {
  overview: PlanOverview;
  onToggle: (task: PlanFocusTask) => void;
  mutatingIds: Set<string>;
}) {
  // Keep overdue work visible as a separate exception instead of allowing it
  // to consume the three actions that answer "what should I do now?".
  const focusTasks = [
    ...overview.today.map(task => ({ task, tone: 'today' as const })),
    ...overview.upcoming.map(task => ({ task, tone: 'upcoming' as const })),
  ].slice(0, 3);
  const overdueTasks = overview.overdue.slice(0, 2);

  return (
    <section className="plan-workspace-today" aria-labelledby="plan-overview-title">
      <div className="plan-workspace-today-header mb-4 flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold text-foreground-muted">今日聚焦</p>
          <h2 id="plan-overview-title" className="mt-1 text-xl font-bold text-foreground md:text-2xl">
            现在最应该做什么
          </h2>
        </div>
        <span className="plan-workspace-today-summary hidden text-sm text-foreground-muted sm:inline">
          {overview.summary.due_today} 项今日任务 · {overview.summary.active_plans} 个进行中目标
        </span>
      </div>

      {overview.summary.overdue_tasks > 0 && (
        <aside className="plan-workspace-overdue mb-4 rounded-2xl border border-accent-rose/25 bg-accent-rose/[0.04] p-3 md:p-4">
          <div className="flex items-start gap-2.5">
            <WarningCircle size={20} weight="duotone" className="mt-0.5 flex-none text-accent-rose" />
            <div className="min-w-0 flex-1">
              <strong className="block text-sm text-foreground">
                {overview.summary.overdue_tasks} 项任务需要重新确认
              </strong>
              <p className="mt-1 text-xs leading-relaxed text-foreground-muted">
                它们不会挤掉今天的重点；可以完成、改期，或进入目标查看详情。
              </p>
              {overdueTasks.length > 0 && (
                <div className="mt-3 grid gap-2">
                  {overdueTasks.map(task => (
                    <FocusTask
                      key={`${task.plan_id}-${task.task_id}`}
                      task={task}
                      tone="overdue"
                      busy={mutatingIds.has(`${task.plan_id}:${task.task_id}`)}
                      onToggle={onToggle}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      )}

      {focusTasks.length === 0 ? (
        <div className="plan-workspace-today-empty flex min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-card-border bg-card-bg px-5 text-center">
          <CheckCircle size={22} weight="duotone" />
          <strong className="mt-2 text-sm text-foreground">今天已经清空</strong>
          <span className="mt-1 max-w-md text-xs leading-relaxed text-foreground-muted">
            没有需要立即推进的任务。需要时可以从视频资料创建新的目标。
          </span>
        </div>
      ) : (
        <div className="plan-workspace-focus-list grid gap-2.5">
          {focusTasks.map(({ task, tone }) => (
            <FocusTask
              key={`${task.plan_id}-${task.task_id}`}
              task={task}
              tone={tone}
              busy={mutatingIds.has(`${task.plan_id}:${task.task_id}`)}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </section>
  );
}
