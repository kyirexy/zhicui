'use client';

import Link from 'next/link';
import {
  Captions,
  Check,
  LoaderCircle,
  NotebookPen,
  Square,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import PlatformBrandIcon from '@/components/PlatformBrandIcon';
import type { PlatformLibraryItem } from '@/lib/types';
import styles from './LibraryReferenceWorkspace.module.css';

export interface CrossPlatformLibraryRowProps {
  item: PlatformLibraryItem;
  active: boolean;
  initializing?: boolean;
  busy?: boolean;
  actionError?: string;
  layout?: 'list' | 'grid';
  selected?: boolean;
  selectionDisabled?: boolean;
  coverPriority?: boolean;
  onActivate: (item: PlatformLibraryItem) => void;
  onInitialize: (item: PlatformLibraryItem) => void | Promise<void>;
  onToggleSelection?: (item: PlatformLibraryItem) => void;
  onRefreshCover?: (item: PlatformLibraryItem) => Promise<Array<string | null | undefined> | void>;
}

function formatDate(value: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(parsed);
}

function platformLabel(item: PlatformLibraryItem): string {
  return item.platform === 'bilibili' ? 'B站' : '小红书';
}

function transcriptLabel(item: PlatformLibraryItem): string {
  if (item.speech_ready) {
    if (item.transcript_source === 'manual-subtitle') return '人工字幕已就绪';
    if (item.transcript_source === 'automatic-subtitle') return '平台字幕已就绪';
    return '语音文案已就绪';
  }
  if (item.degraded || item.transcript_source === 'caption-only') {
    return '当前仅有发布文案';
  }
  return '完整文案待处理';
}

export default function CrossPlatformLibraryRow({
  item,
  active,
  initializing = false,
  busy = false,
  actionError = '',
  layout = 'list',
  selected = false,
  selectionDisabled = false,
  coverPriority = false,
  onActivate,
  onInitialize,
  onToggleSelection,
  onRefreshCover,
}: CrossPlatformLibraryRowProps) {
  const detailHref = `/library/detail?note=${encodeURIComponent(item.id)}`;
  const summaryHref = `/notes?id=${encodeURIComponent(item.id)}`;
  const displayDate = formatDate(item.published_at || item.imported_at);

  return (
    <article
      className={styles.crossRow}
      data-active={active}
      data-selected={selected}
      data-layout={layout}
      aria-labelledby={`platform-library-title-${item.id}`}
    >
      <button
        type="button"
        className={styles.crossRowActivation}
        onClick={() => onActivate(item)}
        aria-label={`在当前资料中预览：${item.title}`}
        aria-pressed={active}
      />

      <div className={styles.crossRowCover}>
        <LibraryCoverImage
          src={item.cover_url}
          sources={[item.cover_url]}
          onRefreshSources={onRefreshCover ? () => onRefreshCover(item) : undefined}
          fallbackClassName={styles.crossRowCoverFallback}
          fallbackLabel="封面暂不可用"
          alt={`${item.title}的封面`}
          iconSize={20}
          priority={coverPriority}
        />
        <span className={styles.platformMark} data-platform={item.platform}>
          <PlatformBrandIcon platform={item.platform} size={13} />
          {platformLabel(item)}
        </span>
        {item.media_type === 'video' && onToggleSelection && (
          <button
            type="button"
            className={styles.crossRowSelect}
            onClick={() => onToggleSelection(item)}
            disabled={selectionDisabled}
            aria-label={selected ? `取消选择 ${item.title}` : `选择 ${item.title}`}
            aria-pressed={selected}
          >
            {selected ? <Check size={16} aria-hidden="true" /> : <Square size={15} aria-hidden="true" />}
          </button>
        )}
      </div>

      <div className={styles.crossRowContent}>
        <header className={styles.crossRowHeading}>
          <h3 id={`platform-library-title-${item.id}`} title={item.title}>
            {item.title}
          </h3>
          <div className={styles.crossRowMeta}>
            {item.author_name && <span>{item.author_name}</span>}
            {displayDate && (
              <time dateTime={item.published_at || item.imported_at}>{displayDate}</time>
            )}
          </div>
        </header>

        <div
          className={styles.crossRowStatus}
          data-ready={item.speech_ready}
          aria-label={`文案状态：${transcriptLabel(item)}`}
        >
          <Captions size={14} />
          <span>{transcriptLabel(item)}</span>
          {item.transcript_chars > 0 && (
            <b>{item.transcript_chars.toLocaleString('zh-CN')} 字</b>
          )}
        </div>

        {actionError && (
          <p className={styles.crossRowError} role="alert">{actionError}</p>
        )}

      </div>

      <div className={styles.crossRowActions} aria-label={`${item.title}的可用操作`}>
        <Link href={detailHref}>
          查看详情
        </Link>
        {item.ai_initialized ? (
          <Link href={summaryHref}>
            <NotebookPen size={14} />
            查看摘要
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => void onInitialize(item)}
            disabled={busy}
          >
            {initializing ? (
              <LoaderCircle size={14} className="animate-spin" />
            ) : (
              <NotebookPen size={14} />
            )}
            {initializing ? '正在生成' : '生成摘要'}
          </button>
        )}
      </div>
    </article>
  );
}
