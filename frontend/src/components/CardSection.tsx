'use client';

import { CardSection as CardSectionType } from '@/lib/types';

interface CardSectionProps {
  section: CardSectionType;
  index: number;
  accentColor?: string;
}

function formatContent(content: string): React.ReactNode {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listType: 'ol' | 'ul' | null = null;

  const flushList = () => {
    if (listItems.length > 0) {
      const ListTag = listType === 'ol' ? 'ol' : 'ul';
      elements.push(
        <ListTag key={`list-${elements.length}`} className="space-y-2 my-3">
          {listItems.map((item, i) => (
            <li
              key={i}
              className="text-foreground-secondary leading-relaxed text-sm"
            >
              {formatInline(item)}
            </li>
          ))}
        </ListTag>,
      );
      listItems = [];
      listType = null;
    }
  };

  const formatInline = (text: string): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return (
          <strong key={i} className="text-foreground font-semibold">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return part;
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList();
      continue;
    }

    // Check for numbered list: 1️⃣ or 1. or 1)
    const numberedMatch = trimmed.match(/^(?:[1-9]️⃣\s*|(\d+)[.)]\s*)(.*)/);
    if (numberedMatch) {
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      listItems.push(numberedMatch[2] || trimmed.replace(/^[1-9]️⃣\s*/, ''));
      continue;
    }

    // Check for bullet points: - or *
    const bulletMatch = trimmed.match(/^[•\-*]\s+(.*)/);
    if (bulletMatch) {
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      listItems.push(bulletMatch[1]);
      continue;
    }

    flushList();
    elements.push(
      <p
        key={`p-${elements.length}`}
        className="text-foreground-secondary leading-relaxed text-sm mb-3 last:mb-0 text-pretty"
      >
        {formatInline(trimmed)}
      </p>,
    );
  }

  flushList();
  return <>{elements}</>;
}

export default function CardSection({
  section,
  index,
  accentColor = 'var(--accent-brand)',
}: CardSectionProps) {
  const emoji = section.emoji || '📌';

  return (
    <div
      className="animate-fade-in"
      style={{
        animationDelay: `${index * 80}ms`,
        animationFillMode: 'both',
      }}
    >
      <h3 className="text-sm md:text-base font-semibold text-foreground mb-2.5 md:mb-3 flex items-center gap-2.5">
        <span
          className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-sm flex-shrink-0 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:scale-110"
          style={{
            background: `${accentColor}12`,
            border: `1px solid ${accentColor}10`,
          }}
        >
          {emoji}
        </span>
        <span className="text-balance">{section.title}</span>
      </h3>
      <div className="card-content pl-1 md:pl-1">
        {formatContent(section.content)}
      </div>
    </div>
  );
}
