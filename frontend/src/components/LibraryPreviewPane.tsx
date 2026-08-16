'use client';

import Link from 'next/link';
import {
  ArrowUpRight,
  Captions,
  ExternalLink,
  MessageSquareText,
  MoreHorizontal,
  NotebookPen,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import PlatformBrandIcon, { type PlatformBrand } from '@/components/PlatformBrandIcon';
import type { DouyinLibraryItem, PlatformLibraryItem } from '@/lib/types';
import styles from './LibraryReferenceWorkspace.module.css';

export type LibraryPreviewSelection =
  | { kind: 'douyin'; item: DouyinLibraryItem }
  | { kind: 'platform'; item: PlatformLibraryItem };

export interface LibraryPreviewPaneProps {
  selection: LibraryPreviewSelection;
}

interface NormalizedPreview {
  title: string;
  caption: string;
  author: string;
  date: string;
  coverUrl: string;
  platform: PlatformBrand;
  sourceUrl: string;
  detailHref: string;
  noteId: string;
  transcriptChars: number;
  transcriptLabel: string;
  transcriptReady: boolean;
  aiInitialized: boolean;
  tags: string[];
}

function platformLabel(platform: string): string {
  if (platform === 'bilibili') return 'B站';
  if (platform === 'xiaohongshu') return '小红书';
  return '抖音';
}

function normalizePlatform(platform: string): PlatformBrand {
  if (platform === 'bilibili' || platform === 'xiaohongshu') return platform;
  return 'douyin';
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

function normalizeSelection(selection: LibraryPreviewSelection): NormalizedPreview {
  if (selection.kind === 'douyin') {
    const item = selection.item;
    const transcriptReady = item.extracted && item.transcript_chars > 0;
    return {
      title: item.title,
      caption: item.caption && item.caption !== item.title ? item.caption : '',
      author: item.author_name,
      date: item.date || item.recorded_at,
      coverUrl: item.cover_proxy_url || item.cover_url,
      platform: normalizePlatform(item.platform || 'douyin'),
      sourceUrl: item.source_url,
      detailHref: `/library/detail?id=${encodeURIComponent(item.aweme_id)}`,
      noteId: item.extracted_note_id || '',
      transcriptChars: item.transcript_chars,
      transcriptLabel: transcriptReady
        ? '完整文案已就绪'
        : item.can_extract
          ? '完整文案待提取'
          : '当前没有可提取视频',
      transcriptReady,
      aiInitialized: item.ai_initialized,
      tags: item.tags,
    };
  }

  const item = selection.item;
  const transcriptReady = item.speech_ready && item.transcript_chars > 0;
  const transcriptLabel = transcriptReady
    ? item.transcript_source === 'manual-subtitle'
      ? '人工字幕已就绪'
      : item.transcript_source === 'automatic-subtitle'
        ? '平台字幕已就绪'
        : '语音文案已就绪'
    : item.degraded || item.transcript_source === 'caption-only'
      ? '当前仅有发布文案'
      : '完整文案待处理';

  return {
    title: item.title,
    caption: item.caption && item.caption !== item.title ? item.caption : '',
    author: item.author_name,
    date: item.published_at || item.imported_at,
    coverUrl: item.cover_url,
    platform: item.platform,
    sourceUrl: item.source_url,
    detailHref: `/library/detail?note=${encodeURIComponent(item.id)}`,
    noteId: item.note?.id || item.id,
    transcriptChars: item.transcript_chars,
    transcriptLabel,
    transcriptReady,
    aiInitialized: item.ai_initialized,
    tags: item.tags,
  };
}

export default function LibraryPreviewPane({ selection }: LibraryPreviewPaneProps) {
  const preview = normalizeSelection(selection);
  const displayDate = formatDate(preview.date);
  const canAskAi = Boolean(preview.noteId && preview.transcriptChars > 0);
  const hasMoreActions = Boolean(
    (preview.aiInitialized && preview.noteId) || preview.sourceUrl,
  );

  return (
    <aside className={styles.previewPane} aria-label={`${preview.title}的资料预览`}>
      <div className={styles.previewPaneCover}>
        <LibraryCoverImage
          key={preview.coverUrl || preview.title}
          src={preview.coverUrl}
          fallbackClassName={styles.previewPaneCoverFallback}
          fallbackLabel="封面暂不可用"
          alt={`${preview.title}的封面`}
          iconSize={24}
        />
        <span className={styles.previewPanePlatform} data-platform={preview.platform}>
          <PlatformBrandIcon platform={preview.platform} size={13} />
          {platformLabel(preview.platform)}
        </span>
      </div>

      <div className={styles.previewPaneIdentity}>
        <h3 title={preview.title}>{preview.title}</h3>
        {(preview.author || displayDate) && (
          <div className={styles.previewPaneMeta}>
            {preview.author && <span>{preview.author}</span>}
            {displayDate && <time dateTime={preview.date}>{displayDate}</time>}
          </div>
        )}
      </div>

      {preview.caption && (
        <p className={styles.previewPaneCaption} aria-label="发布文案">{preview.caption}</p>
      )}

      {preview.tags.length > 0 && (
        <div className={styles.previewPaneTags} aria-label="标签">
          {preview.tags.slice(0, 6).map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}

      <div className={styles.previewPaneStatuses} aria-label="处理状态">
        <span data-ready={preview.transcriptReady}>
          <Captions size={15} />
          <b>文案</b>
          {preview.transcriptLabel}
          {preview.transcriptChars > 0 && (
            <small>{preview.transcriptChars.toLocaleString('zh-CN')} 字</small>
          )}
        </span>
        <span data-ready={preview.aiInitialized}>
          <NotebookPen size={15} />
          <b>摘要</b>
          {preview.aiInitialized ? '已就绪' : '尚未生成'}
        </span>
      </div>

      <div
        className={styles.previewPaneActions}
        data-has-ai={canAskAi}
        aria-label={`${preview.title}的可用操作`}
      >
        <Link href={preview.detailHref} className={styles.previewPanePrimaryAction}>
          打开完整资料
          <ArrowUpRight size={15} />
        </Link>
        {canAskAi && (
          <Link href={`/agent?source_ids=${encodeURIComponent(preview.noteId)}`}>
            <MessageSquareText size={15} />
            向 AI 提问
          </Link>
        )}
        {hasMoreActions && (
          <details
            key={`${preview.noteId}:${preview.sourceUrl}`}
            className={styles.previewPaneMore}
          >
            <summary aria-label="更多资料操作" title="更多操作">
              <MoreHorizontal size={16} aria-hidden="true" />
            </summary>
            <div>
              {preview.aiInitialized && preview.noteId && (
                <Link href={`/notes?id=${encodeURIComponent(preview.noteId)}`}>
                  <NotebookPen size={15} />
                  查看摘要
                </Link>
              )}
              {preview.sourceUrl && (
                <a href={preview.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={15} />
                  查看来源
                </a>
              )}
            </div>
          </details>
        )}
      </div>
    </aside>
  );
}
