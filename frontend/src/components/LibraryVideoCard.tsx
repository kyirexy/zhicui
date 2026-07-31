'use client';

import Link from 'next/link';
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  CircleMinus,
  EyeOff,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Square,
  Sparkles,
  Trash2,
} from 'lucide-react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
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
  extractState?: LibraryExtractState;
  extractError?: string;
  deleting?: boolean;
  removing?: boolean;
  onToggle: (awemeId: string) => void;
  onDelete: (item: DouyinLibraryItem) => void;
  onRemove: (item: DouyinLibraryItem) => void;
  onHidePermanently: (item: DouyinLibraryItem) => void;
}

function formatCount(value: number): string {
  if (value < 1000) return `${value} 字`;
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k 字`;
}

export default function LibraryVideoCard({
  item,
  selected,
  extractState = 'idle',
  extractError,
  deleting = false,
  removing = false,
  onToggle,
  onDelete,
  onRemove,
  onHidePermanently,
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
  const copyBadgeLabel = extractState === 'queued'
    ? '等待提取'
    : ['extracting', 'transcribing'].includes(extractState)
      ? '正在提取'
      : extractState === 'analyzing'
        ? '正在分析'
        : isExtracted
          ? formatCount(item.transcript_chars)
          : '待提文案';

  return (
    <article
      className={`library-video-card ${selected ? 'is-selected' : ''} ${visualState}`}
      data-extract-state={extractState}
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
          fallbackClassName="library-video-cover-fallback"
          fallbackLabel="封面暂不可用"
          iconSize={24}
        />
        <button
          type="button"
          className="library-select-button"
          onClick={() => onToggle(item.aweme_id)}
          aria-label={selected ? `取消选择 ${item.title}` : `选择 ${item.title}`}
          aria-pressed={selected}
        >
          {selected ? <Check size={16} /> : <Square size={15} />}
        </button>
        {item.media_url && (
          <a
            href={item.media_url}
            target="_blank"
            rel="noreferrer"
            className="library-play-button"
            aria-label={`播放 ${item.title}`}
          >
            <Play size={14} fill="currentColor" />
          </a>
        )}
        <span
          className={`library-copy-badge ${isExtracted ? 'is-ready' : ''} ${isWorking ? 'is-working' : ''}`}
          aria-label={`文案状态：${copyBadgeLabel}`}
        >
          {isWorking
            ? <LoaderCircle size={12} className="animate-spin" />
            : isExtracted
              ? <CheckCircle2 size={12} />
              : <FileText size={12} />}
          {copyBadgeLabel}
        </span>
      </div>

      <div className="library-video-body">
        <div className="library-video-meta">
          <span>{item.author_name || '未知作者'}</span>
          <span aria-hidden="true">·</span>
          <time>{item.date || item.recorded_at?.slice(0, 10) || '已收藏'}</time>
        </div>
        <h3 title={item.title}>
          {item.title}
        </h3>
        {item.tags.length > 0 && (
          <div className="library-video-tags" aria-label="视频标签">
            {item.tags.slice(0, 2).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}

        {extractState === 'error' && extractError && (
          <p className="library-extract-error" title={extractError}>{extractError}</p>
        )}

        <div className="library-video-actions">
          {!isExtracted ? (
            <span className={`library-card-hint ${selected ? 'is-selected' : ''}`}>
              {isWorking ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Check size={13} />
              )}
              {extractState === 'queued'
                ? '等待处理'
                : extractState === 'transcribing'
                  ? '正在提取文案'
                  : extractState === 'analyzing'
                    ? '正在生成知识卡'
                    : extractState === 'extracting'
                  ? '正在生成文案'
                  : !item.can_extract
                    ? '没有可提取视频'
                    : selected
                      ? '已加入处理'
                      : '同步后自动提取'}
            </span>
          ) : !item.ai_initialized ? (
            <span className={`library-card-hint ${selected ? 'is-selected' : ''}`}>
              {isWorking ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} />
              )}
              {extractState === 'analyzing'
                ? '正在生成 AI 总结'
                : '文案已就绪 · 可直接问 AI'}
            </span>
          ) : null}
          <details className="library-card-menu">
            <summary aria-label={`更多管理 ${item.title}`}>
              <MoreHorizontal size={15} />
            </summary>
            <div>
              <button
                type="button"
                className="is-temporary"
                disabled={removing}
                onClick={() => onRemove(item)}
              >
                {removing ? (
                  <LoaderCircle size={13} className="animate-spin" />
                ) : (
                  <CircleMinus size={13} />
                )}
                移出资料库
              </button>
              <p>永久隐藏后，同步也不会再次显示；可以在“已永久隐藏”中恢复。</p>
              <button
                type="button"
                className="is-permanent"
                disabled={removing}
                onClick={() => onHidePermanently(item)}
              >
                <EyeOff size={13} />
                永久隐藏
              </button>
              {isExtracted && item.extracted_note_id && selected ? (
                <>
                  <p className="library-card-menu-divider">
                    只删除知萃中的文案、卡片和关联计划，原视频会保留。
                  </p>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => onDelete(item)}
                >
                  {deleting ? (
                    <LoaderCircle size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  确认删除
                </button>
                </>
              ) : null}
            </div>
          </details>
        </div>
        <span className="library-detail-hint" aria-hidden="true">
          打开详情
          <ArrowUpRight size={12} />
        </span>
      </div>
    </article>
  );
}
