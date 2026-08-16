'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, Sparkle, SpinnerGap } from '@phosphor-icons/react';
import { applyPlanCoaching, previewPlanCoaching } from '@/lib/api';
import type { PlanCoachPreview, PlanData } from '@/lib/types';
import styles from './PlanWorkspace.module.css';

interface Props {
  plan: PlanData;
  onMutate: (plan: PlanData) => void;
}

const suggestions = [
  '把接下来一周安排得更轻一点',
  '只保留最重要的三步',
  '把逾期任务重新排到可执行的日期',
];

export default function PlanCoachPanel({ plan, onMutate }: Props) {
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [preview, setPreview] = useState<PlanCoachPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setPreview(null);
    setError('');
  }, [plan.updated_at]);

  const generate = async () => {
    if (!instruction.trim() || loading) return;
    setLoading(true);
    setError('');
    setPreview(null);
    const response = await previewPlanCoaching(plan.id, instruction.trim());
    if (response.success && response.data) setPreview(response.data);
    else setError(response.error || '暂时无法生成调整方案。');
    setLoading(false);
  };

  const apply = async () => {
    if (!preview || applying) return;
    setApplying(true);
    setError('');
    const response = await applyPlanCoaching(plan.id, {
      base_updated_at: preview.base_updated_at,
      operations: preview.operations,
    });
    if (response.success && response.data) {
      onMutate(response.data);
      setPreview(null);
      setInstruction('');
      setOpen(false);
    } else {
      setError(response.error || '调整方案应用失败，请重新生成预览。');
    }
    setApplying(false);
  };

  return (
    <section className={styles.panel}>
      <div className={styles.coachIntro}>
        <span className={styles.coachIcon}><Sparkle size={19} weight="duotone" /></span>
        <div>
          <h3>调整计划</h3>
          <p>{plan.note_id ? '结合视频资料预览调整。' : '先预览，再应用。'}</p>
        </div>
      </div>

      {!open ? (
        <button type="button" className={`${styles.secondaryButton} mt-3 w-full`} onClick={() => setOpen(true)}>
          开始调整
        </button>
      ) : (
        <div className={styles.coachForm}>
          <textarea
            value={instruction}
            onChange={event => setInstruction(event.target.value)}
            placeholder="例如：这周只有三个晚上有空，帮我降低任务量，并保留最重要的里程碑。"
            maxLength={1000}
          />
          <div className={styles.suggestionChips}>
            {suggestions.map(value => (
              <button type="button" key={value} onClick={() => setInstruction(value)}>{value}</button>
            ))}
          </div>
          <button type="button" className={styles.primaryButton} onClick={() => void generate()} disabled={loading || !instruction.trim()}>
            {loading && <SpinnerGap size={16} className="animate-spin" />}
            {loading ? '正在规划…' : '生成调整预览'}
          </button>
        </div>
      )}

      {error && <p className={`${styles.error} mt-3`} role="alert">{error}</p>}

      {preview && (
        <div className={styles.preview}>
          <p className={styles.previewSummary}>{preview.change_summary}</p>
          <div className={styles.diffLine}>
            <span className={styles.diffBadge}>新增 {preview.diff.additions.length}</span>
            <span className={styles.diffBadge}>调整 {preview.diff.modifications.length}</span>
            <span className={styles.diffBadge}>移除 {preview.diff.removals.length}</span>
            <span className={styles.diffBadge}>保留完成记录 {preview.diff.completed_tasks_preserved}</span>
          </div>
          {(preview.diff.additions.length > 0 || preview.diff.removals.length > 0) && (
            <ul className={styles.diffList}>
              {preview.diff.additions.slice(0, 4).map(item => <li key={`add-${item.task_id}`}>新增：{item.title}</li>)}
              {preview.diff.removals.slice(0, 4).map(item => <li key={`remove-${item.task_id}`}>移除：{item.title}</li>)}
            </ul>
          )}
          <p className={styles.sectionHint}>
            <ShieldCheck size={14} className="mr-1 inline" />
            已完成任务不会被修改或删除；确认前数据库不会发生变化。
          </p>
          <div className={styles.sheetActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setPreview(null)} disabled={applying}>放弃预览</button>
            <button type="button" className={styles.primaryButton} onClick={() => void apply()} disabled={applying}>
              {applying && <SpinnerGap size={16} className="animate-spin" />}
              确认应用
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
