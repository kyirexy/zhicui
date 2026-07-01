'use client';

import { useRef, useMemo } from 'react';
import gsap from 'gsap';
import { type StyleCardProps, CARD_TYPE_CONFIG } from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

/**
 * MinimalCard — 极简呼吸感。
 *
 * GSAP 驱动的：
 * - 大间距 + 慢速淡入 (power1 vs power3)
 * - 段落间分隔线延伸动画 (scaleX 0→1)
 * - 评分星星一颗颗弹跳出现 (elastic ease)
 * - 整体呼吸式微缩放 pulse
 */
export default function MinimalCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const rootRef = useRef<HTMLDivElement>(null);
  const dividerRefs = useRef<(HTMLDivElement | null)[]>([]);
  const starRefs = useRef<(Element | null)[]>([]);
  const contentRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pitfallContainerRef = useRef<HTMLDivElement>(null);

  // Key that changes when card data changes, so GSAP re-runs
  const cardKey = useMemo(
    () => cardData.title + cardData.card_type + cardData.sections.length,
    [cardData.title, cardData.card_type, cardData.sections.length],
  );

  // Capture star DOM elements after PitfallRating renders
  const captureStars = useRef<(() => void) | null>(null);
  if (!captureStars.current) {
    captureStars.current = () => {
      const container = pitfallContainerRef.current;
      if (!container || !shouldAnimate()) return;
      const stars = container.querySelectorAll('[data-star]');
      starRefs.current = Array.from(stars);
      // Animate them with elastic bounce
      stars.forEach((el, i) => {
        if (el instanceof HTMLElement) {
          gsap.fromTo(el, { scale: 0, rotation: -30 }, {
            scale: 1,
            rotation: 0,
            duration: 0.5,
            delay: 1.0 + i * 0.08,
            ease: 'elastic.out(1, 0.6)',
          });
        }
      });
    };
  }

  useGsapAnimation((gsapLocal) => {
    if (!shouldAnimate()) return;

    // 1. Overall breathing scale — barely perceptible, very slow
    if (rootRef.current) {
      gsapLocal.to(rootRef.current, {
        scale: 1.003,
        duration: 4,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    }

    // 2. Content blocks — slow, gentle fade-in with generous stagger
    contentRefs.current.filter(Boolean).forEach((el, i) => {
      if (!el) return;
      gsapLocal.from(el, {
        opacity: 0,
        y: 20,
        duration: 0.9,
        delay: i * 0.18,
        ease: 'power1.inOut',
      });
    });

    // 3. Divider line extensions — scaleX draw effect
    dividerRefs.current.filter(Boolean).forEach((el, i) => {
      if (!el) return;
      gsapLocal.from(el, {
        scaleX: 0,
        duration: 0.7,
        delay: 0.3 + i * 0.15,
        ease: 'power2.out',
        transformOrigin: 'left center',
      });
    });

    // 4. Stars — elastic bounce-in (deferred to captureStars)
    if (captureStars.current) captureStars.current();
  }, [cardKey]);

  return (
    <div className="minimal-card" ref={rootRef}>
      <div ref={cardRef as React.RefObject<HTMLDivElement>} className="rounded-xl border border-card-border bg-card-bg overflow-hidden">
        {/* Header */}
        <div
          ref={(el) => { contentRefs.current[0] = el; }}
          className="px-5 py-4 md:px-6 md:py-5 border-b border-card-border"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-lg">{config.emoji}</span>
            <span
              className="text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded"
              style={{ color: config.accent, background: `${config.accent}12` }}
            >
              {config.label}
            </span>
          </div>
          <h2 className="mt-2 text-base md:text-lg font-semibold text-foreground leading-snug text-balance">
            {cardData.title}
          </h2>
        </div>

        {/* Conclusion — priority */}
        {cardData.conclusion && (
          <div
            ref={(el) => { contentRefs.current[1] = el; }}
            className="px-5 py-4 md:px-6 md:py-5"
          >
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wide mb-3">
              结论
            </h3>
            <div className="space-y-2">
              {cardData.conclusion.split('\n').filter(Boolean).map((line, i) => (
                <p key={i} className="text-sm text-foreground-secondary leading-relaxed">
                  {line}
                </p>
              ))}
            </div>
            <div ref={(el) => { dividerRefs.current[0] = el; }} className="premium-divider mt-4" />
          </div>
        )}

        {/* Sections — at medium+ density */}
        {density !== 'low' && cardData.sections.length > 0 && (
          <div
            ref={(el) => { contentRefs.current[2] = el; }}
            className="px-5 py-4 md:px-6 md:py-5"
          >
            <h3 className="text-xs font-semibold text-foreground-muted uppercase tracking-wide mb-3">
              内容要点
            </h3>
            <div className="space-y-4">
              {cardData.sections.map((section, i) => (
                <div key={i}>
                  <h4 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-1.5">
                    <span className="text-base">{section.emoji || '📌'}</span>
                    {section.title}
                  </h4>
                  <p className="text-sm text-foreground-secondary leading-relaxed whitespace-pre-line text-pretty">
                    {section.content.replace(/\*\*(.+?)\*\*/g, '$1')}
                  </p>
                </div>
              ))}
            </div>
            <div ref={(el) => { dividerRefs.current[1] = el; }} className="premium-divider mt-4" />
          </div>
        )}

        {/* Pitfall rating — stars bounce in */}
        <div
          ref={(el) => { contentRefs.current[3] = el; }}
          className="px-5 py-3 md:px-6 md:py-4"
        >
          <div ref={pitfallContainerRef}>
            <PitfallRating rating={cardData.pitfall_rating} size="sm" />
          </div>
        </div>

        {/* Source URL */}
        {cardData.source_url && (
          <div className="px-5 pb-4 md:px-6 md:pb-5">
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
