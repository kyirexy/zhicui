'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CalendarBlank,
  CaretDown,
  Check,
  ClockCountdown,
  NotePencil,
  Plus,
  Repeat,
  SpinnerGap,
  Trash,
} from '@phosphor-icons/react';
import type { PlanData, PlanDay, PlanPriority, PlanTask } from '@/lib/types';
import {
  formatPlanDuration,
  formatPlanFieldValue,
  formatPlanSchedule,
  getChinaToday,
  getPlanCurrentDay,
  getTaskPriority,
} from '@/lib/types';
import {
  addPlanTask,
  deletePlanTask,
  togglePlanTask,
  updatePlanTask,
} from '@/lib/api';
import { celebrateCompletion, celebrateDayDone } from '@/lib/celebrate';
import BottomSheet from './BottomSheet';

interface PlanTaskListProps {
  plan: PlanData;
  onMutate: (plan: PlanData) => void;
}

interface TaskDraft {
  title: string;
  day: number;
  scheduled_at: string;
  duration_minutes: string;
  frequency: string;
  priority: PlanPriority;
}

interface TaskEditor {
  mode: 'add' | 'edit';
  taskId?: string;
  draft: TaskDraft;
}

const priorityOptions: { value: PlanPriority; label: string; note: string }[] = [
  { value: 'high', label: '高', note: '优先推进' },
  { value: 'medium', label: '中', note: '正常节奏' },
  { value: 'low', label: '低', note: '有空处理' },
];

function deriveDays(plan: PlanData): PlanDay[] {
  if (plan.days?.length) return plan.days;
  if (plan.tasks?.length) {
    return [{ day: 1, label: '第1天', tasks: plan.tasks.map(task => ({ ...task, day: task.day ?? 1 })) }];
  }
  return [];
}

function patchTask(
  plan: PlanData,
  taskId: string,
  transform: (task: PlanTask) => PlanTask,
): PlanData {
  return {
    ...plan,
    tasks: plan.tasks?.map(task => task.id === taskId ? transform(task) : task) ?? [],
    days: plan.days?.map(day => ({
      ...day,
      tasks: day.tasks.map(task => task.id === taskId ? transform(task) : task),
    })) ?? [],
  };
}

function maybeCelebrate(previous: PlanData, next: PlanData, taskId: string) {
  const previousDays = deriveDays(previous);
  const nextDays = deriveDays(next);
  const dayBefore = previousDays.find(day => day.tasks.some(task => task.id === taskId));
  const dayAfter = nextDays.find(day => day.tasks.some(task => task.id === taskId));
  if (dayBefore && dayAfter) {
    const wasDone = dayBefore.tasks.length > 0 && dayBefore.tasks.every(task => task.done);
    const isDone = dayAfter.tasks.length > 0 && dayAfter.tasks.every(task => task.done);
    if (!wasDone && isDone) celebrateDayDone();
  }

  const beforeTasks = previousDays.flatMap(day => day.tasks);
  const afterTasks = nextDays.flatMap(day => day.tasks);
  if (
    afterTasks.length > 0
    && afterTasks.every(task => task.done)
    && !beforeTasks.every(task => task.done)
  ) {
    celebrateCompletion();
  }
}

export default function PlanTaskList({ plan, onMutate }: PlanTaskListProps) {
  const days = useMemo(() => deriveDays(plan), [plan]);
  const currentDay = getPlanCurrentDay(plan);
  const [mutatingIds, setMutatingIds] = useState<Set<string>>(new Set());
  const [collapsedDays, setCollapsedDays] = useState<Set<number>>(new Set());
  const [editor, setEditor] = useState<TaskEditor | null>(null);
  const [savingEditor, setSavingEditor] = useState(false);
  const [mutationError, setMutationError] = useState('');

  const availableDays = useMemo(() => {
    const configuredMax = Math.min(Math.max(plan.total_days ?? 0, 1), 365);
    const existingMax = Math.max(...days.map(day => day.day), 1);
    const maxDay = Math.max(configuredMax, existingMax, currentDay);
    return Array.from({ length: maxDay }, (_, index) => index + 1);
  }, [currentDay, days, plan.total_days]);

  const setBusy = (taskId: string, busy: boolean) => {
    setMutatingIds(current => {
      const next = new Set(current);
      if (busy) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  const openAddEditor = () => {
    setMutationError('');
    setEditor({
      mode: 'add',
      draft: {
        title: '',
        day: Math.min(currentDay, availableDays.at(-1) ?? 1),
        scheduled_at: '',
        duration_minutes: '',
        frequency: '',
        priority: 'medium',
      },
    });
  };

  const openEditEditor = (task: PlanTask, day: number) => {
    setMutationError('');
    setEditor({
      mode: 'edit',
      taskId: task.id,
      draft: {
        title: task.title,
        day: task.day ?? day,
        scheduled_at: task.scheduled_at?.slice(0, 16) ?? '',
        duration_minutes: task.duration_minutes ? String(task.duration_minutes) : '',
        frequency: task.frequency ?? '',
        priority: getTaskPriority(task),
      },
    });
  };

  const handleToggle = async (taskId: string) => {
    const previous = plan;
    const optimistic = patchTask(plan, taskId, task => ({ ...task, done: !task.done }));
    onMutate(optimistic);
    maybeCelebrate(previous, optimistic, taskId);
    setBusy(taskId, true);
    setMutationError('');
    try {
      const response = await togglePlanTask(plan.id, taskId);
      if (response.success && response.data) onMutate(response.data);
      else {
        onMutate(previous);
        setMutationError(response.error || '任务状态更新失败，请重试。');
      }
    } finally {
      setBusy(taskId, false);
    }
  };

  const handleDelete = async (taskId: string) => {
    const previous = plan;
    const optimistic: PlanData = {
      ...plan,
      tasks: plan.tasks?.filter(task => task.id !== taskId) ?? [],
      days: plan.days?.map(day => ({
        ...day,
        tasks: day.tasks.filter(task => task.id !== taskId),
      })) ?? [],
    };
    onMutate(optimistic);
    setBusy(taskId, true);
    setMutationError('');
    try {
      const response = await deletePlanTask(plan.id, taskId);
      if (response.success && response.data) onMutate(response.data);
      else {
        onMutate(previous);
        setMutationError(response.error || '删除任务失败，请重试。');
      }
    } finally {
      setBusy(taskId, false);
    }
  };

  const saveEditor = async () => {
    if (!editor || !editor.draft.title.trim()) return;
    setSavingEditor(true);
    setMutationError('');
    const payload = {
      title: editor.draft.title.trim(),
      day: editor.draft.day,
      scheduled_at: editor.draft.scheduled_at || null,
      duration_minutes: editor.draft.duration_minutes
        ? Number(editor.draft.duration_minutes)
        : null,
      frequency: editor.draft.frequency.trim() || null,
      priority: editor.draft.priority,
    };

    try {
      const response = editor.mode === 'edit' && editor.taskId
        ? await updatePlanTask(plan.id, editor.taskId, payload)
        : await addPlanTask(plan.id, {
            ...payload,
            scheduled_at: payload.scheduled_at ?? undefined,
          });
      if (response.success && response.data) {
        onMutate(response.data);
        setEditor(null);
      } else {
        setMutationError(response.error || '保存任务失败，请检查后重试。');
      }
    } finally {
      setSavingEditor(false);
    }
  };

  const toggleDay = (day: number) => {
    setCollapsedDays(current => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  };

  const expandAll = () => setCollapsedDays(new Set());
  const collapseAll = () => setCollapsedDays(new Set(days.map(day => day.day)));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tagName = (event.target as HTMLElement | null)?.tagName;
      if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        setMutationError('');
        setEditor({
          mode: 'add',
          draft: {
            title: '',
            day: Math.min(currentDay, availableDays.at(-1) ?? 1),
            scheduled_at: '',
            duration_minutes: '',
            frequency: '',
            priority: 'medium',
          },
        });
      } else if (key === 'e') {
        setCollapsedDays(new Set());
      } else if (key === 'c') {
        setCollapsedDays(new Set(days.map(day => day.day)));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [availableDays, currentDay, days]);

  const today = getChinaToday();

  return (
    <div className="space-y-3">
      <div className="plan-task-toolbar">
        <div>
          <h2>执行清单</h2>
          <p>{days.reduce((sum, day) => sum + day.tasks.length, 0)} 项任务，按天推进</p>
        </div>
        <div className="flex items-center gap-2">
          {days.length > 1 && (
            <>
              <button type="button" onClick={expandAll} className="plan-quiet-action">展开</button>
              <button type="button" onClick={collapseAll} className="plan-quiet-action">折叠</button>
            </>
          )}
          <button type="button" onClick={openAddEditor} className="plan-add-task">
            <Plus size={16} weight="bold" />
            添加任务
          </button>
        </div>
      </div>

      {mutationError && (
        <p className="plan-inline-error" role="alert">{mutationError}</p>
      )}

      {days.length === 0 ? (
        <button type="button" onClick={openAddEditor} className="plan-empty-tasks">
          <Plus size={20} weight="duotone" />
          <span>
            <strong>还没有执行任务</strong>
            <small>添加第一项任务，把计划变成可执行的下一步。</small>
          </span>
        </button>
      ) : (
        days.map(planDay => {
          const isCollapsed = collapsedDays.has(planDay.day);
          const dayDone = planDay.tasks.length > 0 && planDay.tasks.every(task => task.done);
          const isToday = planDay.day === currentDay;
          const dayContext = [
            planDay.date ? planDay.date.slice(5).replace('-', '/') : null,
            planDay.focus,
            `${planDay.tasks.filter(task => task.done).length}/${planDay.tasks.length} 已完成`,
          ].filter(Boolean).join(' · ');

          return (
            <section
              key={planDay.day}
              className={`plan-day ${isToday ? 'is-today' : ''} ${dayDone ? 'is-done' : ''}`}
            >
              <button
                type="button"
                onClick={() => toggleDay(planDay.day)}
                className="plan-day__header"
                aria-expanded={!isCollapsed}
              >
                <span className="plan-day__number">{dayDone ? <Check size={14} weight="bold" /> : planDay.day}</span>
                <span className="min-w-0 flex-1 text-left">
                  <strong>{planDay.label || `第${planDay.day}天`}</strong>
                  <small className="truncate">{dayContext}</small>
                </span>
                {isToday && <span className="plan-day__today">今天</span>}
                <CaretDown size={15} className={isCollapsed ? '' : 'rotate-180'} />
              </button>

              {!isCollapsed && (
                <ul className="plan-day__tasks">
                  {planDay.tasks.length === 0 && (
                    <li className="plan-day__empty">这一天还没有任务</li>
                  )}
                  {planDay.tasks.map(task => {
                    const busy = mutatingIds.has(task.id);
                    const priority = getTaskPriority(task);
                    const taskDate = task.scheduled_at?.slice(0, 10);
                    const scheduleLabel = formatPlanSchedule(task.scheduled_at);
                    const durationLabel = formatPlanDuration(task.duration_minutes);
                    const overdue = !task.done && !!taskDate && taskDate < today;
                    const dueToday = !task.done && taskDate === today;
                    return (
                      <li
                        key={task.id}
                        className={`plan-task-row ${task.done ? 'is-done' : ''} ${overdue ? 'is-overdue' : ''}`}
                      >
                        <button
                          type="button"
                          onClick={() => handleToggle(task.id)}
                          disabled={busy}
                          className="plan-task-row__check"
                          aria-label={task.done ? `重开任务：${task.title}` : `完成任务：${task.title}`}
                        >
                          {busy
                            ? <SpinnerGap size={14} className="animate-spin" />
                            : task.done
                              ? <Check size={14} weight="bold" />
                              : null}
                        </button>
                        <span className="min-w-0 flex-1">
                          <span className="plan-task-row__title">{task.title}</span>
                          <span className="plan-task-row__meta">
                            <span className={`plan-priority is-${priority}`}>
                              {priority === 'high' ? '高优先' : priority === 'low' ? '低优先' : '中优先'}
                            </span>
                            {scheduleLabel && (
                              <span className={overdue ? 'text-accent-rose' : dueToday ? 'text-accent-emerald' : ''}>
                                <CalendarBlank size={12} />
                                {overdue ? '逾期 ' : ''}
                                {scheduleLabel}
                              </span>
                            )}
                            {durationLabel && (
                              <span>
                                <ClockCountdown size={12} />
                                {durationLabel}
                              </span>
                            )}
                            {task.frequency && (
                              <span>
                                <Repeat size={12} />
                                {task.frequency}
                              </span>
                            )}
                          </span>
                          {task.details && task.details.length > 0 && (
                            <span className="plan-task-row__details">
                              {task.details.map((detail, index) => (
                                <span key={`${detail.name}-${index}`}>
                                  <small>{detail.label}</small>
                                  <strong>{formatPlanFieldValue(detail.value)}</strong>
                                </span>
                              ))}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => openEditEditor(task, planDay.day)}
                          disabled={busy}
                          className="plan-task-row__action"
                          aria-label={`编辑任务：${task.title}`}
                        >
                          <NotePencil size={15} />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(task.id)}
                          disabled={busy}
                          className="plan-task-row__action is-danger"
                          aria-label={`删除任务：${task.title}`}
                        >
                          <Trash size={15} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}

      <p className="hidden md:block text-[11px] text-foreground-muted/50 text-center pt-1">
        N 新增 · E 展开 · C 折叠
      </p>

      <BottomSheet
        open={editor !== null}
        onClose={() => !savingEditor && setEditor(null)}
        title={editor?.mode === 'edit' ? '编辑任务' : '添加任务'}
      >
        {editor && (
          <form
            className="plan-task-editor"
            onSubmit={event => {
              event.preventDefault();
              void saveEditor();
            }}
          >
            <label>
              <span>任务标题</span>
              <input
                value={editor.draft.title}
                onChange={event => setEditor({
                  ...editor,
                  draft: { ...editor.draft, title: event.target.value },
                })}
                placeholder="例如：整理第一版宣传脚本"
                maxLength={256}
                autoFocus
              />
            </label>

            <div className="plan-task-editor__grid">
              <label>
                <span>所属计划日</span>
                <select
                  value={editor.draft.day}
                  onChange={event => setEditor({
                    ...editor,
                    draft: { ...editor.draft, day: Number(event.target.value) },
                  })}
                >
                  {availableDays.map(day => (
                    <option key={day} value={day}>第 {day} 天</option>
                  ))}
                </select>
              </label>
              <label>
                <span>执行日期与时间（可选）</span>
                <input
                  type="datetime-local"
                  value={editor.draft.scheduled_at}
                  onChange={event => setEditor({
                    ...editor,
                    draft: { ...editor.draft, scheduled_at: event.target.value },
                  })}
                />
              </label>
            </div>

            <label>
              <span>预计时长（分钟）</span>
              <input
                type="number"
                min={1}
                max={10080}
                value={editor.draft.duration_minutes}
                onChange={event => setEditor({
                  ...editor,
                  draft: { ...editor.draft, duration_minutes: event.target.value },
                })}
                placeholder="例如：30"
              />
            </label>

            <details className="plan-task-editor__advanced">
              <summary>
                <span>
                  <strong>更多设置</strong>
                  <small>优先级与频率备注</small>
                </span>
                <CaretDown size={16} aria-hidden="true" />
              </summary>
              <div>
                <label>
                  <span>频率说明（仅备注）</span>
                  <input
                    value={editor.draft.frequency}
                    onChange={event => setEditor({
                      ...editor,
                      draft: { ...editor.draft, frequency: event.target.value },
                    })}
                    placeholder="例如：每天练习 3 次"
                    maxLength={120}
                  />
                </label>

                <fieldset>
                  <legend>优先级</legend>
                  <div className="plan-priority-picker">
                    {priorityOptions.map(option => (
                      <label key={option.value} className={`is-${option.value}`}>
                        <input
                          type="radio"
                          name="priority"
                          value={option.value}
                          checked={editor.draft.priority === option.value}
                          onChange={() => setEditor({
                            ...editor,
                            draft: { ...editor.draft, priority: option.value },
                          })}
                        />
                        <span>
                          <strong>{option.label}</strong>
                          <small>{option.note}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
            </details>

            {mutationError && <p className="plan-inline-error" role="alert">{mutationError}</p>}
            <div className="plan-task-editor__actions">
              <button type="button" onClick={() => setEditor(null)} disabled={savingEditor} className="plan-secondary-button">
                取消
              </button>
              <button type="submit" disabled={savingEditor || !editor.draft.title.trim()} className="plan-primary-button">
                {savingEditor && <SpinnerGap size={16} className="animate-spin" />}
                {editor.mode === 'edit' ? '保存修改' : '添加任务'}
              </button>
            </div>
          </form>
        )}
      </BottomSheet>
    </div>
  );
}
