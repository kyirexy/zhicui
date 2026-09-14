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
  issues,
  busy,
  focusing,
  canFocus,
  loggedIn,
  actionError,
  onFocus,
  onCancel,
  onRetry,
}: DouyinSyncRecoveryProps) {
  const titleId = useId();
  const [selection, setSelection] = useState<{
    mode: DouyinSyncRecoveryIssue['mode'];
    phase: DouyinSyncRecoveryIssue['phase'];
  } | null>(null);
  const issue = issues.find((item) => item.mode === selection?.mode && item.phase === selection.phase)
    ?? issues.find((item) => item.phase === 'waiting')
    ?? issues[0];

  if (!issue) return null;

  const label = MODE_LABELS[issue.mode];
  const waiting = issue.phase === 'waiting';
  const needsLogin = issue.reason === 'login' && !loggedIn;

  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <header className={styles.header}>
        <span className={styles.marker} aria-hidden="true">!</span>
        <div className={styles.heading}>
          <p className={styles.eyebrow}>抖音同步需要你操作一下</p>
          <h2 id={titleId}>需要在抖音确认“{label}”列表</h2>
          <p className={styles.description}>
            还未确认列表开头，可能是页面未加载或需要登录、验证。请按下面三步操作，避免把旧视频当成最新内容。
          </p>
          {!waiting && <p className={styles.description}>{needsLogin
            ? '先重新登录，再点击重试当前分类。'
            : `先点下方“打开抖音并重试${label}”，再在打开的窗口中操作。`}</p>}
        </div>
      </header>

      {issues.length > 1 && (
        <div className={styles.sources} role="group" aria-label="选择需要处理的抖音分类">
          {issues.map((item) => (
            <button
              key={item.mode}
              type="button"
              aria-pressed={issue.mode === item.mode}
              onClick={() => setSelection({ mode: item.mode, phase: item.phase })}
            >
              {MODE_LABELS[item.mode]}
              <span>{item.phase === 'waiting' ? '等待操作' : '需要重试'}</span>
            </button>
          ))}
        </div>
      )}

      <ol className={styles.steps} role="list">
        <li>
          <span className={styles.stepNumber} aria-hidden="true">1</span>
          <div>
            <strong>确认是你本人的抖音主页</strong>
            <p>切到本次同步打开的抖音窗口，查看右上角头像和账号，再进入“我的主页”。未登录时，请先登录要同步的账号。</p>
          </div>
        </li>
        <li>
          <span className={styles.stepNumber} aria-hidden="true">2</span>
          <div>
            <strong>点击主页里的“{label}”标签</strong>
            <p>如出现验证码或安全验证，请在抖音页面完成，再刷新页面并确认仍在“{label}”标签。</p>
          </div>
        </li>
        <li>
          <span className={styles.stepNumber} aria-hidden="true">3</span>
          <div>
            <strong>等列表顶部的视频显示出来</strong>
            <p>{waiting
              ? '停留在列表开头，不要向下翻页。知萃会继续检查；确认列表后会自动继续，你可以回到知萃查看进度。'
              : '重试时，停留在列表开头，不要向下翻页。知萃确认列表后会继续同步，你可以回到知萃查看进度。'}</p>
          </div>
        </li>
      </ol>

      {waiting && !canFocus && (
        <p className={styles.windowHint}>请从电脑任务栏切换到本次同步打开的 Chrome 或 Edge 窗口；当前版本暂不支持一键切换。</p>
      )}

      <div className={styles.actions}>
        {waiting ? (
          <>
            {canFocus && (
              <button type="button" className={styles.primary} disabled={focusing} onClick={onFocus}>
                {focusing ? '正在显示抖音窗口…' : '显示抖音窗口'}
              </button>
            )}
            <button type="button" className={styles.secondary} onClick={onCancel}>取消本次读取</button>
          </>
        ) : (
          <button type="button" className={styles.primary} disabled={busy} onClick={() => onRetry(issue)}>
            {busy ? '正在处理同步…' : needsLogin ? '重新登录抖音' : `打开抖音并重试${label}`}
          </button>
        )}
      </div>

      {actionError && <p className={styles.actionError} role="alert">{actionError}</p>}

      <p className={styles.retention}>
        已有资料已保留。重试只处理“{label}”分类{issue.count > 0 ? `，本次最多读取 ${issue.count} 条` : ''}。
      </p>
    </section>
  );
}
