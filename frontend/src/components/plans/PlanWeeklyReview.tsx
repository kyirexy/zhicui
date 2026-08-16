'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { CaretLeft, CaretRight, ChartLineUp, SpinnerGap } from '@phosphor-icons/react';
import { getPlanWeeklyReview } from '@/lib/api';
import type { PlanWeeklyReview } from '@/lib/types';
import { getChinaToday } from '@/lib/types';
import styles from './PlanWorkspace.module.css';

function mondayOf(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday);
  return date.toISOString().slice(0, 10);
}

function shiftWeek(isoDate: string, weeks: number) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return date.toISOString().slice(0, 10);
}

function weekLabel(review: PlanWeeklyReview) {
  const start = review.week_start.slice(5).replace('-', '/');
  const end = review.week_end.slice(5).replace('-', '/');
  return `${start} — ${end}`;
}

export default function PlanWeeklyReviewView() {
  const [weekStart, setWeekStart] = useState(() => mondayOf(getChinaToday()));
  const [review, setReview] = useState<PlanWeeklyReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (value: string) => {
    setLoading(true);
    setError('');
    const response = await getPlanWeeklyReview(value);
    if (response.success && response.data) setReview(response.data);
    else setError(response.error || '本周复盘暂时无法读取。');
    setLoading(false);
  }, []);

  useEffect(() => { void load(weekStart); }, [load, weekStart]);

  const currentWeek = mondayOf(getChinaToday());
  const metrics = review ? [
    ['完成任务', review.summary.completed_tasks],
    ['本周排期', review.summary.scheduled_tasks],
    ['发生顺延', review.summary.carried_over_tasks],
    ['当前逾期', review.summary.overdue_tasks],
    ['完成计划', review.summary.completed_plans],
  ] as const : [];

  return (
    <section aria-labelledby="weekly-review-title">
      <div className={styles.reviewTopline}>
        <div>
          <h2 id="weekly-review-title" className={styles.sectionTitle}>本周复盘</h2>
        </div>
        <div className={styles.weekPicker}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setWeekStart(value => shiftWeek(value, -1))}
            aria-label="上一周"
          ><CaretLeft size={17} /></button>
          <span className={styles.weekLabel}>{review ? weekLabel(review) : '读取中…'}</span>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setWeekStart(value => shiftWeek(value, 1))}
            disabled={weekStart >= currentWeek}
            aria-label="下一周"
          ><CaretRight size={17} /></button>
        </div>
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {loading ? (
        <div className={styles.emptyState}>
          <SpinnerGap size={22} className="animate-spin" />
          <p>正在整理这周的真实进度…</p>
        </div>
      ) : review ? (
        <>
          <div className={styles.reviewSummary}>
            {metrics.map(([label, value]) => (
              <div key={label} className={styles.reviewMetric}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <p className={styles.truthNote}>{review.history_note}</p>

          {review.plans.length > 0 ? (
            <div className={styles.reviewList}>
              {review.plans.map(row => (
                <article key={row.plan_id} className={styles.reviewRow}>
                  <span className={styles.reviewRowTitle}>{row.plan_title}</span>
                  <span className={styles.reviewDatum}><strong>{row.completed}</strong>完成</span>
                  <span className={styles.reviewDatum}><strong>{row.carried_over}</strong>顺延</span>
                  <span className={styles.reviewDatum}><strong>{row.overdue}</strong>逾期</span>
                  <Link href={`/plans?id=${row.plan_id}`} className={styles.iconButton} aria-label={`查看 ${row.plan_title}`}>
                    <CaretRight size={16} />
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}><ChartLineUp size={21} weight="duotone" /></span>
              <h3>这一周还没有执行记录</h3>
              <p>完成任务后会生成本周记录。</p>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
