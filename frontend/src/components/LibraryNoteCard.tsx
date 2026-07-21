'use client';

import Link from 'next/link';
import type { CSSProperties } from 'react';
import {
  ArrowUpRight,
  BookOpenText,
  Books,
  CalendarCheck,
  CookingPot,
  FileText,
  LightbulbFilament,
  ShoppingBagOpen,
} from '@phosphor-icons/react';
import {
  CARD_STYLE_CONFIG,
  CARD_TYPE_CONFIG,
  type CardStyle,
  type CardType,
  type Note,
} from '@/lib/types';
import StylePreview from './StylePreview';

function TypeIcon({ type }: { type: CardType }) {
  const props = { size: 18, weight: 'duotone' as const, 'aria-hidden': true };
  if (type === 'recipe') return <CookingPot {...props} />;
  if (type === 'insight') return <LightbulbFilament {...props} />;
  if (type === 'history') return <Books {...props} />;
  if (type === 'product') return <ShoppingBagOpen {...props} />;
  if (type === 'plan') return <CalendarCheck {...props} />;
  return <FileText {...props} />;
}

interface LibraryNoteCardProps {
  note: Note;
  style: CardStyle;
  featured?: boolean;
}

export default function LibraryNoteCard({
  note,
  style,
  featured = false,
}: LibraryNoteCardProps) {
  const typeMeta = CARD_TYPE_CONFIG[note.card_type] ?? CARD_TYPE_CONFIG.general;
  const styleMeta = CARD_STYLE_CONFIG[style];
  const createdAt = note.created_at
    ? new Date(note.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    : '日期未知';

  return (
    <article
      className={`library-note ${featured ? 'is-featured' : ''}`}
      style={{ '--library-note-accent': typeMeta.accent } as CSSProperties}
    >
      <Link href={`/notes?id=${note.id}`} className="library-note__link">
        <div className="library-note__visual" aria-hidden>
          <StylePreview style={style} />
          <span className="library-note__visual-wash" />
          <span className="library-note__type-icon"><TypeIcon type={note.card_type} /></span>
          <span className="library-note__style-label">{styleMeta.label}主题</span>
        </div>

        <div className="library-note__content">
          <header className="library-note__meta">
            <span className="library-note__type">
              <TypeIcon type={note.card_type} />
              {typeMeta.label}
            </span>
            {typeof note.section_count === 'number' && note.section_count > 0 && (
              <span className="library-note__sections">
                <BookOpenText size={14} weight="duotone" aria-hidden />
                {note.section_count} 个要点
              </span>
            )}
          </header>

          <h2>{note.title}</h2>
          {note.excerpt && <p>{note.excerpt}</p>}

          <footer>
            <time dateTime={note.created_at || undefined}>{createdAt}</time>
            <span>
              打开卡片
              <ArrowUpRight size={15} weight="bold" aria-hidden />
            </span>
          </footer>
        </div>
      </Link>
    </article>
  );
}
