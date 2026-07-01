'use client';

import { useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Calendar, CheckSquare, Target, CalendarDays, Trash2, Check, Loader2, Sun } from 'lucide-react';
import { listPlans, getPlan, deletePlan, togglePlanTask } from '@/lib/api';
import { useRouter } from 'next/navigation';
import type { PlanData, PlanDay } from '@/lib/types';
import { getPlanCurrentDay, getPlanProgress, getTodayTasks, getTodayDayTasks, getTodayDay } from '@/lib/types';
import PlanCard from '@/components/PlanCard';
import PlanTaskList from '@/components/PlanTaskList';
import PlanDynamicField from '@/components/PlanDynamicField';

function PlansContent() {
  const searchParams = useSearchParams();
  const planId = searchParams.get('id');
  return planId ? <PlanDetail id={planId} /> : <PlanList />;
}

/* ------------------------------------------------------------------ */
/* List view                                                          */
/* ------------------------------------------------------------------ */

function PlanList() {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filter, setFilter] = useState<'all' | 'today'>('all');

  const load = (p: number) => {
    setLoading(true);
    listPlans(p).then((res) => {
      if (res.success && res.data) {
        setPlans(res.data.items);
        setTotalPages(res.data.total_pages);
        setPage(res.data.page);
      }
      setLoading(false);
    });
  };

  useEffect(() => { load(1); }, []);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const todayCount = plans.filter(p => getTodayDayTasks(p).length > 0).length;
  const visiblePlans = filter === 'today' ? plans.filter(p => getTodayDayTasks(p).length > 0) : plans;

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-3xl font-bold text-foreground tracking-tight">
          📋 我的计划
        </h1>
        <p className="text-foreground-muted text-sm mt-1">
          AI 从计划类视频中自动提取的任务清单
        </p>
      </div>

      {/* Filter tabs */}
      {plans.length > 0 && (
        <div className="flex items-center gap-2 mb-5">
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')} label="全部" count={plans.length} />
          <FilterTab active={filter === 'today'} onClick={() => setFilter('today')} label="今日到期" count={todayCount} highlight />
        </div>
      )}

      {plans.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center text-center px-4">
          <p className="text-4xl mb-4">📋</p>
          <p className="text-foreground-secondary mb-2 text-sm">暂无计划</p>
          <p className="text-foreground-muted text-xs mb-4">
            提取计划类视频后，系统会自动生成计划
          </p>
          <Link href="/" className="text-accent-emerald hover:underline text-sm">
            ← 返回首页提取视频
          </Link>
        </div>
      ) : visiblePlans.length === 0 ? (
        <div className="min-h-[30vh] flex flex-col items-center justify-center text-center px-4">
          <p className="text-3xl mb-3">🎉</p>
          <p className="text-foreground-secondary text-sm">今天没有到期的任务</p>
          <button onClick={() => setFilter('all')} className="text-accent-emerald hover:underline text-sm mt-3">查看全部计划</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {visiblePlans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-8">
          <button
            onClick={() => load(Math.max(1, page - 1))}
            disabled={page === 1}
            className="glass-input px-4 py-2 text-sm disabled:opacity-30 min-w-[44px] min-h-[44px]"
          >
            上一页
          </button>
          <span className="text-sm text-foreground-muted px-3">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => load(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="glass-input px-4 py-2 text-sm disabled:opacity-30 min-w-[44px] min-h-[44px]"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail view                                                        */
/* ------------------------------------------------------------------ */

function PlanDetail({ id }: { id: string }) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [todayMutating, setTodayMutating] = useState<Set<string>>(new Set());
  const router = useRouter();

  useEffect(() => {
    getPlan(id).then((res) => {
      if (res.success && res.data) {
        setPlan(res.data);
      } else {
        setError(res.error || '加载失败');
      }
      setLoading(false);
    });
  }, [id]);

  const handleMutate = (days: PlanDay[]) => {
    if (plan) setPlan({ ...plan, days });
  };

  // Quick-toggle from the "today" pinned card. Shares plan state with PlanTaskList.
  const handleTodayToggle = async (taskId: string) => {
    if (!plan) return;
    const prev = plan.days;
    const newDays = prev.map(d => ({ ...d, tasks: d.tasks.map(t => t.id === taskId ? { ...t, done: !t.done } : t) }));
    setPlan({ ...plan, days: newDays });
    setTodayMutating(s => new Set(s).add(taskId));
    const res = await togglePlanTask(plan.id, taskId);
    if (res.success && res.data) {
      setPlan({ ...plan, days: res.data.days || newDays });
    } else {
      setPlan({ ...plan, days: prev });
    }
    setTodayMutating(s => { const n = new Set(s); n.delete(taskId); return n; });
  };

  const handleDelete = async () => {
    if (!confirm('确定要删除这个计划吗？此操作不可撤销。')) return;
    setDeleting(true);
    const res = await deletePlan(id);
    if (res.success) {
      router.push('/plans');
    } else {
      alert('删除失败: ' + (res.error || '未知错误'));
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="skeleton h-8 w-32" />
        <div className="skeleton h-16" />
        <div className="skeleton h-64" />
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className="min-h-[40vh] flex flex-col items-center justify-center text-center">
        <p className="text-4xl mb-4">😕</p>
        <p className="text-foreground-secondary mb-4">{error || '计划不存在'}</p>
        <Link href="/plans" className="text-accent-emerald hover:underline text-sm">
          ← 返回计划列表
        </Link>
      </div>
    );
  }

  const progress = getPlanProgress(plan);
  const currentDay = getPlanCurrentDay(plan);
  const todayTasks = getTodayTasks(plan);
  const days = plan.days || [];

  return (
    <div className="max-w-2xl mx-auto pb-24">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/plans"
          className="inline-flex items-center gap-1.5 text-foreground-secondary hover:text-foreground transition-colors text-sm px-3 py-2.5 rounded-lg hover:bg-white/5 min-h-[44px]">
          <ArrowLeft size={14} />返回计划列表
        </Link>
        <button type="button" onClick={handleDelete} disabled={deleting}
          className="inline-flex items-center gap-1.5 text-foreground-muted/40 hover:text-accent-rose hover:bg-accent-rose/10 transition-colors text-xs px-3 py-2 rounded-lg min-h-[36px]"
          aria-label="删除计划">
          <Trash2 size={13} />
          <span className="hidden sm:inline">{deleting ? '删除中...' : '删除'}</span>
        </button>
      </div>

      {/* Header with key metrics */}
      <div className="mb-8">
        <h1 className="text-xl md:text-2xl font-bold text-foreground leading-snug text-balance">{plan.title}</h1>
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <span className="inline-flex items-center gap-1 text-sm text-foreground-muted">
            <CalendarDays size={14} className="text-accent-emerald" />
            第 {currentDay}/{plan.total_days || days.length || '?'} 天
          </span>
          <span className="inline-flex items-center gap-1 text-sm text-foreground-muted">
            <CheckSquare size={14} className="text-accent-emerald" />
            {progress.done}/{progress.total} 项 · {progress.pct}%
          </span>
          {todayTasks.length > 0 && (
            <span className="inline-flex items-center gap-1 text-sm text-accent-emerald font-medium">
              <Calendar size={14} />{todayTasks.length} 项今日到期
            </span>
          )}
        </div>
      </div>

      {/* 2-column layout (desktop) */}
      <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
        <section className="flex-1 lg:flex-[2] min-w-0">
          {/* Today pinned card — surfaces the current day's todos at the top. */}
          <TodayCard plan={plan} onToggle={handleTodayToggle} mutatingIds={todayMutating} />
          <PlanTaskList planId={plan.id} days={days} currentDay={currentDay} onMutate={handleMutate} />
        </section>

        {/* Right: meta + dynamic fields (narrower sidebar on desktop) */}
        <aside className="lg:flex-[1] lg:min-w-[240px]">
          <div className="space-y-4 lg:sticky lg:top-24">
            {/* Status badge */}
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-card-bg border border-card-border">
              <Target size={13} className="text-accent-emerald" />
              <span className="text-sm text-foreground-secondary">
                {plan.status === 'done' ? '已完成' : plan.status === 'draft' ? '草稿' : '进行中'}
              </span>
            </div>

            {/* Dynamic fields */}
            {plan.fields.length > 0 && (
              <div className="space-y-3">
                {plan.fields.map((f, i) => (
                  <PlanDynamicField key={i} field={f} />
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Note link */}
      {plan.note_id && (
        <div className="mt-8 pt-5 border-t border-card-border">
          <Link
            href={`/notes?id=${plan.note_id}`}
            className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-secondary transition-colors"
          >
            查看原始笔记 →
          </Link>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page export — wrapped in Suspense for useSearchParams              */
/* ------------------------------------------------------------------ */

export default function PlansPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-4xl mx-auto space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-28 rounded-xl" />
          ))}
        </div>
      }
    >
      <PlansContent />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ */
/* Filter tab                                                         */
/* ------------------------------------------------------------------ */

function FilterTab({ active, onClick, label, count, highlight }: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors min-h-[36px] ${
        active
          ? 'bg-accent-emerald/15 text-accent-emerald border border-accent-emerald/30'
          : 'bg-card-bg text-foreground-muted border border-card-border hover:text-foreground-secondary'
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`text-[11px] px-1.5 rounded-full ${highlight && !active ? 'bg-accent-rose/15 text-accent-rose' : 'bg-foreground-muted/15 text-foreground-muted'}`}>
          {count}
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Today pinned card                                                  */
/* ------------------------------------------------------------------ */

function TodayCard({ plan, onToggle, mutatingIds }: {
  plan: PlanData;
  onToggle: (taskId: string) => void;
  mutatingIds: Set<string>;
}) {
  const currentDay = getPlanCurrentDay(plan);
  const todayDay = getTodayDay(plan);
  const tasks = getTodayDayTasks(plan);

  return (
    <div className="mb-4 rounded-2xl border border-accent-emerald/25 bg-accent-emerald/[0.04] p-4">
      <div className="flex items-center gap-2 mb-3">
        <Sun size={15} className="text-accent-emerald" />
        <h3 className="text-sm font-semibold text-foreground">今日任务 · 第 {currentDay} 天</h3>
        {todayDay && (
          <span className="text-xs text-foreground-muted truncate">{todayDay.label}</span>
        )}
        <span className="ml-auto text-xs text-foreground-muted">{tasks.length} 项待办</span>
      </div>
      {!todayDay ? (
        <p className="text-sm text-foreground-muted py-1">当前天数暂无对应日程，去下方任务列表继续推进。</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-foreground-muted py-1">今天没有待办，继续加油 🎉</p>
      ) : (
        <div className="space-y-1">
          {tasks.map(t => {
            const busy = mutatingIds.has(t.id);
            return (
              <button key={t.id} type="button" onClick={() => onToggle(t.id)} disabled={busy}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl bg-card-bg/50 hover:bg-card-bg transition-colors text-left min-h-[48px] disabled:opacity-60">
                <span className={`flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                  t.done ? 'bg-accent-emerald border-accent-emerald' : 'border-card-border'
                }`}>
                  {busy ? <Loader2 size={12} className="animate-spin text-accent-emerald" /> : t.done ? <Check size={12} className="text-white" strokeWidth={3} /> : null}
                </span>
                <span className={`flex-1 min-w-0 text-sm ${t.done ? 'line-through text-foreground-muted' : 'text-foreground'}`}>{t.title}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
