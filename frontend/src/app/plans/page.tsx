'use client';

import { useCallback, useEffect, useState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Calendar, CheckSquare, Target, CalendarDays, Trash2, Check, Loader2, Sun, Pencil, RotateCcw } from 'lucide-react';
import { ListChecks } from '@phosphor-icons/react';
import { listPlans, getPlan, getPlanOverview, deletePlan, togglePlanTask, updatePlan } from '@/lib/api';
import type { PlanData, PlanDay, PlanField, PlanOverview } from '@/lib/types';
import {
  formatPlanDuration,
  formatPlanFieldValue,
  formatPlanSchedule,
  getOverdueTasks,
  getPlanCurrentDay,
  getPlanProgress,
  getTodayTasks,
  getTodayDayTasks,
  getTodayDay,
} from '@/lib/types';
import PlanCard from '@/components/PlanCard';
import PlanExecutionOverview from '@/components/PlanExecutionOverview';
import PlanTaskList from '@/components/PlanTaskList';
import PlanDynamicField from '@/components/PlanDynamicField';
import PlanDeleteDialog from '@/components/PlanDeleteDialog';

function PlansContent() {
  const searchParams = useSearchParams();
  const planId = searchParams.get('id');
  const showPlanList = useCallback(() => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('id');
    window.history.replaceState(
      null,
      '',
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    );
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  return planId ? <PlanDetail id={planId} onBack={showPlanList} /> : <PlanList />;
}

function groupPlanFields(fields: PlanField[]): { label: string; fields: PlanField[] }[] {
  const groups = new Map<string, PlanField[]>();
  for (const field of fields) {
    const group = field.group?.trim() || '计划信息';
    groups.set(group, [...(groups.get(group) ?? []), field]);
  }
  return Array.from(groups, ([label, groupedFields]) => ({ label, fields: groupedFields }));
}

/* ------------------------------------------------------------------ */
/* List view                                                          */
/* ------------------------------------------------------------------ */

function PlanList() {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [filter, setFilter] = useState<'all' | 'today' | 'overdue' | 'done'>('all');
  const [deleteTarget, setDeleteTarget] = useState<PlanData | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const load = useCallback(async (p: number) => {
    setLoading(true);
    const [plansResponse, overviewResponse] = await Promise.all([
      listPlans(p),
      getPlanOverview(),
    ]);
    if (plansResponse.success && plansResponse.data) {
      setPlans(plansResponse.data.items);
      setTotalPages(plansResponse.data.total_pages);
      setPage(plansResponse.data.page);
    }
    if (overviewResponse.success && overviewResponse.data) {
      setOverview(overviewResponse.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(1); }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget || deletePending) return;
    setDeletePending(true);
    setDeleteError('');
    const response = await deletePlan(deleteTarget.id);
    if (response.success) {
      setPlans(current => current.filter(plan => plan.id !== deleteTarget.id));
      setDeleteTarget(null);
      const overviewResponse = await getPlanOverview();
      if (overviewResponse.success && overviewResponse.data) {
        setOverview(overviewResponse.data);
      }
    } else {
      setDeleteError(response.error || '计划删除失败，请重试。');
    }
    setDeletePending(false);
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const todayCount = plans.filter(plan => getTodayTasks(plan).length > 0).length;
  const overdueCount = plans.filter(plan => getOverdueTasks(plan).length > 0).length;
  const doneCount = plans.filter(plan => plan.status === 'done').length;
  const visiblePlans = plans.filter(plan => {
    if (filter === 'today') return getTodayTasks(plan).length > 0;
    if (filter === 'overdue') return getOverdueTasks(plan).length > 0;
    if (filter === 'done') return plan.status === 'done';
    return true;
  });

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 md:mb-8">
        <h1 className="flex items-center gap-2.5 text-xl md:text-3xl font-bold text-foreground tracking-tight">
          <ListChecks size={30} weight="duotone" className="text-accent-emerald" />
          计划工作台
        </h1>
        <p className="text-foreground-muted text-sm mt-1">
          把视频里的方法整理成每天真正能推进的行动
        </p>
      </div>

      {overview && <PlanExecutionOverview overview={overview} />}

      {/* Filter tabs */}
      {plans.length > 0 && (
        <div className="flex items-center gap-2 mb-5 overflow-x-auto pb-1">
          <FilterTab active={filter === 'all'} onClick={() => setFilter('all')} label="全部" count={plans.length} />
          <FilterTab active={filter === 'today'} onClick={() => setFilter('today')} label="今天" count={todayCount} highlight />
          <FilterTab active={filter === 'overdue'} onClick={() => setFilter('overdue')} label="逾期" count={overdueCount} highlight />
          <FilterTab active={filter === 'done'} onClick={() => setFilter('done')} label="完成" count={doneCount} />
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
          <CheckSquare size={32} className="text-accent-emerald mb-3" />
          <p className="text-foreground-secondary text-sm">
            {filter === 'today' ? '今天没有到期任务' : filter === 'overdue' ? '没有逾期任务' : '暂无已完成计划'}
          </p>
          <button onClick={() => setFilter('all')} className="text-accent-emerald hover:underline text-sm mt-3">查看全部计划</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          {visiblePlans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onDelete={(target) => {
                setDeleteError('');
                setDeleteTarget(target);
              }}
            />
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
      <PlanDeleteDialog
        plan={deleteTarget}
        pending={deletePending}
        error={deleteError}
        onClose={() => {
          if (deletePending) return;
          setDeleteTarget(null);
          setDeleteError('');
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail view                                                        */
/* ------------------------------------------------------------------ */

function PlanDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingMetadata, setSavingMetadata] = useState(false);
  const [todayMutating, setTodayMutating] = useState<Set<string>>(new Set());
  useEffect(() => {
    getPlan(id).then((res) => {
      if (res.success && res.data) {
        setPlan(res.data);
        setTitleDraft(res.data.title);
      } else {
        setError(res.error || '加载失败');
      }
      setLoading(false);
    });
  }, [id]);

  const handleMutate = (nextPlan: PlanData) => setPlan(nextPlan);

  // Quick-toggle from the "today" pinned card. Shares plan state with PlanTaskList.
  const handleTodayToggle = async (taskId: string) => {
    if (!plan) return;
    const previous = plan;
    const optimistic = {
      ...plan,
      tasks: plan.tasks?.map(task => task.id === taskId ? { ...task, done: !task.done } : task) ?? [],
      days: plan.days?.map(day => ({
        ...day,
        tasks: day.tasks.map(task => task.id === taskId ? { ...task, done: !task.done } : task),
      })) ?? [],
    };
    setPlan(optimistic);
    setTodayMutating(s => new Set(s).add(taskId));
    setActionError('');
    const res = await togglePlanTask(plan.id, taskId);
    if (res.success && res.data) {
      setPlan(res.data);
    } else {
      setPlan(previous);
      setActionError(res.error || '任务状态更新失败，请重试。');
    }
    setTodayMutating(s => { const n = new Set(s); n.delete(taskId); return n; });
  };

  const handleDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    const res = await deletePlan(id);
    if (res.success) {
      setDeleteDialogOpen(false);
      onBack();
    } else {
      setDeleteError(res.error || '计划删除失败，请重试。');
      setDeleting(false);
    }
  };

  const saveTitle = async () => {
    if (!plan || !titleDraft.trim() || titleDraft.trim() === plan.title) {
      setEditingTitle(false);
      setTitleDraft(plan?.title ?? '');
      return;
    }
    setSavingMetadata(true);
    setActionError('');
    const response = await updatePlan(plan.id, { title: titleDraft.trim() });
    if (response.success && response.data) {
      setPlan(response.data);
      setTitleDraft(response.data.title);
      setEditingTitle(false);
    } else {
      setActionError(response.error || '计划标题保存失败，请重试。');
    }
    setSavingMetadata(false);
  };

  const togglePlanStatus = async () => {
    if (!plan) return;
    setSavingMetadata(true);
    setActionError('');
    const nextStatus = plan.status === 'done' ? 'active' : 'done';
    const response = await updatePlan(plan.id, { status: nextStatus });
    if (response.success && response.data) {
      setPlan(response.data);
    } else {
      setActionError(response.error || '计划状态更新失败，请重试。');
    }
    setSavingMetadata(false);
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
        <button
          type="button"
          onClick={onBack}
          className="text-accent-emerald hover:underline text-sm"
        >
          ← 返回计划列表
        </button>
      </div>
    );
  }

  const progress = getPlanProgress(plan);
  const currentDay = getPlanCurrentDay(plan);
  const todayTasks = getTodayTasks(plan);
  // Fallback: if the LLM returned a flat tasks array (no day structure),
  // synthesize a single-day PlanDay so PlanTaskList can render them.
  const days: PlanDay[] = plan.days?.length
    ? plan.days
    : plan.tasks?.length
      ? [{ day: 1, label: '第1天', tasks: plan.tasks }]
      : [];
  const fieldGroups = groupPlanFields(plan.fields ?? []);

  return (
    <div className="max-w-5xl mx-auto pb-24">
      <div className="mb-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-foreground-secondary hover:text-foreground transition-colors text-sm px-3 py-2.5 rounded-lg hover:bg-white/5 min-h-[44px]"
        >
          <ArrowLeft size={14} />返回计划列表
        </button>
        <button
          type="button"
          onClick={() => {
            setDeleteError('');
            setDeleteDialogOpen(true);
          }}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 text-foreground-muted hover:text-accent-rose hover:bg-accent-rose/10 transition-colors text-xs px-3 py-2 rounded-lg min-h-[44px]"
          aria-label="删除计划">
          <Trash2 size={13} />
          <span>{deleting ? '删除中...' : '删除计划'}</span>
        </button>
      </div>

      {/* Header with key metrics */}
      <div className="mb-8">
        <div className="plan-title-row">
          {editingTitle ? (
            <form
              className="plan-title-editor"
              onSubmit={event => {
                event.preventDefault();
                void saveTitle();
              }}
            >
              <input
                value={titleDraft}
                onChange={event => setTitleDraft(event.target.value)}
                maxLength={256}
                autoFocus
                aria-label="计划标题"
              />
              <button type="submit" disabled={savingMetadata || !titleDraft.trim()} className="plan-primary-button">
                {savingMetadata ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                保存
              </button>
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(plan.title);
                  setEditingTitle(false);
                }}
                className="plan-secondary-button"
              >
                取消
              </button>
            </form>
          ) : (
            <>
              <h1 className="text-xl md:text-2xl font-bold text-foreground leading-snug text-balance">{plan.title}</h1>
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="plan-icon-button"
                aria-label="修改计划标题"
              >
                <Pencil size={15} />
              </button>
            </>
          )}
        </div>
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
        {actionError && <p className="plan-inline-error mt-3" role="alert">{actionError}</p>}
      </div>

      {/* 2-column layout (desktop) */}
      <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
        <section className="flex-1 lg:flex-[2] min-w-0">
          {/* Today pinned card — surfaces the current day's todos at the top. */}
          <TodayCard plan={plan} onToggle={handleTodayToggle} mutatingIds={todayMutating} />
          <PlanTaskList plan={plan} onMutate={handleMutate} />
        </section>

        {/* Right: meta + dynamic fields (narrower sidebar on desktop) */}
        <aside className="lg:flex-[1] lg:min-w-[240px]">
          <div className="space-y-4 lg:sticky lg:top-24">
            {/* Status badge */}
            <div className="plan-status-panel">
              <div>
                <Target size={15} className="text-accent-emerald" />
                <span>
                  <strong>{plan.status === 'done' ? '计划已完成' : '计划进行中'}</strong>
                  <small>{plan.status === 'done' ? '需要时可以重新开启' : '所有任务完成后会自动归档'}</small>
                </span>
              </div>
              <button
                type="button"
                onClick={() => void togglePlanStatus()}
                disabled={savingMetadata}
                className={plan.status === 'done' ? 'plan-secondary-button' : 'plan-primary-button'}
              >
                {savingMetadata
                  ? <Loader2 size={14} className="animate-spin" />
                  : plan.status === 'done'
                    ? <RotateCcw size={14} />
                    : <Check size={14} />}
                {plan.status === 'done' ? '重新开启' : '标记完成'}
              </button>
            </div>

            {fieldGroups.length > 0 && (
              <details className="plan-details-disclosure">
                <summary>
                  <span>
                    <strong>计划细节</strong>
                    <small>{plan.fields.length} 项 AI 规划信息</small>
                  </span>
                  <ChevronDetails />
                </summary>
                <div className="plan-field-groups">
                  {fieldGroups.map(group => (
                    <section key={group.label} className="plan-field-group">
                      <header>
                        <h2 className="text-balance">{group.label}</h2>
                        <span className="tabular-nums">{group.fields.length} 项</span>
                      </header>
                      <div className="space-y-3">
                        {group.fields.map((field, index) => (
                          <PlanDynamicField
                            key={`${field.name}-${index}`}
                            field={field}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              </details>
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
      <PlanDeleteDialog
        plan={deleteDialogOpen ? plan : null}
        pending={deleting}
        error={deleteError}
        onClose={() => {
          if (deleting) return;
          setDeleteDialogOpen(false);
          setDeleteError('');
        }}
        onConfirm={() => void handleDelete()}
      />
    </div>
  );
}

function ChevronDetails() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="m9 18 6-6-6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
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
      className={`inline-flex flex-shrink-0 items-center gap-1.5 px-3.5 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors min-h-[40px] ${
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
            const taskMeta = [
              formatPlanSchedule(t.scheduled_at),
              formatPlanDuration(t.duration_minutes),
              t.frequency,
              ...(t.details?.slice(0, 2).map(detail => (
                `${detail.label} ${formatPlanFieldValue(detail.value)}`
              )) ?? []),
            ].filter(Boolean).join(' · ');
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onToggle(t.id)}
                disabled={busy}
                className={`plan-today-task ${t.done ? 'is-done' : ''}`}
              >
                <span className="plan-today-task__check">
                  {busy ? <Loader2 size={12} className="animate-spin text-accent-emerald" /> : t.done ? <Check size={12} className="text-white" strokeWidth={3} /> : null}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="plan-today-task__title">{t.title}</span>
                  {taskMeta && (
                    <small className="mt-0.5 block truncate text-[11px] text-foreground-muted">
                      {taskMeta}
                    </small>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
