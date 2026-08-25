'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowRight,
  Check,
  CheckCircle,
  ListChecks,
  SpinnerGap,
  WarningCircle,
} from '@phosphor-icons/react';
import { applyAgentPlanChange } from '@/lib/api';
import type { AgentMessage } from '@/lib/types';

interface Props {
  message: AgentMessage;
  disabled?: boolean;
}

export default function AgentPlanChangeCard({ message, disabled = false }: Props) {
  const change = message.result?.plan_change;
  const [state, setState] = useState(change?.state || 'pending');
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  if (message.result?.type !== 'plan_change_preview' || !change) return null;

  const apply = async () => {
    if (applying || state === 'applied') return;
    setApplying(true);
    setError('');
    const response = await applyAgentPlanChange(message.id);
    setApplying(false);
    if (!response.success || !response.data) {
      setError(response.error || '计划调整没有应用，请重试。');
      return;
    }
    setState('applied');
  };

  const diff = change.diff;
  const changed = diff.additions.length + diff.modifications.length + diff.removals.length;

  return (
    <section className="video-agent-plan-change" data-state={state}>
      <header>
        <span aria-hidden="true">
          {state === 'applied' ? <CheckCircle size={19} weight="fill" /> : <ListChecks size={19} />}
        </span>
        <div>
          <strong>{state === 'applied' ? '计划已更新' : '计划变更预览'}</strong>
          <small>{state === 'applied' ? '修改已安全应用' : '确认前不会修改原计划'}</small>
        </div>
      </header>

      <div className="video-agent-plan-change-stats" aria-label="计划变更统计">
        <span><b>{diff.additions.length}</b>新增</span>
        <span><b>{diff.modifications.length}</b>调整</span>
        <span><b>{diff.removals.length}</b>移除</span>
        <span><b>{diff.completed_tasks_preserved}</b>已完成保留</span>
      </div>

      {changed > 0 && (
        <ul className="video-agent-plan-change-list">
          {diff.additions.slice(0, 3).map((item) => (
            <li key={`add-${item.task_id}`}><i data-kind="add">+</i><span>{item.title}</span></li>
          ))}
          {diff.modifications.slice(0, 3).map((item) => (
            <li key={`edit-${item.task_id}`}><i data-kind="edit">调</i><span>{String(item.after.title || item.before.title || '任务安排')}</span></li>
          ))}
          {diff.removals.slice(0, 3).map((item) => (
            <li key={`remove-${item.task_id}`}><i data-kind="remove">−</i><span>{item.title}</span></li>
          ))}
        </ul>
      )}

      {error && (
        <p className="video-agent-plan-change-error" role="alert">
          <WarningCircle size={15} />{error}
        </p>
      )}

      <footer>
        {state === 'applied' ? (
          <Link href={`/plans?id=${encodeURIComponent(change.plan_id)}`}>
            查看更新后的计划 <ArrowRight size={15} />
          </Link>
        ) : (
          <>
            <Link href={`/plans?id=${encodeURIComponent(change.plan_id)}`} className="is-secondary">
              查看原计划
            </Link>
            <button type="button" onClick={() => void apply()} disabled={disabled || applying}>
              {applying ? <SpinnerGap size={16} className="animate-spin" /> : <Check size={16} weight="bold" />}
              {applying ? '正在应用' : '确认应用'}
            </button>
          </>
        )}
      </footer>
    </section>
  );
}
