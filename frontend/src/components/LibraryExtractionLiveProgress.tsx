'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Clock3,
  FileText,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react';
import {
  getRecentCompletedResults,
  summarizeLibraryExtraction,
} from '@/lib/libraryExtractionProgress';
import type {
  DouyinBatchExtractionJob,
  DouyinLibraryItem,
} from '@/lib/types';

interface LibraryExtractionLiveProgressProps {
  job: DouyinBatchExtractionJob;
  items: DouyinLibraryItem[];
}

function formatCount(value: number): string {
  if (value < 1000) return `${value} 字`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k 字`;
}

export default function LibraryExtractionLiveProgress({
  job,
  items,
}: LibraryExtractionLiveProgressProps) {
  const summary = summarizeLibraryExtraction(job);
  const recentResults = getRecentCompletedResults(job, items);
  const isTranscriptJob = job.operation === 'transcript';
  const progressStyle = {
    '--library-live-progress': summary.percent / 100,
  } as CSSProperties;

  return (
    <section
      className="library-live-progress"
      aria-live="polite"
      aria-label={isTranscriptJob ? '文案实时提取进度' : 'AI 实时处理进度'}
    >
      <div className="library-live-progress-heading">
        <span className="library-live-progress-icon" aria-hidden="true">
          {job.status === 'running'
            ? <LoaderCircle size={17} className="animate-spin" />
            : <CheckCircle2 size={17} />}
        </span>
        <div>
          <strong>{isTranscriptJob ? '文案正在逐条就绪' : 'AI 正在逐条完成'}</strong>
          <p>
            {summary.completed > 0
              ? `已经完成 ${summary.completed} 条，可以先查看和提问，不用等全部结束。`
              : '第一条完成后会马上显示在这里，不用等整批结束。'}
          </p>
        </div>
        <b className="library-live-progress-total">
          {summary.completed}
          <span>/{summary.total}</span>
        </b>
      </div>

      <div
        className="library-live-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={summary.total}
        aria-valuenow={summary.completed + summary.failed}
        aria-valuetext={`已完成 ${summary.completed} 条，失败 ${summary.failed} 条，共 ${summary.total} 条`}
      >
        <span style={progressStyle} />
      </div>

      <div className="library-live-progress-stats" aria-label="当前处理状态">
        <span className="is-complete">
          <CheckCircle2 size={13} />
          已完成 <b>{summary.completed}</b>
        </span>
        <span>
          <LoaderCircle size={13} />
          处理中 <b>{summary.active}</b>
        </span>
        <span>
          <Clock3 size={13} />
          等待 <b>{summary.queued}</b>
        </span>
        {summary.failed > 0 && (
          <span className="is-error">
            <TriangleAlert size={13} />
            失败 <b>{summary.failed}</b>
          </span>
        )}
      </div>

      {recentResults.length > 0 && (
        <div className="library-live-results">
          <p>
            <FileText size={13} />
            刚刚完成
          </p>
          <div>
            {recentResults.map(({ item, transcriptChars }) => (
              <Link
                key={item.aweme_id}
                href={`/library/detail?id=${encodeURIComponent(item.aweme_id)}`}
                className="library-live-result"
              >
                {item.cover_url ? (
                  <img src={item.cover_url} alt="" loading="lazy" />
                ) : (
                  <span className="library-live-result-cover" aria-hidden="true">
                    <FileText size={17} />
                  </span>
                )}
                <span>
                  <strong title={item.title}>{item.title}</strong>
                  <small>
                    <CheckCircle2 size={12} />
                    {formatCount(transcriptChars)}
                    {isTranscriptJob ? ' · 现在可提问' : ' · AI 已完成'}
                  </small>
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
