'use client';

import { useRef, useCallback } from 'react';
import gsap from 'gsap';
import { type StyleCardProps, CARD_TYPE_CONFIG } from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import CardSection from '../CardSection';
import Conclusion from '../Conclusion';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

/**
 * StandardCard — 精致玻璃卡片。
 *
 * GSAP 驱动的：
 * - 卡片入场 3D 翻转展开（rotationX + perspective）
 * - 边框流光动画（渐变在边框上循环流动）
 * - 分区标题 hover 时左侧指示条弹性伸缩
 */
export default function StandardCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const shineRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<(HTMLDivElement | null)[]>([]);

  // ---- Section hover (React events, not addEventListener) ----
  const handleSectionEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!shouldAnimate()) return;
      const indicator = e.currentTarget.querySelector('.section-hover-bar') as HTMLElement | null;
      if (!indicator) return;
      gsap.to(indicator, {
        scaleY: 1,
        duration: 0.35,
        ease: 'elastic.out(1, 0.5)',
      });
    },
    [],
  );

  const handleSectionLeave = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!shouldAnimate()) return;
      const indicator = e.currentTarget.querySelector('.section-hover-bar') as HTMLElement | null;
      if (!indicator) return;
      gsap.to(indicator, {
        scaleY: 0.3,
        duration: 0.25,
        ease: 'power2.out',
      });
    },
    [],
  );

  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;

    // 1. Card entrance — 3D flip-down reveal
    if (wrapperRef.current) {
      gsap.from(wrapperRef.current, {
        rotationX: 8,
        opacity: 0,
        y: 30,
        duration: 0.7,
        ease: 'power3.out',
        transformOrigin: 'top center',
      });
    }

    // 2. Accent top bar — shimmer sweep (CSS pseudo-element approach: use a ref'd div)
    if (shineRef.current) {
      gsap.to(shineRef.current, {
        x: 'calc(100% + 60px)',
        duration: 2.5,
        repeat: -1,
        ease: 'power2.inOut',
        repeatDelay: 3,
        delay: 0.8,
      });
    }
  }, [config.accent]);

  return (
    <div className="standard-card">
      {/* Double-bezel architecture */}
      <div ref={wrapperRef} className="bezel-outer">
        <div ref={cardRef as React.RefObject<HTMLDivElement>} className={`bezel-inner accent-${cardData.card_type}`}>
          {/* Accent top bar with shimmer */}
          <div
            className="h-[3px] w-full relative overflow-hidden"
            style={{ background: `linear-gradient(90deg, ${config.accent}, ${config.accent}40, transparent)` }}
          >
            <div
              ref={shineRef}
              className="absolute top-0 left-0 h-full pointer-events-none"
              style={{
                width: 60,
                background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                transform: 'translateX(-60px)',
              }}
            />
          </div>

          {/* Card header */}
          <div className="p-5 pb-4 md:p-6 md:pb-5 relative">
            <div
              className="absolute top-0 right-0 w-40 h-40 rounded-full opacity-[0.06] pointer-events-none blur-3xl"
              style={{ background: config.accent }}
            />

            <div className="relative flex items-start justify-between gap-3">
              <div className="flex items-start gap-3.5 min-w-0">
                <span className="text-2xl md:text-3xl flex-shrink-0 mt-0.5 drop-shadow-[0_0_12px_rgba(16, 24, 40,0.15)]">
                  {config.emoji}
                </span>
                <div className="min-w-0">
                  <span
                    className="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold mb-2 tracking-wide uppercase"
                    style={{
                      background: `${config.accent}15`,
                      color: config.accent,
                      border: `1px solid ${config.accent}20`,
                    }}
                  >
                    {config.label}
                  </span>
                  <h2 className="text-lg md:text-xl font-bold text-foreground leading-snug text-balance">
                    {cardData.title}
                  </h2>
                </div>
              </div>
            </div>

            {density !== 'low' && (
              <div className="relative mt-4 pt-3.5">
                <div className="premium-divider mb-3.5" />
                <PitfallRating rating={cardData.pitfall_rating} />
              </div>
            )}
          </div>

          {/* Card sections — with hover indicator bar */}
          {density !== 'low' && cardData.sections.length > 0 && (
            <div className="px-5 pb-5 md:px-6 md:pb-6 space-y-5 md:space-y-6">
              {cardData.sections.map((section, index) => (
                <div
                  key={index}
                  ref={(el) => { sectionRefs.current[index] = el; }}
                  className="relative pl-4 group"
                  onMouseEnter={handleSectionEnter}
                  onMouseLeave={handleSectionLeave}
                >
                  {/* Elastic hover indicator bar */}
                  <div
                    className="section-hover-bar absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                    style={{
                      background: config.accent,
                      transform: 'scaleY(0.3)',
                      transformOrigin: 'center',
                      opacity: 0.7,
                    }}
                  />
                  <CardSection section={section} index={index} accentColor={config.accent} />
                  {index < cardData.sections.length - 1 && (
                    <div className="mt-5 md:mt-6">
                      <div className="premium-divider" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Conclusion */}
          {cardData.conclusion && (
            <div className="px-5 pb-4 md:px-6 md:pb-5">
              <Conclusion text={cardData.conclusion} accentColor={config.accent} />
            </div>
          )}

          {density === 'low' && (
            <div className="px-5 pb-5 md:px-6 md:pb-6">
              <PitfallRating rating={cardData.pitfall_rating} />
            </div>
          )}

          {/* Source URL */}
          {cardData.source_url && (
            <div className="px-5 pb-5 md:px-6 md:pb-6">
              <div className="premium-divider mb-4" />
              <a
                href={cardData.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-secondary transition-colors duration-300 underline underline-offset-2 decoration-foreground-muted/30 hover:decoration-foreground-secondary/60"
              >
                查看原始视频
              </a>
            </div>
          )}
        </div>
      </div>

      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6">
          <TranscriptViewer transcript={cardData.transcript_raw} />
        </div>
      )}
    </div>
  );
}
