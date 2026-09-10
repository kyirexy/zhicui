'use client';

import type { CSSProperties } from 'react';
import Link from 'next/link';
import {
  Captions,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import {
  getRecentCompletedResults,
  libraryExtractionHeading,
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
  const isStructuredJob = job.operation === 'full';
  const progressStyle = {
    '--library-live-progress': summary.percent / 100,
  } as CSSProperties;

  return (
    <section
      className="library-live-progress"
      aria-live="polite"
      aria-label={isTranscriptJob
        ? '文案实时提取进度'
        : isStructuredJob
          ? '结构化文案实时提取进度'
          : 'AI 实时处理进度'}
    >
      <div className="library-live-progress-heading">
        <span className="library-live-progress-icon" aria-hidden="true">
          {job.status === 'running'
            ? <LoaderCircle size={17} className="animate-spin" />
            : summary.failed > 0 ? <TriangleAlert size={17} /> : <CheckCircle2 size={17} />}
        </span>
        <div>
          <strong>
            {libraryExtractionHeading(job)}
          </strong>
          <p>
            {job.status === 'running'
              ? `同时处理中 ${summary.active} 条 · 已完成 ${summary.completed}/${summary.total} · 排队 ${summary.queued} 条。已完成的文案可直接查看和提问。`
              : `已完成 ${summary.completed}/${summary.total} 条${summary.failed > 0 ? `，${summary.failed} 条未完成，可重试` : '，可以查看和提问'}。`}
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
          同时处理 <b>{summary.active}</b>
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
            {isTranscriptJob ? <Captions size={13} /> : <Sparkles size={13} />}
            刚刚完成
          </p>
          <div>
            {recentResults.map(({ item, transcriptChars }) => (
              <Link
                key={item.aweme_id}
                href={`/library/detail?id=${encodeURIComponent(item.aweme_id)}`}
                className="library-live-result"
              >
                <LibraryCoverImage
                  key={item.cover_proxy_url || item.cover_url || item.aweme_id}
                  src={item.cover_proxy_url || item.cover_url}
                  fallbackClassName="library-live-result-cover"
                  iconSize={17}
                  retryable={false}
                />
                <span>
                  <strong title={item.title}>{item.title}</strong>
                  <small>
                    <CheckCircle2 size={12} />
                    {formatCount(transcriptChars)}
                    {isTranscriptJob
                      ? ' · 现在可提问'
                      : isStructuredJob
                        ? ' · 结构化文案已完成'
                        : ' · AI 已完成'}
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
