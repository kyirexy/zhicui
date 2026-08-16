'use client';

import { useEffect, useMemo, useState } from 'react';
import { SpinnerGap } from '@phosphor-icons/react';
import { addPlanTask, createPlan } from '@/lib/api';
import type { PlanData } from '@/lib/types';
import { getChinaToday } from '@/lib/types';
import BottomSheet from '@/components/BottomSheet';
import styles from './PlanWorkspace.module.css';

type CaptureMode = 'plan' | 'task';

interface Props {
  open: boolean;
  plans: PlanData[];
  initialMode?: CaptureMode;
  onClose: () => void;
  onSaved: (plan: PlanData, created: boolean) => void;
}

export default function PlanQuickCapture({
  open,
  plans,
  initialMode = 'plan',
  onClose,
  onSaved,
}: Props) {
  const activePlans = useMemo(
    () => plans.filter(plan => plan.status !== 'done'),
    [plans],
  );
  const [mode, setMode] = useState<CaptureMode>(initialMode);
  const [title, setTitle] = useState('');
  const [firstTask, setFirstTask] = useState('');
  const [startDate, setStartDate] = useState(getChinaToday());
  const [totalDays, setTotalDays] = useState('');
  const [planId, setPlanId] = useState('');
  const [taskDate, setTaskDate] = useState(getChinaToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    const nextMode = initialMode === 'task' && activePlans.length === 0 ? 'plan' : initialMode;
    setMode(nextMode);
    setTitle('');
    setFirstTask('');
    setStartDate(getChinaToday());
    setTotalDays('');
    setPlanId(activePlans[0]?.id ?? '');
    setTaskDate(getChinaToday());
    setError('');
  }, [activePlans, initialMode, open]);

  const submit = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError('');
    try {
      if (mode === 'plan') {
        const response = await createPlan({
          title: title.trim(),
          start_date: startDate || null,
          total_days: totalDays ? Number(totalDays) : 0,
          first_task: firstTask.trim()
            ? { title: firstTask.trim(), scheduled_at: startDate || undefined }
            : null,
        });
        if (response.success && response.data) {
          onSaved(response.data, true);
          onClose();
        } else {
          setError(response.error || '计划创建失败，请稍后重试。');
        }
      } else {
        if (!planId) {
          setError('请先选择一个进行中的计划。');
          return;
        }
        const response = await addPlanTask(planId, {
          title: title.trim(),
          scheduled_at: taskDate || undefined,
        });
        if (response.success && response.data) {
          onSaved(response.data, false);
          onClose();
        } else {
          setError(response.error || '任务添加失败，请稍后重试。');
        }
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => !saving && onClose()}
      title="快速新增"
      desktopDialog
    >
      <form
        className={styles.sheetForm}
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className={styles.modeSwitch} aria-label="新增类型">
          <button
            type="button"
            className={mode === 'plan' ? styles.modeActive : ''}
            onClick={() => setMode('plan')}
          >
            新计划
          </button>
          <button
            type="button"
            className={mode === 'task' ? styles.modeActive : ''}
            onClick={() => setMode('task')}
            disabled={activePlans.length === 0}
          >
            新任务
          </button>
        </div>

        {mode === 'plan' ? (
          <>
            <label className={styles.field}>
              <span>你想实现什么？</span>
              <input
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="例如：四周建立每周三练的习惯"
                maxLength={256}
                autoFocus
              />
            </label>
            <label className={styles.field}>
              <span>第一步（可选）</span>
              <input
                value={firstTask}
                onChange={event => setFirstTask(event.target.value)}
                placeholder="例如：今晚完成 20 分钟基础训练"
                maxLength={256}
              />
            </label>
            <div className={styles.formGrid}>
              <label className={styles.field}>
                <span>开始日期</span>
                <input type="date" value={startDate} onChange={event => setStartDate(event.target.value)} />
              </label>
              <label className={styles.field}>
                <span>计划天数（可选）</span>
                <input
                  type="number"
                  min={0}
                  max={3650}
                  value={totalDays}
                  onChange={event => setTotalDays(event.target.value)}
                  placeholder="例如：28"
                />
              </label>
            </div>
          </>
        ) : (
          <>
            <label className={styles.field}>
              <span>加入哪个计划？</span>
              <select value={planId} onChange={event => setPlanId(event.target.value)}>
                {activePlans.map(plan => (
                  <option key={plan.id} value={plan.id}>{plan.title}</option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>要完成什么？</span>
              <input
                value={title}
                onChange={event => setTitle(event.target.value)}
                placeholder="例如：整理第一版宣传脚本"
                maxLength={256}
                autoFocus
              />
            </label>
            <label className={styles.field}>
              <span>安排日期</span>
              <input type="date" value={taskDate} onChange={event => setTaskDate(event.target.value)} />
            </label>
          </>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.sheetActions}>
          <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button type="submit" className={styles.primaryButton} disabled={saving || !title.trim()}>
            {saving && <SpinnerGap size={16} className="animate-spin" />}
            {mode === 'plan' ? '创建计划' : '添加任务'}
          </button>
        </div>
      </form>
    </BottomSheet>
  );
}
