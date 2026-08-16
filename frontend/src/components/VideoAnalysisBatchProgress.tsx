'use client';

import type { CSSProperties } from 'react';
import { CheckCircle2, Clock3, LoaderCircle, ScanSearch, TriangleAlert } from 'lucide-react';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import { runItemCount } from '@/lib/videoAnalysis';

export default function VideoAnalysisBatchProgress() {
  const { activeRuns } = useVideoAnalysis();
  const runs = activeRuns.filter(run => run.trigger === 'batch' || runItemCount(run) > 1);
  if (!runs.length) return null;

  const total = runs.reduce((sum, run) => sum + runItemCount(run), 0);
  const completed = runs.reduce((sum, run) => (
    sum + Number(run.completed_count || run.items?.filter(item => (
      item.status === 'succeeded' || item.status === 'partial' || item.status === 'cached'
    )).length || 0)
  ), 0);
  const failed = runs.reduce((sum, run) => (
    sum + Number(run.failed_count || run.items?.filter(item => (
      item.status === 'failed' || item.status === 'unsupported' || item.status === 'cancelled'
    )).length || 0)
  ), 0);
  const settled = Math.min(total, completed + failed);
  const active = Math.max(0, runs.reduce((sum, run) => (
    sum + (run.items?.filter(item => item.status === 'running').length || 0)
  ), 0) || (total - settled > 0 ? runs.length : 0));
  const queued = Math.max(0, total - completed - failed - active);
  const progressStyle = {
    '--library-live-progress': total ? settled / total : 0,
  } as CSSProperties;

  return (
    <section
      className="library-live-progress"
      aria-live="polite"
      aria-label="详细视频解析后台进度"
    >
      <div className="library-live-progress-heading">
        <span className="library-live-progress-icon" aria-hidden="true">
          <LoaderCircle size={17} className="animate-spin" />
        </span>
        <div>
          <strong>详细解析正在后台逐条完成</strong>
          <p>
            {completed > 0
              ? `已经完成 ${completed} 条，成功项可以先用于摘要和提问。`
              : '任务已进入后台，可以继续浏览或离开这个页面。'}
          </p>
        </div>
        <b className="library-live-progress-total">
          {completed}
          <span>/{total}</span>
        </b>
      </div>

      <div
        className="library-live-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={settled}
        aria-valuetext={`已完成 ${completed} 条，失败或不支持 ${failed} 条，共 ${total} 条`}
      >
        <span style={progressStyle} />
      </div>

      <div className="library-live-progress-stats" aria-label="当前解析状态">
        <span className="is-complete"><CheckCircle2 size={13} />已完成 <b>{completed}</b></span>
        <span><ScanSearch size={13} />处理中 <b>{active}</b></span>
        <span><Clock3 size={13} />等待 <b>{queued}</b></span>
        {failed > 0 && (
          <span className="is-error"><TriangleAlert size={13} />失败或不支持 <b>{failed}</b></span>
        )}
        <button
          type="button"
          className="library-text-action"
          onClick={() => window.dispatchEvent(new Event('vc:open-video-analysis-sheet'))}
        >
          查看逐项结算
        </button>
      </div>
    </section>
  );
}
