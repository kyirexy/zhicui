'use client';

import { useRef, type CSSProperties } from 'react';
import { ArrowSquareOut, BookmarkSimple, Quotes } from '@phosphor-icons/react';
import { CARD_TYPE_CONFIG, type StyleCardProps } from '@/lib/types';
import { shouldAnimate, useGsapAnimation } from '@/lib/hooks/useGsapAnimation';
import CardSection from '../CardSection';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

export default function PaperCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;
    if (rootRef.current) {
      gsap.from(rootRef.current, { opacity: 0, y: 20, rotation: -0.45, duration: 0.7, ease: 'power2.out' });
    }
    gsap.from(sectionRefs.current.filter(Boolean), {
      opacity: 0,
      y: 14,
      stagger: 0.1,
      delay: 0.3,
      duration: 0.5,
      ease: 'power1.out',
    });
  }, [cardData.id, cardData.title]);

  return (
    <div ref={rootRef} className="paper-card" style={{ '--paper-accent': config.accent } as CSSProperties}>
      <article ref={cardRef as React.RefObject<HTMLElement>} className="paper-sheet">
        <span className="paper-sheet__grain" aria-hidden />
        <header className="paper-header">
          <div className="paper-folio">知萃札记 · {config.label}</div>
          <h2>{cardData.title}</h2>
          {(cardData.hero_quote || cardData.key_insight) && (
            <blockquote>
              <Quotes size={23} weight="duotone" aria-hidden />
              <span>{cardData.hero_quote || cardData.key_insight}</span>
            </blockquote>
          )}
        </header>

        {density !== 'low' && cardData.sections.length > 0 && (
          <div className="paper-columns">
            {cardData.sections.map((section, index) => (
              <section
                key={`${section.title}-${index}`}
                ref={(element) => { sectionRefs.current[index] = element; }}
                className="paper-entry"
              >
                <span className="paper-entry__number">{String(index + 1).padStart(2, '0')}</span>
                <CardSection section={section} index={index} accentColor={config.accent} />
              </section>
            ))}
          </div>
        )}

        {cardData.conclusion && (
          <aside className="paper-note">
            <BookmarkSimple size={18} weight="fill" aria-hidden />
            <div>
              <span>页边结论</span>
              <p>{cardData.conclusion}</p>
            </div>
          </aside>
        )}

        <footer className="paper-footer">
          <PitfallRating rating={cardData.pitfall_rating} size="sm" />
          {cardData.source_url && (
            <a href={cardData.source_url} target="_blank" rel="noopener noreferrer">
              查看原始内容 <ArrowSquareOut size={13} weight="bold" aria-hidden />
            </a>
          )}
        </footer>
      </article>

      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6"><TranscriptViewer transcript={cardData.transcript_raw} /></div>
      )}
    </div>
  );
}
