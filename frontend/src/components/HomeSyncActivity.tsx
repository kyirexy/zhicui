'use client';

import Link from 'next/link';
import { ArrowsClockwise, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useLibrarySync } from '@/lib/hooks/LibrarySyncContext';
import { captureLabel, syncRunLabel } from '@/lib/librarySyncMonitor';
import styles from './HomeSyncActivity.module.css';

const platforms: Record<string, string> = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书', mixed: '视频' };
const modes: Record<string, string> = { like: '喜欢', collect: '收藏', post: '作品', import: '导入' };

export default function HomeSyncActivity() {
  const { runs, capture, offline } = useLibrarySync();
  if (!runs.length && !capture && !offline) return null;
  const busy = runs.some((run) => run.status === 'running') || Boolean(capture
    && !['error', 'cancelled', 'disconnected'].includes(capture.stage));
  const visible = [...runs.filter((run) => run.status === 'running'), ...runs.filter((run) => run.status !== 'running')].slice(0, 4);
  return (
    <section className={styles.activity} aria-label="同步动态" aria-live="polite" aria-atomic="false">
      <header className={styles.heading}>
        <strong><ArrowsClockwise size={18} className={busy ? styles.spin : undefined} aria-hidden="true" />同步动态</strong>
        <span>客户端、CLI 与 Agent 的同步结果都在这里</span>
        <Link href="/library">查看资料 <span aria-hidden="true">→</span></Link>
      </header>
      {capture ? <p className={styles.capture} role="status">{platforms[capture.platform]}{modes[capture.mode || ''] || ''} · {captureLabel(capture)}</p> : null}
      {offline ? <p className={styles.capture} role="status">暂时无法更新同步状态，已显示的结果会保留。</p> : null}
      <ul className={styles.runs}>
        {visible.map((run) => {
          const running = run.status === 'running';
          const problem = ['partial', 'failed', 'invalid', 'rejected'].includes(run.status);
          const Icon = running ? ArrowsClockwise : problem ? WarningCircle : CheckCircle;
          const processed = Math.min(run.requested_count, run.accepted + run.failed_count + (run.skipped || 0));
          return (
            <li key={run.id} className={styles.run} data-warning={problem || undefined}>
              <div><Icon size={16} className={running ? styles.spin : undefined} aria-hidden="true" />
                <strong>{platforms[run.platform] || '视频'} · {modes[run.source_mode] || '同步'}</strong>
                <span>{syncRunLabel(run)}</span>
              </div>
              <p>{running ? `已处理 ${processed}/${run.requested_count} · ` : ''}新增 {run.created} · 复用 {run.reused}
                {run.failed_count > 0 ? ` · 失败 ${run.failed_count}` : ''}
                {(run.skipped || 0) > 0 ? ` · 跳过 ${run.skipped}` : ''}
                {(run.quarantined || 0) > 0 ? ` · 待补资料 ${run.quarantined}` : ''}
              </p>
              {running ? <progress max={Math.max(1, run.requested_count)} value={processed} aria-label="保存视频进度" /> : null}
              <footer><time dateTime={run.started_at}>{new Date(run.started_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
                <Link href={`/library?platform=${encodeURIComponent(run.platform)}&mode=${encodeURIComponent(run.source_mode)}`}>查看{modes[run.source_mode] || '资料'} →</Link>
              </footer>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
