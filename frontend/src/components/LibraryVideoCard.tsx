'use client';

import Link from 'next/link';
import {
  AlertCircle,
  ArrowUpRight,
  Captions,
  Check,
  CheckCircle2,
  CircleDashed,
  LoaderCircle,
  Play,
  Square,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import type { DouyinLibraryItem } from '@/lib/types';

export type LibraryExtractState =
  | 'idle'
  | 'queued'
  | 'extracting'
  | 'transcribing'
  | 'analyzing'
  | 'done'
  | 'error';

interface LibraryVideoCardProps {
  item: DouyinLibraryItem;
  selected: boolean;
  selectionDisabled?: boolean;
  extractState?: LibraryExtractState;
  extractError?: string;
  onToggle: (awemeId: string) => void;
  onRefreshCover?: (item: DouyinLibraryItem) => Promise<Array<string | null | undefined> | void>;
}

export default function LibraryVideoCard({
  item,
  selected,
  selectionDisabled = false,
  extractState = 'idle',
  extractError,
  onToggle,
  onRefreshCover,
}: LibraryVideoCardProps) {
  const isWorking = ['queued', 'extracting', 'transcribing', 'analyzing'].includes(extractState);
  const isExtracted = item.extracted || extractState === 'done';
  const visualState = extractState === 'error'
    ? 'has-extract-error'
    : isWorking
      ? 'is-extracting'
      : extractState === 'done'
        ? 'is-extract-ready'
        : '';
  const displayDate = item.date || item.recorded_at?.slice(0, 10) || '';
  const hasTranscript = isExtracted && item.transcript_chars > 0;
  const organizationLabel = extractState === 'error'
    ? '失败'
    : isWorking
      ? '整理中'
        : item.ai_initialized
        ? '已整理'
        : hasTranscript
          ? '文案已就绪'
          : item.can_extract
            ? '待整理'
            : '仅可查看';
  const organizationTone = extractState === 'error'
    ? 'is-error'
    : isWorking
      ? 'is-working'
      : item.ai_initialized || hasTranscript
        ? 'is-ready'
        : 'is-pending';
  const organizationDescription = extractState === 'error' && extractError
    ? `${organizationLabel}：${extractError}`
    : !item.can_extract && !hasTranscript
      ? '当前视频暂不可整理，可继续查看原视频'
      : organizationLabel;

  return (
    <article
      className={`library-video-card ${selected ? 'is-selected' : ''} ${visualState}`}
      data-extract-state={extractState}
      data-marquee-id={item.aweme_id}
    >
      <Link
        href={`/library/detail?id=${encodeURIComponent(item.aweme_id)}`}
        className="library-video-detail-link"
        aria-label={`打开 ${item.title} 的视频知识详情`}
      >
        <span className="sr-only">打开视频知识详情</span>
      </Link>
      <div className="library-video-cover">
        <LibraryCoverImage
          key={item.cover_proxy_url || item.cover_url || item.aweme_id}
          src={item.cover_proxy_url || item.cover_url}
          sources={[item.cover_proxy_url, item.cover_url]}
          onRefreshSources={onRefreshCover ? () => onRefreshCover(item) : undefined}
          fallbackClassName="library-video-cover-fallback"
          fallbackLabel="封面暂不可用"
          iconSize={24}
        />
        <button
          type="button"
          className="library-select-button"
          onClick={() => {
            if (!selectionDisabled) onToggle(item.aweme_id);
          }}
          disabled={selectionDisabled}
          aria-label={selected ? `取消选择 ${item.title}` : `选择 ${item.title}`}
          aria-pressed={selected}
        >
          <span className="library-card-control-visual" aria-hidden="true">
            {selected ? <Check size={16} /> : <Square size={15} />}
          </span>
        </button>
        {item.media_url && (
          <a
            href={item.media_url}
            target="_blank"
            rel="noreferrer"
            className="library-play-button"
            aria-label={`播放 ${item.title}`}
          >
            <span className="library-card-control-visual" aria-hidden="true">
              <Play size={14} fill="currentColor" />
            </span>
          </a>
        )}
      </div>

      <div className="library-video-body">
        <div className="library-video-meta">
          <span className="library-platform-label" aria-label="平台：抖音">
            <PlatformBrandIcon platform="douyin" size={12} />
            抖音
          </span>
          <span>{item.author_name || '未知作者'}</span>
          {displayDate && (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={displayDate}>{displayDate}</time>
            </>
          )}
        </div>
        <h3 title={item.title}>
          {item.title}
        </h3>

        <div className="library-video-actions">
          <div
            className="library-video-statuses"
            aria-label="整理状态"
          >
            <span
              className={`library-video-status ${organizationTone}`}
              aria-label={`整理状态：${organizationDescription}`}
              title={organizationDescription}
            >
              {extractState === 'error' ? (
                <AlertCircle size={13} />
              ) : isWorking ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : item.ai_initialized ? (
                <CheckCircle2 size={13} />
              ) : hasTranscript ? (
                <Captions size={13} />
              ) : (
                <CircleDashed size={13} />
              )}
              <span>{organizationLabel}</span>
            </span>
          </div>
        </div>
        {extractState === 'error' && extractError && (
          <p className="library-video-inline-error" role="alert" title={extractError}>
            {extractError}
          </p>
        )}
        <span className="library-detail-hint" aria-hidden="true">
          打开详情
          <ArrowUpRight size={12} />
        </span>
      </div>
    </article>
  );
}
