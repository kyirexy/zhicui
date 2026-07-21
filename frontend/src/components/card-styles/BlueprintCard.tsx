'use client';

import { useRef, type CSSProperties } from 'react';
import { ArrowSquareOut, Circuitry, Crosshair } from '@phosphor-icons/react';
import { CARD_TYPE_CONFIG, type StyleCardProps } from '@/lib/types';
import { shouldAnimate, useGsapAnimation } from '@/lib/hooks/useGsapAnimation';
import CardSection from '../CardSection';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

export default function BlueprintCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const rootRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<(HTMLElement | null)[]>([]);

  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;
    if (rootRef.current) {
      gsap.from(rootRef.current, { opacity: 0, clipPath: 'inset(0 100% 0 0)', duration: 0.8, ease: 'power3.inOut' });
    }
    gsap.from(nodeRefs.current.filter(Boolean), {
      opacity: 0,
      x: -18,
      stagger: 0.08,
      delay: 0.5,
      duration: 0.45,
      ease: 'power2.out',
    });
  }, [cardData.id, cardData.title]);

  return (
    <div ref={rootRef} className="blueprint-card" style={{ '--blueprint-accent': config.accent } as CSSProperties}>
      <article ref={cardRef as React.RefObject<HTMLElement>} className="blueprint-shell">
        <span className="blueprint-scan" aria-hidden />
        <header className="blueprint-header">
          <div className="blueprint-code">
            <Circuitry size={17} weight="duotone" aria-hidden />
            ZHICUI / {cardData.card_type.toUpperCase()} / {String(cardData.sections.length).padStart(2, '0')}
          </div>
          <h2>{cardData.title}</h2>
          {cardData.key_insight && (
            <p className="blueprint-insight"><Crosshair size={16} weight="duotone" /> {cardData.key_insight}</p>
          )}
        </header>

        {density !== 'low' && cardData.sections.length > 0 && (
          <div className="blueprint-flow">
            {cardData.sections.map((section, index) => (
              <section
                key={`${section.title}-${index}`}
                ref={(element) => { nodeRefs.current[index] = element; }}
                className="blueprint-node"
              >
                <span className="blueprint-node__number">{String(index + 1).padStart(2, '0')}</span>
                <span className="blueprint-node__line" aria-hidden />
                <div className="blueprint-node__body">
                  <CardSection section={section} index={index} accentColor={config.accent} />
                </div>
              </section>
            ))}
          </div>
        )}

        {cardData.conclusion && (
          <div className="blueprint-output">
            <span>OUTPUT</span>
            <p>{cardData.conclusion}</p>
          </div>
        )}

        <footer className="blueprint-footer">
          <PitfallRating rating={cardData.pitfall_rating} size="sm" />
          {cardData.source_url && (
            <a href={cardData.source_url} target="_blank" rel="noopener noreferrer">
              SOURCE <ArrowSquareOut size={13} weight="bold" aria-hidden />
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
