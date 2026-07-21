'use client';

import type { NoteDetail } from '@/lib/types';

function typeAccent(cardType: string): string {
  const map: Record<string, string> = {
    recipe: 'orange',
    insight: 'emerald',
    history: 'amber',
    product: 'rose',
    plan: 'indigo',
  };
  return map[cardType] || 'slate';
}

function typeLabel(cardType: string): string {
  const map: Record<string, string> = {
    recipe: '🍳 食谱',
    insight: '💡 洞察',
    history: '📚 历史',
    product: '🛍️ 评测',
    plan: '📋 计划',
  };
  return map[cardType] || '📝 笔记';
}

function formatCount(n: number | string | null | undefined): string {
  const num = typeof n === 'string' ? parseInt(n, 10) : (n ?? 0);
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return `${num}`;
}

interface NotesHeroProps {
  note: NoteDetail;
  transcriptRef: React.RefObject<HTMLDivElement | null>;
}

export default function NotesHero({ note, transcriptRef }: NotesHeroProps) {
  const accent = typeAccent(note.card_type || 'general');
  const transcriptChars = note.transcript_raw?.length ?? 0;

  const scrollToTranscript = () => {
    transcriptRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div
      className="glass-card mb-8"
      style={{
        borderTop: `3px solid var(--accent-${accent})`,
      }}
    >
      <div className="p-6 md:p-8">
        {/* Header row: eyebrow + top actions */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-5">
          <span
            className="eyebrow"
            style={{
              background: `var(--accent-${accent})/0.12`,
              color: `var(--accent-${accent})`,
            }}
          >
            {typeLabel(note.card_type)}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            {note.card_type === 'plan' && note.plan_id && (
              <a
                href={`/plans?id=${note.plan_id}`}
                className="glass-input text-xs font-medium px-3 py-2.5 rounded-lg inline-flex items-center gap-1.5 hover:bg-white/10 transition-colors min-h-[44px]"
              >
                📋 查看计划
              </a>
            )}
            {transcriptChars > 0 && (
              <button
                onClick={scrollToTranscript}
                className="glass-input text-xs font-medium px-3 py-2.5 rounded-lg inline-flex items-center gap-1.5 hover:bg-white/10 transition-colors cursor-pointer min-h-[44px]"
              >
                📄 原文案
              </button>
            )}
          </div>
        </div>

        {/* Title */}
        <h1 className="text-2xl md:text-3xl font-bold leading-tight text-balance text-foreground mb-3">
          {note.title}
        </h1>

        {/* Meta row */}
        <div className="flex items-center gap-4 flex-wrap text-xs text-foreground-muted">
          {note.created_at && (
            <span>{new Date(note.created_at).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
          )}
          {transcriptChars > 0 && (
            <span>{formatCount(transcriptChars)} 字</span>
          )}
          {typeof note.pitfall_rating === 'number' && note.pitfall_rating > 0 && (
            <span className="text-accent-amber">
              {'★'.repeat(note.pitfall_rating)}{'☆'.repeat(5 - note.pitfall_rating)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
