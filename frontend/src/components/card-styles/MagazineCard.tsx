'use client';

import { useRef } from 'react';
import { type StyleCardProps, CARD_TYPE_CONFIG } from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

/**
 * MagazineCard — 翻页杂志体验。
 *
 * GSAP 驱动的：
 * - 左右两栏从两侧滑入（staggered slide-in）
 * - 引言大引号弹性出现（back ease）
 * - 分区编号圆形描边动画
 */
export default function MagazineCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const quoteGlyphRef = useRef<HTMLSpanElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);

  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;

    // 1. Quote glyph — elastic scale-in
    if (quoteGlyphRef.current) {
      gsap.from(quoteGlyphRef.current, {
        scale: 0,
        rotation: -20,
        duration: 0.8,
        delay: 0.15,
        ease: 'back.out(1.7)',
      });
    }

    // 2. Magazine columns — slide in from opposite sides
    if (columnsRef.current) {
      const children = columnsRef.current.children;
      gsap.from(children[0] || [], {
        opacity: 0,
        x: -30,
        duration: 0.6,
        delay: 0.3,
        ease: 'power3.out',
      });
      if (children[1]) {
        gsap.from(children[1], {
          opacity: 0,
          x: 30,
          duration: 0.6,
          delay: 0.4,
          ease: 'power3.out',
        });
      }
    }

    // 3. Section number circles — stroke-dash offset draw
    sectionRefs.current.filter(Boolean).forEach((el, i) => {
      if (!el) return;
      const numCircle = el.querySelector('.section-num-circle') as HTMLElement | null;
      if (numCircle) {
        gsap.from(numCircle, {
          scale: 0,
          duration: 0.4,
          delay: 0.5 + i * 0.1,
          ease: 'back.out(2)',
        });
      }
    });
  }, [config.accent]);

  return (
    <div className="magazine-card" ref={cardRef as React.RefObject<HTMLDivElement>}>
      <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
        {/* Wide accent bar */}
        <div
          className="h-1.5 w-full"
          style={{ background: `linear-gradient(90deg, ${config.accent}, ${config.accent}60)` }}
        />

        <div className="px-6 pt-6 pb-0 md:px-8 md:pt-8">
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: config.accent }}
          >
            {config.label} · {config.emoji}
          </span>
          <h2 className="mt-2 text-xl md:text-2xl font-bold text-foreground leading-tight text-balance max-w-3xl">
            {cardData.title}
          </h2>
          <div className="mt-4 pb-5 border-b border-card-border">
            <PitfallRating rating={cardData.pitfall_rating} size="sm" />
          </div>
        </div>

        {/* Conclusion — large pull-quote with animated " glyph */}
        {cardData.conclusion && (
          <div className="px-6 py-5 md:px-8 md:py-6 border-b border-card-border">
            <div className="space-y-3">
              {cardData.conclusion.split('\n').filter(Boolean).map((line, i) => (
                <p
                  key={i}
                  className="text-base md:text-lg text-foreground leading-relaxed font-medium text-pretty italic"
                  style={{ color: i === 0 ? config.accent : undefined }}
                >
                  {i === 0 && (
                    <span
                      ref={quoteGlyphRef}
                      className="inline-block text-5xl md:text-6xl font-serif leading-none mr-1 align-middle"
                      style={{ color: config.accent, marginTop: '-0.15em' }}
                    >
                      "
                    </span>
                  )}
                  {line}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Sections — two-column with side slide-in */}
        {density !== 'low' && cardData.sections.length > 0 && (
          <div className="px-6 py-5 md:px-8 md:py-6 border-b border-card-border">
            <div ref={columnsRef} className="magazine-columns grid grid-cols-1 md:grid-cols-2 gap-5 md:gap-6">
              {cardData.sections.map((section, i) => (
                <div
                  key={i}
                  ref={(el) => { sectionRefs.current[i] = el; }}
                  className="magazine-section"
                >
                  <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-2">
                    <span
                      className="section-num-circle inline-flex items-center justify-center w-6 h-6 rounded text-xs"
                      style={{ background: `${config.accent}15` }}
                    >
                      {section.emoji || '📌'}
                    </span>
                    {section.title}
                  </h3>
                  <p className="text-sm text-foreground-secondary leading-relaxed whitespace-pre-line text-pretty">
                    {section.content.replace(/\*\*(.+?)\*\*/g, '$1')}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Source */}
        {cardData.source_url && (
          <div className="px-6 py-3 md:px-8 md:py-4 bg-card-bg">
            <a
              href={cardData.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-foreground-muted hover:text-foreground-secondary transition-colors underline underline-offset-2"
            >
              查看原始视频
            </a>
          </div>
        )}
      </div>

      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6">
          <TranscriptViewer transcript={cardData.transcript_raw} />
        </div>
      )}
    </div>
  );
}
