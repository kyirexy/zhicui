'use client';

import Link from 'next/link';
import { AlertCircle, Calendar, CheckSquare, TrendingUp, Layers } from 'lucide-react';
import type { PlanData } from '@/lib/types';
import { getOverdueTasks, getPlanCurrentDay, getPlanProgress, getTodayTasks } from '@/lib/types';

interface PlanCardProps {
  plan: PlanData;
}

export default function PlanCard({ plan }: PlanCardProps) {
  const { done, total, pct } = getPlanProgress(plan);
  const currentDay = getPlanCurrentDay(plan);
  const totalDays = plan.total_days || plan.days?.length || 0;
  const todayTasks = getTodayTasks(plan);
  const overdueTasks = getOverdueTasks(plan);

  // Count completed days (days where ALL tasks are done)
  const completedDays = plan.days?.filter(d => d.tasks.length > 0 && d.tasks.every(t => t.done)).length || 0;
  const isComplete = plan.status === 'done' || (total > 0 && pct === 100);

  return (
    <Link
      href={`/plans?id=${plan.id}`}
      className={`glass-card plan-card p-4 md:p-5 group cursor-pointer block text-foreground no-underline relative overflow-hidden ${
        isComplete ? 'border-accent-emerald/40 ring-1 ring-accent-emerald/20' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-3 relative">
        <h3 className="text-sm md:text-base font-semibold text-foreground line-clamp-2 text-balance leading-snug">
          {plan.title}
        </h3>
        {isComplete && (
          <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-full bg-accent-emerald/15 border border-accent-emerald/30 text-accent-emerald font-medium">
            已完成
          </span>
        )}
      </div>

      {/* Day & task progress */}
      <div className="mb-3 space-y-1.5">
        <div className="flex items-center justify-between text-xs text-foreground-muted">
          <span className="flex items-center gap-1">
            <Calendar size={11} />
            {totalDays > 0 ? `第 ${Math.min(currentDay, totalDays)}/${totalDays} 天` : '未设周期'}
          </span>
          <span className="flex items-center gap-1">
            <CheckSquare size={11} />
            {done}/{total} 项
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-1.5 rounded-full bg-card-bg overflow-hidden">
          <div
            className="h-full rounded-full bg-accent-emerald transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Day completion dots */}
        {totalDays > 0 && totalDays <= 28 && (
          <div className="flex gap-1 mt-1.5">
            {Array.from({ length: totalDays }, (_, i) => i + 1).map(d => {
              const dayData = plan.days?.find(dd => dd.day === d);
              const allDone = dayData && dayData.tasks.length > 0 && dayData.tasks.every(t => t.done);
              const isToday = d === currentDay;
              return (
                <div
                  key={d}
                  className={`flex-1 h-1 rounded-full transition-all duration-300 ${
                    allDone ? 'bg-accent-emerald' : isToday ? 'bg-accent-emerald/30 ring-1 ring-accent-emerald/50' : 'bg-card-border/40'
                  }`}
                  title={`第${d}天${allDone ? ' ✓' : isToday ? ' (今天)' : ''}`}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-foreground-muted">
        <span className="flex items-center gap-1">
          <TrendingUp size={11} />
          {completedDays > 0 ? (
            <span className="text-accent-emerald font-medium">已完成 {completedDays} 天</span>
          ) : overdueTasks.length > 0 ? (
            <span className="flex items-center gap-1 text-accent-rose font-medium">
              <AlertCircle size={10} />{overdueTasks.length} 项已逾期
            </span>
          ) : todayTasks.length > 0 ? (
            <span className="text-accent-emerald font-medium">{todayTasks.length} 项今日聚焦</span>
          ) : (
            <span className="flex items-center gap-1"><Layers size={10} />{plan.days?.length || 0} 天 · {total} 项任务</span>
          )}
        </span>
        <span className="text-accent-emerald opacity-0 group-hover:opacity-100 transition-opacity">
          查看详情 →
        </span>
      </div>
    </Link>
  );
}
