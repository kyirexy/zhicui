'use client';

import { useState, useEffect, useRef } from 'react';
import { Check, Plus, Trash2, Loader2, ChevronDown, CalendarDays } from 'lucide-react';
import type { PlanDay } from '@/lib/types';
import { togglePlanTask, addPlanTask, deletePlanTask } from '@/lib/api';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import { celebrateDayDone, celebrateCompletion } from '@/lib/celebrate';
import BottomSheet from './BottomSheet';

interface PlanTaskListProps {
  planId: string;
  days: PlanDay[];
  currentDay: number;
  onMutate: (days: PlanDay[]) => void;
}

export default function PlanTaskList({ planId, days, currentDay, onMutate }: PlanTaskListProps) {
  const isMobile = useIsMobile();
  const [mutatingIds, setMutatingIds] = useState<Set<string>>(new Set());
  const [newTitle, setNewTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [addTargetDay, setAddTargetDay] = useState(currentDay);
  const [collapsedDays, setCollapsedDays] = useState<Set<number>>(new Set());
  const desktopInputRef = useRef<HTMLInputElement>(null);

  const withMutating = (id: string, fn: () => Promise<void>) => {
    setMutatingIds((s) => new Set(s).add(id));
    fn().finally(() => setMutatingIds((s) => { const n = new Set(s); n.delete(id); return n; }));
  };

  // Fire celebrations based on the optimistic next state, not the server echo.
  const maybeCelebrate = (prev: PlanDay[], next: PlanDay[], taskId: string) => {
    const dayBefore = prev.find(d => d.tasks.some(t => t.id === taskId));
    const dayAfter = next.find(d => d.tasks.some(t => t.id === taskId));
    if (dayBefore && dayAfter) {
      const wasDone = dayBefore.tasks.length > 0 && dayBefore.tasks.every(t => t.done);
      const isDone = dayAfter.tasks.length > 0 && dayAfter.tasks.every(t => t.done);
      if (!wasDone && isDone) celebrateDayDone();
    }
    const allAfter = next.flatMap(d => d.tasks);
    const totalAfter = allAfter.length;
    const doneAfter = allAfter.filter(t => t.done).length;
    const doneBefore = prev.flatMap(d => d.tasks).filter(t => t.done).length;
    if (totalAfter > 0 && doneAfter === totalAfter && doneBefore < totalAfter) {
      celebrateCompletion();
    }
  };

  const handleToggle = async (dayIdx: number, taskId: string) => {
    const prev = [...days];
    const newDays = days.map(d => ({
      ...d,
      tasks: d.tasks.map(t => t.id === taskId ? { ...t, done: !t.done } : t),
    }));
    onMutate(newDays);
    maybeCelebrate(prev, newDays, taskId);
    withMutating(taskId, async () => {
      const res = await togglePlanTask(planId, taskId);
      if (res.success && res.data) {
        onMutate(res.data.days || newDays);
      } else {
        onMutate(prev);
      }
    });
  };

  const handleDelete = async (dayIdx: number, taskId: string) => {
    const prev = [...days];
    const newDays = days.map(d => ({
      ...d,
      tasks: d.tasks.filter(t => t.id !== taskId),
    }));
    onMutate(newDays);
    withMutating(taskId, async () => {
      const res = await deletePlanTask(planId, taskId);
      if (res.success && res.data) onMutate(res.data.days || newDays);
      else onMutate(prev);
    });
  };

  const doAdd = async (dayIdx: number, title: string) => {
    setAdding(true);
    const res = await addPlanTask(planId, title, addTargetDay);
    if (res.success && res.data) {
      onMutate(res.data.days || days);
      setNewTitle('');
      setAddSheetOpen(false);
    }
    setAdding(false);
  };

  const toggleDay = (day: number) => {
    setCollapsedDays(prev => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  };

  const expandAll = () => setCollapsedDays(new Set());
  const collapseAll = () => setCollapsedDays(new Set(days.map(d => d.day)));

  // Global keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        if (isMobile) { setNewTitle(''); setAddTargetDay(currentDay); setAddSheetOpen(true); }
        else desktopInputRef.current?.focus();
      } else if (key === 'e') {
        expandAll();
      } else if (key === 'c') {
        collapseAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isMobile, currentDay, days]);

  const today = new Date().toISOString().slice(0, 10);
  const rowClass = 'flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group/task min-h-[52px] md:min-h-[44px] outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/40';

  if (!days || days.length === 0) {
    return <p className="text-sm text-foreground-muted text-center py-8">暂无任务</p>;
  }

  return (
    <div className="space-y-3">
      {/* Expand / collapse all */}
      {days.length > 1 && (
        <div className="flex items-center justify-end gap-3 text-xs text-foreground-muted">
          <button type="button" onClick={expandAll} className="hover:text-foreground-secondary transition-colors">全部展开</button>
          <span className="text-foreground-muted/30">·</span>
          <button type="button" onClick={collapseAll} className="hover:text-foreground-secondary transition-colors">全部折叠</button>
        </div>
      )}

      {days.map((planDay, di) => {
        const isCollapsed = collapsedDays.has(planDay.day);
        const dayDone = planDay.tasks.length > 0 && planDay.tasks.every(t => t.done);
        const isToday = planDay.day === currentDay;

        return (
          <div key={planDay.day} className={`rounded-2xl border overflow-hidden transition-all duration-300 ${
            isToday ? 'border-accent-emerald/30 bg-accent-emerald/[0.03]' :
            dayDone ? 'border-card-border/30 bg-card-bg/40' :
            'border-card-border bg-card-bg/60'
          }`}>
            {/* Day header */}
            <button
              type="button"
              onClick={() => toggleDay(planDay.day)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-card-bg/50 transition-colors ${
                isToday ? 'bg-accent-emerald/[0.04]' : ''
              }`}
            >
              <span className={`flex items-center justify-center w-7 h-7 rounded-lg text-xs font-bold ${
                dayDone ? 'bg-accent-emerald text-white' :
                isToday ? 'bg-accent-emerald/15 text-accent-emerald ring-1 ring-accent-emerald/30' :
                'bg-card-bg border border-card-border text-foreground-muted'
              }`}>
                {planDay.day}
              </span>
              <span className={`flex-1 text-sm font-medium ${dayDone ? 'text-foreground-muted line-through' : 'text-foreground'}`}>
                {planDay.label || `第${planDay.day}天`}
              </span>
              <span className="text-xs text-foreground-muted">
                {planDay.tasks.filter(t => t.done).length}/{planDay.tasks.length}
              </span>
              <ChevronDown
                size={14}
                className={`text-foreground-muted transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`}
              />
            </button>

            {/* Day tasks */}
            {!isCollapsed && (
              <div className="px-2 pb-2 space-y-0.5">
                {planDay.tasks.map(task => {
                  const isDue = !task.done && !!task.scheduled_at?.startsWith(today);
                  const busy = mutatingIds.has(task.id);
                  return (
                    <div key={task.id} tabIndex={0} role="checkbox" aria-checked={task.done}
                      onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !busy) { e.preventDefault(); handleToggle(di, task.id); } }}
                      className={`${rowClass} ${task.done ? 'bg-card-bg/30 text-foreground-muted' : isDue ? 'bg-accent-emerald/[0.05]' : 'hover:bg-card-bg'}`}>
                      <button type="button" onClick={() => handleToggle(di, task.id)} disabled={busy}
                        className={`flex-shrink-0 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
                          task.done ? 'bg-accent-emerald border-accent-emerald' : 'border-card-border hover:border-accent-emerald/50'
                        }`}
                        aria-label={task.done ? '标记未完成' : '标记完成'}>
                        {busy ? <Loader2 size={12} className="animate-spin text-accent-emerald" /> : task.done ? <Check size={12} className="text-white" strokeWidth={3} /> : null}
                      </button>
                      <span className={`flex-1 min-w-0 text-sm leading-snug ${task.done ? 'line-through decoration-foreground-muted/40' : 'text-foreground'}`}>{task.title}</span>
                      <button type="button" onClick={() => handleDelete(di, task.id)} disabled={busy}
                        className="flex-shrink-0 p-1 rounded-lg text-foreground-muted/30 hover:text-accent-rose hover:bg-accent-rose/10 opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100 transition-all"
                        aria-label="删除任务">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Add task button */}
      {isMobile ? (
        <button type="button" onClick={() => { setNewTitle(''); setAddTargetDay(currentDay); setAddSheetOpen(true); }}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-card-bg border border-dashed border-card-border text-foreground-muted hover:text-foreground-secondary hover:border-foreground-muted/30 transition-all min-h-[52px]">
          <Plus size={16} /><span className="text-sm font-medium">添加任务</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 pt-2">
          <input ref={desktopInputRef} type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') doAdd(addTargetDay, newTitle); }}
            placeholder="添加新任务 (N)" style={{ fontSize: '16px' }}
            className="flex-1 bg-card-bg border border-card-border rounded-xl px-3 py-2.5 text-sm text-foreground placeholder:text-foreground-muted outline-none focus:border-accent-emerald/50 min-h-[44px]" />
          <button type="button" onClick={() => doAdd(addTargetDay, newTitle)} disabled={adding || !newTitle.trim()}
            className="flex-shrink-0 btn-primary px-3 py-2.5 rounded-xl min-h-[44px] min-w-[44px] disabled:opacity-40">
            {adding ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          </button>
        </div>
      )}

      {/* Mobile add sheet */}
      <BottomSheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} title="添加任务">
        <div className="space-y-3">
          <select value={addTargetDay} onChange={(e) => setAddTargetDay(Number(e.target.value))}
            className="w-full bg-card-bg border border-card-border rounded-xl px-4 py-3 text-sm text-foreground outline-none">
            {days.map(d => (
              <option key={d.day} value={d.day}>第{d.day}天 · {d.label}</option>
            ))}
          </select>
          <div className="flex items-center gap-2">
            <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doAdd(addTargetDay, newTitle); }}
              placeholder="任务标题..." style={{ fontSize: '16px' }} autoFocus
              className="flex-1 bg-card-bg border border-card-border rounded-xl px-4 py-3 text-base text-foreground placeholder:text-foreground-muted outline-none focus:border-accent-emerald/50 min-h-[52px]" />
            <button type="button" onClick={() => doAdd(addTargetDay, newTitle)} disabled={adding || !newTitle.trim()}
              className="flex-shrink-0 btn-primary px-5 py-3 rounded-xl text-sm font-semibold min-h-[52px] disabled:opacity-40">
              {adding ? <Loader2 size={16} className="animate-spin" /> : '添加'}
            </button>
          </div>
        </div>
      </BottomSheet>

      <p className="hidden md:block text-[11px] text-foreground-muted/50 text-center mt-3">
        <kbd className="px-1 py-0.5 rounded bg-card-bg border border-card-border text-[10px]">Space</kbd> 勾选 ·
        <kbd className="px-1 py-0.5 rounded bg-card-bg border border-card-border text-[10px] ml-1">N</kbd> 新增 ·
        <kbd className="px-1 py-0.5 rounded bg-card-bg border border-card-border text-[10px] ml-1">E</kbd> 展开 ·
        <kbd className="px-1 py-0.5 rounded bg-card-bg border border-card-border text-[10px] ml-1">C</kbd> 折叠
      </p>
    </div>
  );
}
