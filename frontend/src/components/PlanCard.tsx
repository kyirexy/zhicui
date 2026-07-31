'use client';

import Link from 'next/link';
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  CheckCircle2,
  Trash2,
} from 'lucide-react';
import type { PlanData } from '@/lib/types';
import {
  formatPlanSchedule,
  getOverdueTasks,
  getPlanProgress,
  getPlanTasks,
} from '@/lib/types';

interface PlanCardProps {
  plan: PlanData;
  onDelete?: (plan: PlanData) => void;
}

export default function PlanCard({ plan, onDelete }: PlanCardProps) {
  const { done, total, pct } = getPlanProgress(plan);
  const overdueTasks = getOverdueTasks(plan);
  const nextTask = getPlanTasks(plan).find(task => !task.done);
  const nextDay = nextTask?.day
    ? plan.days?.find(day => day.day === nextTask.day)
    : null;
  const nextSchedule = formatPlanSchedule(nextTask?.scheduled_at);
  const isComplete = plan.status === 'done' || (total > 0 && pct === 100);

  return (
    <article
      className={`plan-workspace-goal-row group relative overflow-hidden rounded-2xl border bg-card-bg transition-colors ${
        overdueTasks.length > 0
          ? 'border-accent-rose/25'
          : isComplete
            ? 'border-card-border opacity-80'
            : 'border-card-border hover:border-foreground-muted/30'
      }`}
    >
      <Link
        href={`/plans?id=${plan.id}`}
        className="plan-workspace-goal-link grid min-h-[116px] grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-4 text-foreground no-underline md:min-h-[104px] md:grid-cols-[minmax(210px,0.85fr)_minmax(240px,1.3fr)_130px_auto] md:items-center md:px-5"
        aria-label={`打开计划：${plan.title}`}
      >
        <div className="plan-workspace-goal-copy min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`h-2 w-2 flex-none rounded-full ${
                isComplete
                  ? 'bg-accent-emerald'
                  : overdueTasks.length > 0
                    ? 'bg-accent-rose'
                    : 'bg-foreground-muted/50'
              }`}
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-foreground-muted">
              {isComplete ? '已完成' : overdueTasks.length > 0 ? '需要调整' : '进行中'}
            </span>
          </div>
          <h3 className="mt-1.5 line-clamp-2 text-[15px] font-semibold leading-snug text-foreground md:text-base">
            {plan.title}
          </h3>
        </div>

        <div className="plan-workspace-goal-next col-span-2 min-w-0 md:col-span-1">
          <span className="block text-xs font-medium text-foreground-muted">
            {isComplete ? '目标状态' : '下一步'}
          </span>
          <strong className="mt-1 block truncate text-sm font-medium text-foreground-secondary">
            {isComplete
              ? '全部任务已经完成'
              : nextTask?.title || '还没有可执行任务'}
          </strong>
          {!isComplete && (nextDay?.label || nextSchedule) && (
            <span className="mt-1 flex items-center gap-1 truncate text-xs text-foreground-muted">
              <Calendar size={12} />
              {[nextDay?.label, nextSchedule].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>

        <div className="plan-workspace-goal-progress col-span-2 min-w-0 md:col-span-1">
          <div className="flex items-center justify-between text-xs text-foreground-muted">
            <span>{done}/{total} 项</span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-secondary">
            <span
              className={`block h-full rounded-full ${
                isComplete ? 'bg-accent-emerald' : 'bg-foreground-secondary'
              }`}
              style={{ width: `${pct}%` }}
            />
          </div>
          {overdueTasks.length > 0 ? (
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-rose">
              <AlertCircle size={12} />
              {overdueTasks.length} 项逾期
            </span>
          ) : isComplete ? (
            <span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-accent-emerald">
              <CheckCircle2 size={12} />
              目标已达成
            </span>
          ) : null}
        </div>

        <span className="plan-workspace-goal-open absolute right-4 top-4 text-foreground-muted md:static">
          <ArrowRight size={17} />
        </span>
      </Link>
      {onDelete && (
        <div className="plan-workspace-goal-actions absolute bottom-3 right-3 z-[2] flex items-center md:bottom-auto md:right-11 md:top-1/2 md:-translate-y-1/2">
          <button
            type="button"
            onClick={() => onDelete(plan)}
            className="plan-workspace-goal-delete inline-flex h-11 w-11 items-center justify-center rounded-xl text-foreground-muted transition-colors hover:bg-accent-rose/10 hover:text-accent-rose"
            aria-label={`删除计划：${plan.title}`}
            title="删除计划"
          >
            <Trash2 size={16} />
          </button>
        </div>
      )}
    </article>
  );
}
