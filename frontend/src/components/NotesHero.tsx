'use client';

import {
  ArrowUpRight,
  CalendarBlank,
  FileText,
  ListChecks,
  PlayCircle,
} from '@phosphor-icons/react';
import type { NoteDetail } from '@/lib/types';

const TYPE_LABELS: Record<string, string> = {
  recipe: '食谱',
  insight: '洞察',
  history: '科普',
  product: '好物',
  plan: '计划',
  general: '通用知识',
};

function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万字`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} 千字`;
  return `${value} 字`;
}

interface NotesHeroProps {
  note: NoteDetail;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}

export default function NotesHero({ note, transcriptRef }: NotesHeroProps) {
  const transcriptChars = note.transcript_raw?.length ?? note.transcript_chars ?? 0;
  const sourceLabel = note.author_name || note.platform || '视频资料';
  const createdAt = note.created_at
    ? new Date(note.created_at).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null;

  return (
    <header className="knowledge-detail-header">
      <div className="knowledge-detail-header__source">
        <span className="knowledge-detail-header__source-icon" aria-hidden="true">
          <PlayCircle size={20} weight="duotone" />
        </span>
        <span>
          <small>{TYPE_LABELS[note.card_type] || TYPE_LABELS.general}</small>
          <strong>{sourceLabel}</strong>
        </span>
      </div>

      <div className="knowledge-detail-header__copy">
        <h1>{note.title}</h1>
        <div className="knowledge-detail-header__meta">
          {createdAt && (
            <span>
              <CalendarBlank size={15} weight="duotone" aria-hidden="true" />
              {createdAt}
            </span>
          )}
          {transcriptChars > 0 && (
            <span>
              <FileText size={15} weight="duotone" aria-hidden="true" />
              {formatCount(transcriptChars)}
            </span>
          )}
          {note.ai_initialized && <span className="is-ready">已提炼</span>}
        </div>
      </div>

      <div className="knowledge-detail-header__actions">
        {transcriptChars > 0 && (
          <button
            type="button"
            onClick={() => transcriptRef.current?.scrollIntoView({ behavior: 'smooth' })}
          >
            <FileText size={17} weight="duotone" aria-hidden="true" />
            完整内容
          </button>
        )}
        {note.card_type === 'plan' && note.plan_id && (
          <a href={`/plans?id=${note.plan_id}`}>
            <ListChecks size={17} weight="duotone" aria-hidden="true" />
            查看计划
            <ArrowUpRight size={15} weight="bold" aria-hidden="true" />
          </a>
        )}
      </div>
    </header>
  );
}
