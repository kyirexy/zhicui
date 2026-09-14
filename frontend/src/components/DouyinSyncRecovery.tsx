'use client';

import { useId, useState } from 'react';
import type { DouyinSyncRecoveryIssue } from '@/lib/douyinSyncRecovery';
import styles from './DouyinSyncRecovery.module.css';

const MODE_LABELS: Record<DouyinSyncRecoveryIssue['mode'], string> = {
  like: '喜欢',
  collect: '收藏',
  post: '作品',
};

interface DouyinSyncRecoveryProps {
  issues: DouyinSyncRecoveryIssue[];
  busy: boolean;
  focusing: boolean;
  canFocus: boolean;
  loggedIn: boolean;
  actionError: string;
  onFocus: () => void;
  onCancel: () => void;
  onRetry: (issue: DouyinSyncRecoveryIssue) => void;
}

export default function DouyinSyncRecovery({
  issues, busy, focusing, canFocus, loggedIn, actionError, onFocus, onCancel, onRetry,
}: DouyinSyncRecoveryProps) {
  const titleId = useId();
  const [selection, setSelection] = useState<{
    mode: DouyinSyncRecoveryIssue['mode'];
    phase: DouyinSyncRecoveryIssue['phase'];
  } | null>(null);
  const waitingIssues = issues.filter((item) => item.phase === 'waiting');
  const selectableIssues = waitingIssues.length > 0 ? waitingIssues : issues;
  const issue = selectableIssues.find((item) => item.mode === selection?.mode && item.phase === selection.phase)
    ?? selectableIssues[0];

  if (!issue) return null;

  const label = MODE_LABELS[issue.mode];
  const waiting = issue.phase === 'waiting';
  const needsLogin = issue.reason === 'login' && !loggedIn;
  const title = needsLogin
    ? '登录抖音后继续同步'
    : issue.reason === 'profile'
      ? '回到你的抖音主页'
      : waiting ? '在抖音完成操作后继续同步' : `继续同步抖音${label}`;
  const description = needsLogin
    ? '请重新登录你的抖音账号。'
    : waiting && !canFocus
      ? `从任务栏切到抖音窗口，打开你的“${label}”，如有验证请先完成。`
      : `在抖音中打开你的“${label}”，如有验证请先完成。`;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      {issues.length > 1 && (
        <div className={styles.sources} role="group" aria-label="选择需要处理的抖音分类">
          {issues.map((item) => (
            <button
              key={item.mode}
              type="button"
              aria-pressed={issue.mode === item.mode}
              disabled={waitingIssues.length > 0 && item.phase !== 'waiting'}
              onClick={() => setSelection({ mode: item.mode, phase: item.phase })}
            >
              {MODE_LABELS[item.mode]}
              <span>{item.phase === 'waiting' ? '等待操作' : '待继续'}</span>
            </button>
          ))}
        </div>
      )}

      <div className={styles.mainRow}>
        <header className={styles.heading}>
          <h2 id={titleId}>{title}</h2>
          <p className={styles.description}>{description}</p>
        </header>
        <div className={styles.actions}>
          {waiting ? (
            <>
              {canFocus && (
                <button type="button" className={styles.primary} disabled={focusing} onClick={onFocus}>
                  {focusing ? '正在显示…' : '显示抖音窗口'}
                </button>
              )}
              <button type="button" className={styles.secondary} onClick={onCancel}>取消同步</button>
            </>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              aria-label={needsLogin ? '重新登录抖音' : `打开抖音继续同步${label}`}
              onClick={() => onRetry(issue)}
            >
              {busy ? '正在继续…' : needsLogin ? '重新登录抖音' : '打开抖音继续'}
            </button>
          )}
        </div>
      </div>
      {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}
      <details className={styles.help}>
        <summary>找不到入口？</summary>
        <p>点击抖音右上角头像，进入自己的主页，再选择“{label}”。如出现登录或验证提示，先按抖音页面完成。</p>
      </details>
    </section>
  );
}
