'use client';

import { useRef, type CSSProperties } from 'react';
import { ArrowSquareOut, Quotes, Sparkle } from '@phosphor-icons/react';
import { CARD_TYPE_CONFIG, type StyleCardProps } from '@/lib/types';
import { shouldAnimate, useGsapAnimation } from '@/lib/hooks/useGsapAnimation';
import CardSection from '../CardSection';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

export default function AuroraCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLElement | null)[]>([]);

  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;
    if (rootRef.current) {
      gsap.from(rootRef.current, { opacity: 0, y: 26, scale: 0.985, duration: 0.75, ease: 'power3.out' });
    }
    gsap.from(sectionRefs.current.filter(Boolean), {
      opacity: 0,
      y: 18,
      stagger: 0.09,
      delay: 0.35,
      duration: 0.55,
      ease: 'power2.out',
    });
  }, [cardData.id, cardData.title]);

  return (
    <div ref={rootRef} className="aurora-card" style={{ '--aurora-accent': config.accent } as CSSProperties}>
      <article ref={cardRef as React.RefObject<HTMLElement>} className="aurora-shell">
        <span className="aurora-orb aurora-orb--one" aria-hidden />
        <span className="aurora-orb aurora-orb--two" aria-hidden />
        <span className="aurora-grain" aria-hidden />

        <div className="aurora-content">
          <header className="aurora-header">
            <span className="aurora-kicker"><Sparkle size={15} weight="fill" /> {config.label} · AURORA</span>
            <h2>{cardData.title}</h2>
            {(cardData.hero_quote || cardData.key_insight) && (
              <blockquote>
                <Quotes size={24} weight="duotone" aria-hidden />
                <span>{cardData.hero_quote || cardData.key_insight}</span>
              </blockquote>
            )}
          </header>

          {density !== 'low' && cardData.sections.length > 0 && (
            <div className="aurora-grid">
              {cardData.sections.map((section, index) => (
                <section
                  key={`${section.title}-${index}`}
                  ref={(element) => { sectionRefs.current[index] = element; }}
                  className="aurora-panel"
                >
                  <span className="aurora-panel__index">0{index + 1}</span>
                  <CardSection section={section} index={index} accentColor={config.accent} />
                </section>
              ))}
            </div>
          )}

          {cardData.conclusion && (
            <aside className="aurora-conclusion">
              <span>带走这一点</span>
              <p>{cardData.conclusion}</p>
            </aside>
          )}

          <footer className="aurora-footer">
            <PitfallRating rating={cardData.pitfall_rating} size="sm" />
            {cardData.source_url && (
              <a href={cardData.source_url} target="_blank" rel="noopener noreferrer">
                原始内容 <ArrowSquareOut size={14} weight="bold" aria-hidden />
              </a>
            )}
          </footer>
        </div>
      </article>

      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6"><TranscriptViewer transcript={cardData.transcript_raw} /></div>
      )}
    </div>
  );
}
