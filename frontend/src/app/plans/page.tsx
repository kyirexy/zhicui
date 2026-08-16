'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  CalendarBlank,
  CaretRight,
  Check,
  CheckCircle,
  ClockCountdown,
  Note,
  PencilSimple,
  Plus,
  SpinnerGap,
  Target,
  Trash,
} from '@phosphor-icons/react';
import {
  deletePlan,
  getPlan,
  getPlanOverview,
  listPlans,
  togglePlanTask,
  updatePlan,
} from '@/lib/api';
import type { PlanData, PlanFocusTask, PlanOverview } from '@/lib/types';
import {
  formatPlanFieldValue,
  getChinaToday,
  getPlanCurrentDay,
  getPlanProgress,
  getPlanTasks,
} from '@/lib/types';
import BottomSheet from '@/components/BottomSheet';
import PlanCoachPanel from '@/components/plans/PlanCoachPanel';
import PlanQuickCapture from '@/components/plans/PlanQuickCapture';
import PlanTaskBoard from '@/components/plans/PlanTaskBoard';
import PlanTodayView from '@/components/plans/PlanTodayView';
import PlanWeeklyReviewView from '@/components/plans/PlanWeeklyReview';
import styles from '@/components/plans/PlanWorkspace.module.css';

type WorkspaceView = 'today' | 'plans' | 'review';
type PlanFilter = 'active' | 'done';
type CaptureMode = 'plan' | 'task';

function LoadingState() {
  return (
    <div className={styles.loading} aria-label="正在读取行动计划">
      <div className={styles.loadingBlock} />
      <div className={styles.loadingBlock} />
      <div className={styles.loadingBlock} />
    </div>
  );
}

function ConfirmDialog({
  title,
  description,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  pending: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef(pending);
  const cancelRef = useRef(onCancel);

  useEffect(() => {
    pendingRef.current = pending;
    cancelRef.current = onCancel;
  }, [onCancel, pending]);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusFirst = () => dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    const frame = window.requestAnimationFrame(focusFirst);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pendingRef.current) {
        event.preventDefault();
        cancelRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className={styles.dialogBackdrop} role="presentation" onPointerDown={event => event.target === event.currentTarget && !pending && onCancel()}>
      <section ref={dialogRef} tabIndex={-1} className={styles.dialog} role="alertdialog" aria-modal="true" aria-labelledby="plan-confirm-title" aria-describedby="plan-confirm-description">
        <h2 id="plan-confirm-title">{title}</h2>
        <p id="plan-confirm-description">{description}</p>
        {error && <p className={styles.dialogError} role="alert">{error}</p>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.secondaryButton} onClick={onCancel} disabled={pending}>取消</button>
          <button type="button" className={styles.dangerButton} onClick={onConfirm} disabled={pending}>
            {pending && <SpinnerGap size={15} className="animate-spin" />}
            确认删除
          </button>
        </div>
      </section>
    </div>
  );
}

function GoalRow({ plan, onDelete }: { plan: PlanData; onDelete: () => void }) {
  const progress = getPlanProgress(plan);
  const nextTask = getPlanTasks(plan).find(task => !task.done);
  const complete = plan.status === 'done';
  return (
    <article className={styles.goalRow}>
      <Link href={`/plans?id=${plan.id}`} className={styles.goalLink} aria-label={`打开计划：${plan.title}`} />
      <div className={styles.goalMain}>
        <span className={styles.goalStatus}><i />{complete ? '已完成' : plan.note_id ? '来自视频' : '手动计划'}</span>
        <h3 className={styles.goalTitle}>{plan.title}</h3>
      </div>
      <div className={styles.goalNext}>
        <span>{complete ? '完成状态' : '下一步'}</span>
        <strong>{complete ? '目标已经达成' : nextTask?.title || '还没有执行任务'}</strong>
      </div>
      <div className={styles.goalProgress}>
        <span>进度</span>
        <div className={styles.progressTrack}><i style={{ width: `${progress.pct}%` }} /></div>
        <span className={styles.progressLabel}>{progress.done}/{progress.total} · {progress.pct}%</span>
      </div>
      <div className={styles.goalActions}>
        <button type="button" className={styles.iconButton} onClick={onDelete} aria-label={`删除计划：${plan.title}`}>
          <Trash size={16} />
        </button>
        <span className={styles.iconButton}><CaretRight size={16} /></span>
      </div>
    </article>
  );
}

function PlansWorkspace() {
  const [plans, setPlans] = useState<PlanData[]>([]);
  const [overview, setOverview] = useState<PlanOverview | null>(null);
  const [totalPlans, setTotalPlans] = useState(0);
  const [view, setView] = useState<WorkspaceView>('today');
  const [filter, setFilter] = useState<PlanFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('plan');
  const [deleteTarget, setDeleteTarget] = useState<PlanData | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError('');
    const [plansResponse, overviewResponse] = await Promise.all([
      listPlans(1, 100),
      getPlanOverview(getChinaToday()),
    ]);
    if (plansResponse.success && plansResponse.data) {
      setPlans(plansResponse.data.items);
      setTotalPlans(plansResponse.data.total);
    } else {
      setError(plansResponse.error || '计划暂时无法读取，请稍后重试。');
    }
    if (overviewResponse.success && overviewResponse.data) {
      setOverview(overviewResponse.data);
    } else if (!plansResponse.error) {
      setError(overviewResponse.error || '今天的行动暂时无法读取。');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openCapture = (mode: CaptureMode) => {
    setCaptureMode(mode);
    setCaptureOpen(true);
  };

  const toggleFocusTask = async (task: PlanFocusTask) => {
    const key = `${task.plan_id}:${task.task_id}`;
    if (busyKeys.has(key)) return;
    setBusyKeys(current => new Set(current).add(key));
    setError('');
    const response = await togglePlanTask(task.plan_id, task.task_id);
    if (response.success && response.data) {
      setPlans(current => current.map(plan => plan.id === response.data!.id ? response.data! : plan));
      const overviewResponse = await getPlanOverview(overview?.date || getChinaToday());
      if (overviewResponse.success && overviewResponse.data) setOverview(overviewResponse.data);
    } else {
      setError(response.error || '任务状态更新失败，请重试。');
    }
    setBusyKeys(current => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const changeOverviewDate = useCallback(async (date: string) => {
    setError('');
    const response = await getPlanOverview(date);
    if (response.success && response.data) {
      setOverview(response.data);
    } else {
      setError(response.error || '所选日期的行动暂时无法读取。');
    }
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError('');
    const response = await deletePlan(deleteTarget.id);
    if (response.success) {
      setDeleteTarget(null);
      await load(false);
    } else {
      setError(response.error || '计划删除失败，请重试。');
    }
    setDeleting(false);
  };

  const filteredPlans = useMemo(
    () => plans.filter(plan => filter === 'done' ? plan.status === 'done' : plan.status !== 'done'),
    [filter, plans],
  );
  const completedCount = plans.filter(plan => plan.status === 'done').length;

  if (loading) return <LoadingState />;

  return (
    <main className={styles.shell}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>行动计划</h1>
          <div className={styles.headerSummary} aria-label="计划概览">
            <span><strong>{plans.filter(plan => plan.status !== 'done').length}</strong> 个进行中</span>
            <span><strong>{overview?.summary.open_tasks || 0}</strong> 项待办</span>
          </div>
        </div>
        <button type="button" className={styles.primaryButton} onClick={() => openCapture('plan')}>
          <Plus size={16} weight="bold" />新建计划
        </button>
      </header>

      <nav className={styles.tabs} role="tablist" aria-label="行动计划视图">
        {([
          ['today', '今日', overview?.summary.focus_tasks || overview?.summary.due_today || 0],
          ['plans', '目标', totalPlans],
          ['review', '复盘', completedCount],
        ] as const).map(([value, label, count]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view === value}
            className={`${styles.tab} ${view === value ? styles.tabActive : ''}`}
            onClick={() => setView(value)}
          >
            {label}{count > 0 && <span className={styles.tabCount}>{count}</span>}
          </button>
        ))}
      </nav>

      {error && <p className={styles.error} role="alert">{error}</p>}

      {view === 'today' && overview && (
        <PlanTodayView
          overview={overview}
          busyKeys={busyKeys}
          onToggle={task => void toggleFocusTask(task)}
          onOverview={setOverview}
          onDateChange={changeOverviewDate}
          onQuickTask={() => openCapture(plans.some(plan => plan.status !== 'done') ? 'task' : 'plan')}
          onNewPlan={() => openCapture('plan')}
        />
      )}

      {view === 'plans' && (
        <section aria-labelledby="plans-list-title">
          <div className={styles.goalToolbar}>
            <h2 id="plans-list-title" className="sr-only">全部目标</h2>
            <div className={styles.segmented} aria-label="计划筛选">
              <button type="button" className={`${styles.segment} ${filter === 'active' ? styles.segmentActive : ''}`} onClick={() => setFilter('active')}>进行中</button>
              <button type="button" className={`${styles.segment} ${filter === 'done' ? styles.segmentActive : ''}`} onClick={() => setFilter('done')}>已完成</button>
            </div>
          </div>
          {filteredPlans.length > 0 ? (
            <div className={styles.goalList}>
              {filteredPlans.map(plan => (
                <GoalRow key={plan.id} plan={plan} onDelete={() => setDeleteTarget(plan)} />
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}><Target size={21} weight="duotone" /></span>
              <h3>{filter === 'done' ? '还没有完成的目标' : '先创建第一个目标'}</h3>
              <p>{filter === 'done' ? '完成的计划会出现在这里。' : '先创建一个想实现的目标。'}</p>
              {filter === 'active' && <button type="button" className={styles.primaryButton} onClick={() => openCapture('plan')}>创建计划</button>}
            </div>
          )}
        </section>
      )}

      {view === 'review' && <PlanWeeklyReviewView />}

      <button type="button" className={styles.floatingAdd} onClick={() => openCapture('plan')} aria-label="快速新增">
        <Plus size={21} weight="bold" />
      </button>

      <PlanQuickCapture
        open={captureOpen}
        plans={plans}
        initialMode={captureMode}
        onClose={() => setCaptureOpen(false)}
        onSaved={(_plan, _created) => void load(false)}
      />

      {deleteTarget && (
        <ConfirmDialog
          title={`删除“${deleteTarget.title}”？`}
          description="计划、任务和打卡记录会一起删除，且无法恢复。"
          pending={deleting}
          error={error}
          onCancel={() => !deleting && setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </main>
  );
}

function PlanDetail({ id }: { id: string }) {
  const router = useRouter();
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [metaOpen, setMetaOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [startDateDraft, setStartDateDraft] = useState('');
  const [daysDraft, setDaysDraft] = useState('');
  const [savingMeta, setSavingMeta] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    void getPlan(id).then(response => {
      if (response.success && response.data) {
        setPlan(response.data);
        setTitleDraft(response.data.title);
        setStartDateDraft(response.data.start_date || getChinaToday());
        setDaysDraft(response.data.total_days ? String(response.data.total_days) : '');
      } else {
        setError(response.error || '计划不存在或已经删除。');
      }
      setLoading(false);
    });
  }, [id]);

  const updateLocal = (next: PlanData) => {
    setPlan(next);
    setTitleDraft(next.title);
    setStartDateDraft(next.start_date || getChinaToday());
    setDaysDraft(next.total_days ? String(next.total_days) : '');
  };

  const saveMeta = async () => {
    if (!plan || !titleDraft.trim() || savingMeta) return;
    setSavingMeta(true);
    setError('');
    const response = await updatePlan(plan.id, {
      title: titleDraft.trim(),
      start_date: startDateDraft || null,
      total_days: daysDraft ? Number(daysDraft) : 0,
    });
    if (response.success && response.data) {
      updateLocal(response.data);
      setMetaOpen(false);
    } else {
      setError(response.error || '计划信息保存失败。');
    }
    setSavingMeta(false);
  };

  const toggleStatus = async () => {
    if (!plan || savingMeta) return;
    setSavingMeta(true);
    setError('');
    const response = await updatePlan(plan.id, { status: plan.status === 'done' ? 'active' : 'done' });
    if (response.success && response.data) updateLocal(response.data);
    else setError(response.error || '计划状态更新失败。');
    setSavingMeta(false);
  };

  const remove = async () => {
    if (!plan || deleting) return;
    setDeleting(true);
    const response = await deletePlan(plan.id);
    if (response.success) router.replace('/plans');
    else {
      setError(response.error || '计划删除失败。');
      setDeleting(false);
    }
  };

  if (loading) return <LoadingState />;
  if (!plan) {
    return (
      <main className={styles.shell}>
        <div className={styles.emptyState}>
          <h3>无法打开这份计划</h3>
          <p>{error}</p>
          <button type="button" className={styles.primaryButton} onClick={() => router.replace('/plans')}>返回行动计划</button>
        </div>
      </main>
    );
  }

  const progress = getPlanProgress(plan);
  const currentDay = getPlanCurrentDay(plan);

  return (
    <main className={styles.shell}>
      <button type="button" className={`${styles.quietButton} ${styles.backButton}`} onClick={() => router.replace('/plans')}>
        <ArrowLeft size={16} />返回行动计划
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}

      <header className={styles.detailHeader}>
        <div className={styles.detailTopline}>
          <div className="min-w-0">
            <span className={styles.eyebrow}>{plan.status === 'done' ? '目标已完成' : '正在推进'}</span>
            <h1 className={styles.detailTitle}>{plan.title}</h1>
            <div className={styles.detailMeta}>
              <span><CalendarBlank size={14} />第 {currentDay}/{plan.total_days || '?'} 天</span>
              <span><CheckCircle size={14} />{progress.done}/{progress.total} 已完成</span>
              <span><ClockCountdown size={14} />{progress.pct}%</span>
              <span>{plan.note_id ? '来自视频资料' : '手动计划'}</span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={styles.secondaryButton} onClick={() => setMetaOpen(true)}>
              <PencilSimple size={15} />编辑
            </button>
            <button type="button" className={plan.status === 'done' ? styles.secondaryButton : styles.primaryButton} onClick={() => void toggleStatus()} disabled={savingMeta}>
              {savingMeta ? <SpinnerGap size={15} className="animate-spin" /> : <Check size={15} />}
              {plan.status === 'done' ? '重新开启' : '完成计划'}
            </button>
          </div>
        </div>
      </header>

      <div className={styles.detailGrid}>
        <div className={styles.detailMain}>
          <PlanTaskBoard plan={plan} onMutate={updateLocal} />
        </div>
        <aside className={`${styles.detailAside} ${styles.sticky}`}>
          <PlanCoachPanel plan={plan} onMutate={updateLocal} />

          {plan.fields.length > 0 && (
            <details className={styles.fieldsDisclosure}>
              <summary><span>计划依据与细节 · {plan.fields.length}</span><CaretRight size={15} /></summary>
              <div className={styles.fieldList}>
                {plan.fields.map((field, index) => (
                  <div key={`${field.name}-${index}`} className={styles.fieldItem}>
                    <small>{field.label}</small>
                    <strong>{formatPlanFieldValue(field.value)}</strong>
                  </div>
                ))}
              </div>
            </details>
          )}

          {plan.note_id && (
            <Link href={`/notes?id=${plan.note_id}`} className={styles.sourceLink}>
              <span className="inline-flex items-center gap-2"><Note size={15} />查看计划来源</span>
              <CaretRight size={15} />
            </Link>
          )}

          <button type="button" className={styles.dangerButton} onClick={() => { setError(''); setDeleteOpen(true); }}>
            <Trash size={15} />删除计划
          </button>
        </aside>
      </div>

      <BottomSheet open={metaOpen} onClose={() => !savingMeta && setMetaOpen(false)} title="编辑计划">
        <form
          className={styles.sheetForm}
          onSubmit={event => {
            event.preventDefault();
            void saveMeta();
          }}
        >
          <label className={styles.field}>
            <span>目标名称</span>
            <input value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={256} autoFocus />
          </label>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>开始日期</span>
              <input type="date" value={startDateDraft} onChange={event => setStartDateDraft(event.target.value)} />
            </label>
            <label className={styles.field}>
              <span>计划天数</span>
              <input type="number" min={0} max={3650} value={daysDraft} onChange={event => setDaysDraft(event.target.value)} />
            </label>
          </div>
          <div className={styles.sheetActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setMetaOpen(false)} disabled={savingMeta}>取消</button>
            <button type="submit" className={styles.primaryButton} disabled={savingMeta || !titleDraft.trim()}>
              {savingMeta && <SpinnerGap size={15} className="animate-spin" />}保存
            </button>
          </div>
        </form>
      </BottomSheet>

      {deleteOpen && (
        <ConfirmDialog
          title={`删除“${plan.title}”？`}
          description="计划、任务和全部打卡记录会一起删除，且无法恢复。"
          pending={deleting}
          error={error}
          onCancel={() => !deleting && setDeleteOpen(false)}
          onConfirm={() => void remove()}
        />
      )}
    </main>
  );
}

function PlansRoute() {
  const searchParams = useSearchParams();
  const planId = searchParams.get('id');
  return planId ? <PlanDetail id={planId} /> : <PlansWorkspace />;
}

export default function PlansPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <PlansRoute />
    </Suspense>
  );
}
