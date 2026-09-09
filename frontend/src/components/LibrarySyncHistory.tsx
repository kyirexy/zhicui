'use client';

import { useEffect, useState } from 'react';
import { listLibrarySyncRuns } from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import { getLibraryRevision, isLibraryRevisionCurrent, subscribeLibraryUpdates } from '@/lib/libraryUpdates';
import type { LibrarySyncRun } from '@/lib/types';

const MODES: Record<string, string> = { collect: '收藏', like: '喜欢', post: '作品', import: '导入' };
const PLATFORMS: Record<string, string> = { douyin: '抖音', bilibili: 'B站', xiaohongshu: '小红书' };
const STATUSES: Record<LibrarySyncRun['status'], string> = {
  running: '结果待确认', succeeded: '已完成', partial: '部分完成', failed: '未完成', rejected: '已跳过', invalid: '请求无效',
};

export default function LibrarySyncHistory() {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [runs, setRuns] = useState<LibrarySyncRun[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setRuns([]);
    setError('');
    if (!expanded || !user?.id) return;
    let active = true;
    let requestId = 0;
    const refresh = async () => {
      const id = ++requestId;
      const revision = getLibraryRevision();
      setLoading(true);
      const response = await listLibrarySyncRuns();
      if (!active || id !== requestId || !isLibraryRevisionCurrent(revision)) return;
      setLoading(false);
      if (response.success && response.data) {
        setRuns(response.data.items);
        setError('');
      } else setError('暂时无法读取同步记录');
    };
    void refresh();
    const unsubscribe = subscribeLibraryUpdates(() => { void refresh(); });
    return () => { active = false; unsubscribe(); };
  }, [expanded, user?.id]);
  return (
    <details className="mt-3 rounded-xl border border-card-border px-4 py-3 text-sm" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">最近同步记录</summary>
      <p className="mt-2 text-xs text-foreground-muted">每批保留新增与复用数量；重复视频只更新来源顺序。</p>
      {loading && runs.length === 0 ? <p className="mt-3" role="status">正在读取…</p> : null}
      {error ? <p className="mt-3" role="status">{error}</p> : null}
      {!loading && !error && runs.length === 0 ? <p className="mt-3 text-foreground-muted">暂无同步记录</p> : null}
      <ul className="mt-2 divide-y divide-card-border">
        {runs.map((run) => (
          <li key={run.id} className="py-3">
            <div className="flex flex-wrap justify-between gap-2">
              <strong className="font-medium">{PLATFORMS[run.platform] || '视频'} · {MODES[run.source_mode] || '同步'}</strong>
              <span className="text-foreground-muted">{STATUSES[run.status]}</span>
            </div>
            <p className="mt-1">新增 {run.created} · 复用 {run.reused} · 失败 {run.failed_count}{run.quarantined > 0 ? ` · 资料不完整 ${run.quarantined}` : ''}{(run.skipped || 0) > 0 ? ` · 跳过 ${run.skipped}` : ''}{(run.pending_count || 0) > 0 ? ` · 待确认 ${run.pending_count}` : ''}</p>
            <time className="text-xs text-foreground-muted" dateTime={run.started_at}>{new Date(run.started_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
          </li>
        ))}
      </ul>
    </details>
  );
}
