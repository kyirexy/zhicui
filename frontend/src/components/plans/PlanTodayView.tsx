'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CalendarBlank,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  ClockCountdown,
  ListBullets,
  ListChecks,
  Plus,
  SlidersHorizontal,
  SpinnerGap,
  SquaresFour,
  Target,
  Tray,
  WarningCircle,
} from '@phosphor-icons/react';
import { replacePlanFocus } from '@/lib/api';
import type { PlanFocusTask, PlanOverview, PlanPriority } from '@/lib/types';
import { formatPlanDuration, formatPlanSchedule } from '@/lib/types';
import BottomSheet from '@/components/BottomSheet';
import styles from './PlanWorkspace.module.css';

type TaskView = 'list' | 'quadrant';
type QuadrantKey = 'importantUrgent' | 'important' | 'urgent' | 'later';

interface Props {
  overview: PlanOverview;
  busyKeys: Set<string>;
  onToggle: (task: PlanFocusTask) => void;
  onOverview: (overview: PlanOverview) => void;
  onDateChange: (date: string) => Promise<void>;
  onQuickTask: () => void;
  onNewPlan: () => void;
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PRIORITY_LABELS: Record<PlanPriority, string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级',
};

const QUADRANTS: Array<{
  key: QuadrantKey;
  index: string;
  title: string;
}> = [
  { key: 'importantUrgent', index: '01', title: '重要且紧急' },
  { key: 'important', index: '02', title: '重要不紧急' },
  { key: 'urgent', index: '03', title: '紧急不重要' },
  { key: 'later', index: '04', title: '不重要不紧急' },
];

function parseChinaDate(value: string) {
  return new Date(`${value}T12:00:00+08:00`);
}

function toChinaDateValue(date: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDays(value: string, amount: number) {
  const date = parseChinaDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toChinaDateValue(date);
}

function weekDates(value: string) {
  const selected = parseChinaDate(value);
  const day = selected.getUTCDay();
  const distanceFromMonday = day === 0 ? 6 : day - 1;
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(selected);
    date.setUTCDate(selected.getUTCDate() - distanceFromMonday + index);
    return toChinaDateValue(date);
  });
}

function formatSelectedDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(parseChinaDate(value));
}

function taskKey(task: PlanFocusTask) {
  return `${task.plan_id}:${task.task_id}`;
}

function taskMeta(task: PlanFocusTask) {
  return [
    formatPlanSchedule(task.scheduled_at),
    formatPlanDuration(task.duration_minutes),
    task.frequency,
    PRIORITY_LABELS[task.priority],
  ].filter(Boolean).join(' · ');
}

function uniqueTasks(groups: PlanFocusTask[][]) {
  const result: PlanFocusTask[] = [];
  const seen = new Set<string>();
  groups.flat().forEach(task => {
    const key = taskKey(task);
    if (seen.has(key)) return;
    seen.add(key);
    result.push(task);
  });
  return result;
}

function TaskRow({
  task,
  busy,
  recommended,
  onToggle,
  compact = false,
}: {
  task: PlanFocusTask;
  busy: boolean;
  recommended?: boolean;
  onToggle: (task: PlanFocusTask) => void;
  compact?: boolean;
}) {
  const meta = taskMeta(task);
  return (
    <article className={compact ? styles.compactTask : styles.focusItem}>
      <button
        type="button"
        className={styles.taskCheck}
        onClick={() => onToggle(task)}
        disabled={busy}
        aria-label={`完成任务：${task.title}`}
      >
        {busy ? <SpinnerGap size={17} className="animate-spin" /> : <Check size={17} weight="bold" />}
      </button>
      <Link href={`/plans?id=${task.plan_id}`} className={styles.taskCopy}>
        <strong className={styles.taskTitle}>{task.title}</strong>
        <span className={styles.taskMeta}>
          <span className={styles.taskPlan}>{task.plan_title}</span>
          {meta && <span><ClockCountdown size={12} />{meta}</span>}
        </span>
      </Link>
      {(recommended || task.recommendation_reason) && (
        <span className={styles.reason}>
          {recommended ? task.recommendation_reason || '建议优先' : task.recommendation_reason}
        </span>
      )}
    </article>
  );
}

export default function PlanTodayView({
  overview,
  busyKeys,
  onToggle,
  onOverview,
  onDateChange,
  onQuickTask,
  onNewPlan,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [savingFocus, setSavingFocus] = useState(false);
  const [dateLoading, setDateLoading] = useState(false);
  const [taskView, setTaskView] = useState<TaskView>('list');
  const [otherOpen, setOtherOpen] = useState(true);
  const [overdueOpen, setOverdueOpen] = useState(true);
  const [error, setError] = useState('');

  const candidates = useMemo(
    () => uniqueTasks([
      overview.focus,
      overview.suggestions,
      overview.today,
      overview.overdue,
      overview.unscheduled,
    ]).slice(0, 24),
    [overview],
  );

  const allActionable = useMemo(
    () => uniqueTasks([
      overview.focus,
      overview.overdue,
      overview.today,
      overview.suggestions,
      overview.unscheduled,
    ]),
    [overview],
  );

  const quadrantTasks = useMemo(() => {
    const overdueKeys = new Set(overview.overdue.map(taskKey));
    const todayKeys = new Set(overview.today.map(taskKey));
    const groups: Record<QuadrantKey, PlanFocusTask[]> = {
      importantUrgent: [],
      important: [],
      urgent: [],
      later: [],
    };
    allActionable.forEach(task => {
      const key = taskKey(task);
      const important = task.priority === 'high';
      const urgent = overdueKeys.has(key) || todayKeys.has(key);
      if (important && urgent) groups.importantUrgent.push(task);
      else if (important) groups.important.push(task);
      else if (urgent) groups.urgent.push(task);
      else groups.later.push(task);
    });
    return groups;
  }, [allActionable, overview.overdue, overview.today]);

  useEffect(() => {
    if (!pickerOpen) return;
    setSelectedKeys(overview.focus.map(taskKey));
    setError('');
  }, [overview.focus, pickerOpen]);

  const focusTasks = overview.focus.length > 0
    ? overview.focus
    : overview.suggestions.slice(0, 3);
  const focusKeys = new Set(overview.focus.map(taskKey));
  const otherToday = overview.today.filter(task => !focusKeys.has(taskKey(task)));
  const dates = weekDates(overview.date);

  const changeDate = async (date: string) => {
    if (date === overview.date || dateLoading) return;
    setDateLoading(true);
    await onDateChange(date);
    setDateLoading(false);
  };

  const toggleSelection = (key: string) => {
    setError('');
    setSelectedKeys(current => {
      if (current.includes(key)) return current.filter(item => item !== key);
      if (current.length >= 3) {
        setError('每天最多选择三项重点。');
        return current;
      }
      return [...current, key];
    });
  };

  const moveSelection = (key: string, direction: -1 | 1) => {
    setSelectedKeys(current => {
      const index = current.indexOf(key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const saveFocus = async () => {
    if (savingFocus) return;
    setSavingFocus(true);
    setError('');
    const tasks = selectedKeys.map(key => {
      const split = key.indexOf(':');
      return { plan_id: key.slice(0, split), task_id: key.slice(split + 1) };
    });
    const response = await replacePlanFocus(overview.date, tasks);
    if (response.success && response.data) {
      onOverview(response.data);
      setPickerOpen(false);
    } else {
      setError(response.error || '今天的重点保存失败，请重试。');
    }
    setSavingFocus(false);
  };

  return (
    <div className={styles.todayWorkspace}>
      <section className={styles.todayCommand} aria-label="日期与任务视图">
        <div className={styles.selectedDate}>
          <CalendarBlank size={18} weight="duotone" />
          <div>
            <span>当前安排</span>
            <strong>{formatSelectedDate(overview.date)}</strong>
          </div>
        </div>
        <div className={styles.weekNavigator}>
          <button type="button" className={styles.iconButton} onClick={() => void changeDate(addDays(overview.date, -7))} disabled={dateLoading} aria-label="上一周">
            <CaretLeft size={16} />
          </button>
          <div className={styles.weekStrip}>
            {dates.map((date, index) => (
              <button
                key={date}
                type="button"
                className={`${styles.dayButton} ${date === overview.date ? styles.dayButtonActive : ''}`}
                onClick={() => void changeDate(date)}
                disabled={dateLoading}
                aria-pressed={date === overview.date}
              >
                <span>{WEEKDAYS[index]}</span>
                <strong>{Number(date.slice(-2))}</strong>
              </button>
            ))}
          </div>
          <button type="button" className={styles.iconButton} onClick={() => void changeDate(addDays(overview.date, 7))} disabled={dateLoading} aria-label="下一周">
            <CaretRight size={16} />
          </button>
        </div>
        <div className={styles.viewSwitch} aria-label="任务视图">
          <button type="button" className={taskView === 'list' ? styles.viewActive : ''} onClick={() => setTaskView('list')} aria-pressed={taskView === 'list'}>
            <ListBullets size={16} />清单
          </button>
          <button type="button" className={taskView === 'quadrant' ? styles.viewActive : ''} onClick={() => setTaskView('quadrant')} aria-pressed={taskView === 'quadrant'}>
            <SquaresFour size={16} />四象限
          </button>
        </div>
      </section>

      <div
        className={`${styles.todayLayout} ${taskView === 'quadrant' ? styles.todayLayoutQuadrant : ''}`}
        aria-busy={dateLoading}
      >
        <div className={styles.todayMain}>
          {taskView === 'list' ? (
            <>
              <section className={styles.focusPanel} aria-labelledby="today-focus-title">
                <div className={styles.sectionHeader}>
                  <div>
                    <h2 id="today-focus-title" className={styles.sectionTitle}>今日重点</h2>
                  </div>
                  {candidates.length > 0 && (
                    <button type="button" className={styles.secondaryButton} onClick={() => setPickerOpen(true)}>
                      <SlidersHorizontal size={15} />
                      {overview.focus.length ? '调整重点' : '选择重点'}
                    </button>
                  )}
                </div>

                {focusTasks.length > 0 ? (
                  <div className={styles.focusList}>
                    {focusTasks.map(task => (
                      <TaskRow
                        key={taskKey(task)}
                        task={task}
                        busy={busyKeys.has(taskKey(task))}
                        recommended={overview.focus.length === 0}
                        onToggle={onToggle}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={styles.emptyState}>
                    <span className={styles.emptyIcon}><ListChecks size={21} weight="duotone" /></span>
                    <h3>这一天还没有行动</h3>
                    <p>先记录一件准备完成的事。</p>
                    <button type="button" className={styles.primaryButton} onClick={onQuickTask}>
                      <Plus size={15} weight="bold" />快速新增
                    </button>
                  </div>
                )}
              </section>

              <div className={styles.secondarySections}>
                {otherToday.length > 0 && (
                  <details
                    className={styles.disclosure}
                    data-ui="stable"
                    data-state={otherOpen ? 'open' : 'closed'}
                    data-render={otherOpen ? 'open' : 'closed'}
                    open={otherOpen}
                    onToggle={event => setOtherOpen(event.currentTarget.open)}
                  >
                    <summary><span>今天的其他任务 · {otherToday.length}</span><CaretDown size={15} /></summary>
                    {otherOpen && (
                      <div className={styles.disclosureBody}>
                        {otherToday.map(task => (
                          <TaskRow key={taskKey(task)} task={task} compact busy={busyKeys.has(taskKey(task))} onToggle={onToggle} />
                        ))}
                      </div>
                    )}
                  </details>
                )}

                {overview.overdue.length > 0 && (
                  <details
                    className={styles.disclosure}
                    data-ui="stable"
                    data-state={overdueOpen ? 'open' : 'closed'}
                    data-render={overdueOpen ? 'open' : 'closed'}
                    open={overdueOpen}
                    onToggle={event => setOverdueOpen(event.currentTarget.open)}
                  >
                    <summary>
                      <span className={styles.warningLabel}><WarningCircle size={16} />需要重新安排 · {overview.overdue.length}</span>
                      <CaretDown size={15} />
                    </summary>
                    {overdueOpen && (
                      <div className={styles.disclosureBody}>
                        {overview.overdue.map(task => (
                          <TaskRow key={taskKey(task)} task={{ ...task, recommendation_reason: '已逾期' }} compact busy={busyKeys.has(taskKey(task))} onToggle={onToggle} />
                        ))}
                      </div>
                    )}
                  </details>
                )}
              </div>
            </>
          ) : (
            <section className={styles.quadrantPanel} aria-labelledby="quadrant-title">
              <h2 id="quadrant-title" className="sr-only">四象限</h2>
              <div className={styles.quadrantGrid}>
                {QUADRANTS.map(quadrant => (
                  <section key={quadrant.key} className={styles.quadrant}>
                    <header>
                      <span>{quadrant.index}</span>
                      <div><h3>{quadrant.title}</h3></div>
                      <strong>{quadrantTasks[quadrant.key].length}</strong>
                    </header>
                    {quadrantTasks[quadrant.key].length > 0 ? (
                      <div className={styles.quadrantTasks}>
                        {quadrantTasks[quadrant.key].map(task => (
                          <TaskRow key={taskKey(task)} task={task} compact busy={busyKeys.has(taskKey(task))} onToggle={onToggle} />
                        ))}
                      </div>
                    ) : (
                      <p className={styles.quadrantEmpty}>暂无任务</p>
                    )}
                  </section>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className={styles.todayAside} aria-label="今日管理">
          <section className={styles.progressPanel}>
            <div className={styles.progressRing}>
              <span><strong>{overview.focus.length}</strong>/3</span>
            </div>
            <div>
              <h2>今日重点</h2>
              <span>{overview.summary.open_tasks} 项待办 · {overview.summary.active_plans} 个进行中计划</span>
            </div>
          </section>

          <section className={styles.capturePanel}>
            <div className={styles.asideHeading}>
              <span className={styles.asideIcon}><Tray size={18} weight="duotone" /></span>
              <div><h2>快速新增</h2></div>
            </div>
            <button type="button" className={styles.captureAction} onClick={onQuickTask}>
              <span><CheckCircle size={17} />记录一项任务</span><CaretRight size={15} />
            </button>
            <button type="button" className={styles.captureAction} onClick={onNewPlan}>
              <span><Target size={17} />创建一个计划</span><CaretRight size={15} />
            </button>
          </section>

          <section className={styles.loadPanel}>
            <div><span>今天到期</span><strong>{overview.summary.due_today}</strong></div>
            <div><span>需要重排</span><strong className={overview.summary.overdue_tasks > 0 ? styles.warningNumber : ''}>{overview.summary.overdue_tasks}</strong></div>
            <div><span>尚未排期</span><strong>{overview.summary.unscheduled_tasks || 0}</strong></div>
          </section>
        </aside>
      </div>

      <BottomSheet open={pickerOpen} onClose={() => !savingFocus && setPickerOpen(false)} title="安排今天的三件事">
        <div className={styles.sheetForm}>
          <p className={styles.sectionHint}>从所有计划中选择最多三项。已选顺序就是今天的执行顺序。</p>
          <div className={styles.focusPicker}>
            {candidates.map(task => {
              const key = taskKey(task);
              const selected = selectedKeys.includes(key);
              const selectedIndex = selectedKeys.indexOf(key);
              return (
                <div key={key} className={`${styles.focusChoice} ${selected ? styles.focusChoiceSelected : ''}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggleSelection(key)} aria-label={`选择 ${task.title}`} />
                  <button type="button" className="min-w-0 text-left" onClick={() => toggleSelection(key)}>
                    <strong>{task.title}</strong>
                    <small>{task.plan_title}{taskMeta(task) ? ` · ${taskMeta(task)}` : ''}</small>
                  </button>
                  {selected && (
                    <span className={styles.focusOrder}>
                      <button type="button" className={styles.iconButton} onClick={() => moveSelection(key, -1)} disabled={selectedIndex === 0} aria-label="上移"><CaretUp size={15} /></button>
                      <button type="button" className={styles.iconButton} onClick={() => moveSelection(key, 1)} disabled={selectedIndex === selectedKeys.length - 1} aria-label="下移"><CaretDown size={15} /></button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.sheetActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setPickerOpen(false)} disabled={savingFocus}>取消</button>
            <button type="button" className={styles.primaryButton} onClick={() => void saveFocus()} disabled={savingFocus}>
              {savingFocus && <SpinnerGap size={16} className="animate-spin" />}保存 {selectedKeys.length} 项重点
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
