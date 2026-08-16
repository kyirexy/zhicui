'use client';

import { useMemo, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CalendarBlank,
  CaretDown,
  CaretUp,
  Check,
  ClockCountdown,
  DotsSixVertical,
  NotePencil,
  Plus,
  SpinnerGap,
  Trash,
} from '@phosphor-icons/react';
import {
  addPlanTask,
  deletePlanTask,
  reorderPlanTasks,
  togglePlanTask,
  updatePlanTask,
} from '@/lib/api';
import type { PlanData, PlanPriority, PlanTask } from '@/lib/types';
import {
  formatPlanDuration,
  formatPlanSchedule,
  getPlanTasks,
  getTaskPriority,
} from '@/lib/types';
import { celebrateCompletion } from '@/lib/celebrate';
import BottomSheet from '@/components/BottomSheet';
import styles from './PlanWorkspace.module.css';

interface Props {
  plan: PlanData;
  onMutate: (plan: PlanData) => void;
}

interface TaskDraft {
  title: string;
  day: string;
  scheduled_at: string;
  duration_minutes: string;
  priority: PlanPriority;
}

function patchDone(plan: PlanData, taskId: string): PlanData {
  const transform = (task: PlanTask) => task.id === taskId ? { ...task, done: !task.done } : task;
  return {
    ...plan,
    tasks: plan.tasks.map(transform),
    days: plan.days.map(day => ({ ...day, tasks: day.tasks.map(transform) })),
  };
}

function reorderLocal(plan: PlanData, ids: string[]): PlanData {
  const order = new Map(ids.map((id, index) => [id, index]));
  const sortTasks = (tasks: PlanTask[]) => [...tasks]
    .sort((left, right) => (order.get(left.id) ?? 9999) - (order.get(right.id) ?? 9999))
    .map((task, position) => ({ ...task, position: order.get(task.id) ?? position }));
  return {
    ...plan,
    tasks: sortTasks(plan.tasks),
    days: plan.days.map(day => ({ ...day, tasks: sortTasks(day.tasks) })),
  };
}

function SortableTaskRow({
  task,
  busy,
  index,
  total,
  onToggle,
  onEdit,
  onMove,
}: {
  task: PlanTask;
  busy: boolean;
  index: number;
  total: number;
  onToggle: () => void;
  onEdit: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const schedule = formatPlanSchedule(task.scheduled_at);
  const duration = formatPlanDuration(task.duration_minutes);
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${styles.sortableRow} ${task.done ? styles.sortableRowDone : ''} ${isDragging ? styles.sortableRowDragging : ''}`}
    >
      <button
        type="button"
        className={styles.dragHandle}
        aria-label={`拖动排序：${task.title}`}
        {...attributes}
        {...listeners}
      ><DotsSixVertical size={18} weight="bold" /></button>
      <button
        type="button"
        className={`${styles.taskCheck} ${task.done ? styles.taskCheckDone : ''}`}
        onClick={onToggle}
        disabled={busy}
        aria-label={task.done ? `重新打开：${task.title}` : `完成：${task.title}`}
      >
        {busy ? <SpinnerGap size={16} className="animate-spin" /> : task.done ? <Check size={16} weight="bold" /> : null}
      </button>
      <button type="button" className={`${styles.taskCopy} text-left`} onClick={onEdit}>
        <strong className={styles.taskTitle}>{task.title}</strong>
        <span className={styles.taskMeta}>
          {task.day && <span>第 {task.day} 天</span>}
          {schedule && <span><CalendarBlank size={12} />{schedule}</span>}
          {duration && <span><ClockCountdown size={12} />{duration}</span>}
          <span>{getTaskPriority(task) === 'high' ? '高优先' : getTaskPriority(task) === 'low' ? '低优先' : '普通'}</span>
        </span>
      </button>
      <span className={styles.rowActions}>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.mobileOrder}`}
          onClick={() => onMove(-1)}
          disabled={index === 0 || busy}
          aria-label="上移任务"
        ><CaretUp size={15} /></button>
        <button
          type="button"
          className={`${styles.iconButton} ${styles.mobileOrder}`}
          onClick={() => onMove(1)}
          disabled={index === total - 1 || busy}
          aria-label="下移任务"
        ><CaretDown size={15} /></button>
        <button type="button" className={`${styles.iconButton} ${styles.editButton}`} onClick={onEdit} aria-label={`编辑：${task.title}`}>
          <NotePencil size={16} />
        </button>
      </span>
    </article>
  );
}

export default function PlanTaskBoard({ plan, onMutate }: Props) {
  const tasks = useMemo(
    () => [...getPlanTasks(plan)].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [plan],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 7 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [editorTask, setEditorTask] = useState<PlanTask | 'new' | null>(null);
  const [draft, setDraft] = useState<TaskDraft>({ title: '', day: '', scheduled_at: '', duration_minutes: '', priority: 'medium' });
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [error, setError] = useState('');

  const openEditor = (task: PlanTask | 'new') => {
    setError('');
    setEditorTask(task);
    setDraft(task === 'new'
      ? { title: '', day: '', scheduled_at: '', duration_minutes: '', priority: 'medium' }
      : {
          title: task.title,
          day: task.day ? String(task.day) : '',
          scheduled_at: task.scheduled_at?.slice(0, 16) ?? '',
          duration_minutes: task.duration_minutes ? String(task.duration_minutes) : '',
          priority: getTaskPriority(task),
        });
  };

  const setBusy = (taskId: string, value: boolean) => {
    setBusyIds(current => {
      const next = new Set(current);
      if (value) next.add(taskId); else next.delete(taskId);
      return next;
    });
  };

  const toggle = async (task: PlanTask) => {
    const previous = plan;
    const optimistic = patchDone(plan, task.id);
    onMutate(optimistic);
    if (!task.done && getPlanTasks(optimistic).every(item => item.done)) celebrateCompletion();
    setBusy(task.id, true);
    setError('');
    const response = await togglePlanTask(plan.id, task.id);
    if (response.success && response.data) onMutate(response.data);
    else {
      onMutate(previous);
      setError(response.error || '任务状态更新失败，请重试。');
    }
    setBusy(task.id, false);
  };

  const persistOrder = async (nextIds: string[]) => {
    if (reordering) return;
    const previous = plan;
    onMutate(reorderLocal(plan, nextIds));
    setReordering(true);
    setError('');
    const response = await reorderPlanTasks(plan.id, nextIds);
    if (response.success && response.data) onMutate(response.data);
    else {
      onMutate(previous);
      setError(response.error || '任务顺序保存失败，请重试。');
    }
    setReordering(false);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : '';
    if (!overId || activeId === overId) return;
    const oldIndex = tasks.findIndex(task => task.id === activeId);
    const newIndex = tasks.findIndex(task => task.id === overId);
    if (oldIndex < 0 || newIndex < 0) return;
    void persistOrder(arrayMove(tasks, oldIndex, newIndex).map(task => task.id));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= tasks.length) return;
    void persistOrder(arrayMove(tasks, index, target).map(task => task.id));
  };

  const saveTask = async () => {
    if (!editorTask || !draft.title.trim() || saving) return;
    setSaving(true);
    setError('');
    const payload = {
      title: draft.title.trim(),
      day: draft.day ? Number(draft.day) : undefined,
      scheduled_at: draft.scheduled_at || null,
      duration_minutes: draft.duration_minutes ? Number(draft.duration_minutes) : null,
      priority: draft.priority,
    };
    const response = editorTask === 'new'
      ? await addPlanTask(plan.id, payload)
      : await updatePlanTask(plan.id, editorTask.id, payload);
    if (response.success && response.data) {
      onMutate(response.data);
      setEditorTask(null);
    } else {
      setError(response.error || '任务保存失败，请检查后重试。');
    }
    setSaving(false);
  };

  const removeTask = async () => {
    if (!editorTask || editorTask === 'new' || saving) return;
    setSaving(true);
    setError('');
    const response = await deletePlanTask(plan.id, editorTask.id);
    if (response.success && response.data) {
      onMutate(response.data);
      setEditorTask(null);
    } else {
      setError(response.error || '任务删除失败，请重试。');
    }
    setSaving(false);
  };

  return (
    <section className={styles.panel} aria-labelledby="plan-task-board-title">
      <div className={styles.panelHeader}>
        <div>
          <h2 id="plan-task-board-title">执行清单</h2>
          <p>{tasks.filter(task => !task.done).length} 项待办</p>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={() => openEditor('new')}>
          <Plus size={15} weight="bold" />添加任务
        </button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {tasks.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}><Plus size={20} /></span>
          <h3>还没有执行任务</h3>
          <p>先添加一件现在就能开始的小事。</p>
          <button type="button" className={styles.primaryButton} onClick={() => openEditor('new')}>添加第一项任务</button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tasks.map(task => task.id)} strategy={verticalListSortingStrategy}>
            <div className={styles.taskBoard}>
              {tasks.map((task, index) => (
                <SortableTaskRow
                  key={task.id}
                  task={task}
                  busy={busyIds.has(task.id) || reordering}
                  index={index}
                  total={tasks.length}
                  onToggle={() => void toggle(task)}
                  onEdit={() => openEditor(task)}
                  onMove={direction => move(index, direction)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      <BottomSheet open={editorTask !== null} onClose={() => !saving && setEditorTask(null)} title={editorTask === 'new' ? '添加任务' : '编辑任务'}>
        {editorTask && (
          <form
            className={styles.sheetForm}
            onSubmit={event => {
              event.preventDefault();
              void saveTask();
            }}
          >
            <label className={styles.field}>
              <span>任务内容</span>
              <input
                value={draft.title}
                onChange={event => setDraft(current => ({ ...current, title: event.target.value }))}
                placeholder="写成可以直接开始的动作"
                maxLength={256}
                autoFocus
              />
            </label>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>计划第几天（可选）</span>
                <input type="number" min={1} max={3650} value={draft.day} onChange={event => setDraft(current => ({ ...current, day: event.target.value }))} />
              </label>
              <label className={styles.field}>
                <span>执行时间（可选）</span>
                <input type="datetime-local" value={draft.scheduled_at} onChange={event => setDraft(current => ({ ...current, scheduled_at: event.target.value }))} />
              </label>
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>预计分钟</span>
                <input type="number" min={1} max={10080} value={draft.duration_minutes} onChange={event => setDraft(current => ({ ...current, duration_minutes: event.target.value }))} />
              </label>
              <label className={styles.field}>
                <span>优先级</span>
                <select value={draft.priority} onChange={event => setDraft(current => ({ ...current, priority: event.target.value as PlanPriority }))}>
                  <option value="high">高优先</option>
                  <option value="medium">普通</option>
                  <option value="low">低优先</option>
                </select>
              </label>
            </div>
            {error && <p className={styles.error} role="alert">{error}</p>}
            <div className={styles.sheetActions}>
              {editorTask !== 'new' && (
                <button type="button" className={styles.dangerButton} onClick={() => void removeTask()} disabled={saving}>
                  <Trash size={15} />删除
                </button>
              )}
              <button type="button" className={styles.secondaryButton} onClick={() => setEditorTask(null)} disabled={saving}>取消</button>
              <button type="submit" className={styles.primaryButton} disabled={saving || !draft.title.trim()}>
                {saving && <SpinnerGap size={16} className="animate-spin" />}
                保存
              </button>
            </div>
          </form>
        )}
      </BottomSheet>
    </section>
  );
}
