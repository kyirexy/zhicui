'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowUpRight,
  BookOpenText,
  Books,
  CalendarCheck,
  CookingPot,
  FileText,
  LightbulbFilament,
  ShoppingBagOpen,
  VideoCamera,
} from '@phosphor-icons/react';
import {
  CARD_TYPE_CONFIG,
  type CardType,
  type Note,
} from '@/lib/types';

function TypeIcon({ type }: { type: CardType }) {
  const props = { size: 18, weight: 'duotone' as const, 'aria-hidden': true };
  if (type === 'recipe') return <CookingPot {...props} />;
  if (type === 'insight') return <LightbulbFilament {...props} />;
  if (type === 'history') return <Books {...props} />;
  if (type === 'product') return <ShoppingBagOpen {...props} />;
  if (type === 'plan') return <CalendarCheck {...props} />;
  return <FileText {...props} />;
}

export type KnowledgeViewMode = 'list' | 'grid';

interface LibraryNoteCardProps {
  note: Note;
  viewMode?: KnowledgeViewMode;
}

function formatDate(value?: string): string {
  if (!value) return '日期未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '日期未知';
  return date.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

function formatTranscriptSize(value?: number): string | null {
  const count = Math.max(0, value ?? 0);
  if (count < 1) return null;
  if (count >= 10_000) return `${Math.round(count / 1000)}k 字`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 字`;
  return `${count.toLocaleString('zh-CN')} 字`;
}

function readableSummary(note: Note): string {
  const candidate = note.excerpt?.trim() || note.conclusion?.trim() || '';
  if (
    /litellm\.|deepseekexception|系统提示：|traceback|internal server error/i.test(candidate)
  ) {
    return '完整文案已经保留，可以打开详情继续整理这条资料。';
  }
  return candidate || '这条资料已经整理成知识卡片，可以打开查看完整内容。';
}

function platformLabel(platform?: string, sourceKind?: string): string {
  const source = `${platform || ''} ${sourceKind || ''}`.toLowerCase();
  if (source.includes('douyin')) return '抖音';
  if (source.includes('bilibili')) return '哔哩哔哩';
  if (source.includes('wechat') || source.includes('weixin')) return '公众号';
  if (source.includes('xiaohongshu') || source.includes('xhs')) return '小红书';
  return '视频资料';
}

export default function LibraryNoteCard({
  note,
  viewMode = 'list',
}: LibraryNoteCardProps) {
  const [coverFailed, setCoverFailed] = useState(false);
  const typeMeta = CARD_TYPE_CONFIG[note.card_type] ?? CARD_TYPE_CONFIG.general;
  const coverUrl = note.cover_url?.trim();
  const showCover = Boolean(coverUrl && !coverFailed);
  const sourceLabel = platformLabel(note.platform, note.source_kind);
  const createdAt = formatDate(note.source_recorded_at || note.created_at);
  const summary = readableSummary(note);
  const transcriptSize = formatTranscriptSize(note.transcript_chars);

  return (
    <article
      className={`knowledge-workspace-item knowledge-workspace-item--${viewMode}`}
      data-card-type={note.card_type}
      data-view={viewMode}
    >
      <Link
        href={`/notes?id=${note.id}`}
        className="knowledge-workspace-item__link knowledge-workspace-touch-target"
        aria-label={`打开知识卡片：${note.title}`}
      >
        <div className="knowledge-workspace-item__cover">
          {showCover ? (
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <span className="knowledge-workspace-item__cover-fallback" aria-hidden="true">
              <VideoCamera size={26} weight="duotone" />
            </span>
          )}
          <span className="knowledge-workspace-item__source-badge">{sourceLabel}</span>
        </div>

        <div className="knowledge-workspace-item__body">
          <header className="knowledge-workspace-item__meta">
            <span className="knowledge-workspace-item__type">
              <TypeIcon type={note.card_type} />
              {typeMeta.label}
            </span>
            {typeof note.section_count === 'number' && note.section_count > 0 && (
              <span className="knowledge-workspace-item__sections">
                <BookOpenText size={14} weight="duotone" aria-hidden />
                {note.section_count} 个要点
              </span>
            )}
          </header>

          <h2>{note.title}</h2>
          <p className="knowledge-workspace-item__summary">{summary}</p>

          <footer className="knowledge-workspace-item__footer">
            <span className="knowledge-workspace-item__source">
              {note.author_name?.trim() || sourceLabel}
            </span>
            {transcriptSize && (
              <span className="knowledge-workspace-item__size">{transcriptSize}</span>
            )}
            <time dateTime={note.created_at || undefined}>{createdAt}</time>
            <span className="knowledge-workspace-item__open" aria-hidden="true">
              查看
              <ArrowUpRight size={15} weight="bold" aria-hidden />
            </span>
          </footer>
        </div>
      </Link>
    </article>
  );
}
