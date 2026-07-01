'use client';

import { useState, useRef, useCallback } from 'react';
import gsap from 'gsap';
import { ChevronDown } from 'lucide-react';
import { type StyleCardProps, CARD_TYPE_CONFIG } from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

/**
 * CompactListCard — 弹性折叠列表。
 *
 * GSAP 驱动的：
 * - 折叠/展开：高度动画（替代 CSS transition，更流畅）
 * - 展开箭头：弹性旋转 + 弹跳
 * - 列表项 hover：微平移 + 指示条出现
 * - 批量展开/折叠：stagger 延迟
 */
export default function CompactListCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const contentRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const chevronRefs = useRef<Map<number, HTMLSpanElement>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);

  const toggleSection = useCallback(
    (index: number) => {
      setExpandedSections((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    [],
  );

  // ---- GSAP-driven expand/collapse ----
  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;

    // Staggered list entrance
    if (listRef.current) {
      const items = listRef.current.querySelectorAll('.compact-accordion');
      gsap.from(items, {
        opacity: 0,
        x: -12,
        duration: 0.4,
        stagger: 0.06,
        ease: 'power2.out',
        delay: 0.15,
      });
    }
  }, []);

  // GSAP animate a single section expand/collapse
  const animateExpand = useCallback(
    (_index: number, expanding: boolean, contentEl: HTMLDivElement, chevronEl?: HTMLSpanElement) => {
      if (!shouldAnimate()) return;

      // Height animation
      if (expanding) {
        contentEl.style.display = 'block';
        contentEl.style.overflow = 'hidden';
        const targetHeight = contentEl.scrollHeight;
        gsap.fromTo(
          contentEl,
          { height: 0, opacity: 0 },
          {
            height: targetHeight,
            opacity: 1,
            duration: 0.4,
            ease: 'power3.out',
            onComplete: () => {
              contentEl.style.height = 'auto';
              contentEl.style.overflow = '';
            },
          },
        );
      } else {
        contentEl.style.overflow = 'hidden';
        gsap.to(contentEl, {
          height: 0,
          opacity: 0,
          duration: 0.3,
          ease: 'power2.in',
          onComplete: () => {
            contentEl.style.display = 'none';
            contentEl.style.height = 'auto';
            contentEl.style.overflow = '';
          },
        });
      }

      // Chevron rotation
      if (chevronEl) {
        gsap.to(chevronEl, {
          rotation: expanding ? 180 : 0,
          duration: 0.35,
          ease: expanding ? 'back.out(1.4)' : 'power2.in',
        });
      }
    },
    [],
  );

  // Wrap toggle to trigger GSAP
  const handleToggle = useCallback(
    (index: number) => {
      const contentEl = contentRefs.current.get(index);
      const chevronEl = chevronRefs.current.get(index);
      const expanding = !expandedSections.has(index);

      if (contentEl && shouldAnimate()) {
        animateExpand(index, expanding, contentEl, chevronEl);
      }

      toggleSection(index);
    },
    [expandedSections, toggleSection, animateExpand],
  );

  return (
    <div className="compact-card" ref={cardRef as React.RefObject<HTMLDivElement>}>
      <div className="bg-card-bg border border-card-border rounded-xl overflow-hidden">
        {/* Compact header bar */}
        <div
          className="px-4 py-3 md:px-5 md:py-3.5 flex items-center gap-3"
          style={{ borderBottom: `1px solid var(--card-border)` }}
        >
          <span className="text-xl flex-shrink-0">{config.emoji}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                style={{ color: config.accent, background: `${config.accent}12` }}
              >
                {config.label}
              </span>
            </div>
            <h2 className="text-sm md:text-base font-semibold text-foreground truncate">
              {cardData.title}
            </h2>
          </div>
          <PitfallRating rating={cardData.pitfall_rating} size="sm" />
        </div>

        {/* Conclusion — always visible */}
        {cardData.conclusion && (
          <div
            className="px-4 py-3 md:px-5 md:py-3.5"
            style={{ borderBottom: `1px solid var(--card-border)` }}
          >
            <div className="space-y-1">
              {cardData.conclusion.split('\n').filter(Boolean).map((line, i) => (
                <p key={i} className="text-xs md:text-sm text-foreground-secondary leading-relaxed">
                  <span
                    className="inline-block w-1 h-1 rounded-full mr-2 align-middle"
                    style={{ background: config.accent }}
                  />
                  {line}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* Collapsible sections — GSAP accordion */}
        {density !== 'low' && cardData.sections.length > 0 && (
          <div ref={listRef} className="divide-y divide-card-border">
            {cardData.sections.map((section, i) => {
              const isOpen = expandedSections.has(i);
              return (
                <div key={i} className="compact-accordion">
                  <button
                    type="button"
                    onClick={() => handleToggle(i)}
                    className="w-full px-4 py-2.5 md:px-5 md:py-3 flex items-center gap-2.5 text-left hover:bg-card-bg transition-colors duration-200 group"
                  >
                    <span className="text-base flex-shrink-0">{section.emoji || '📌'}</span>
                    <span className="text-xs md:text-sm font-medium text-foreground flex-1 truncate">
                      {section.title}
                    </span>
                    <span
                      ref={(el) => {
                        if (el) chevronRefs.current.set(i, el);
                      }}
                      className="inline-block flex-shrink-0 transition-transform duration-0"
                      style={{
                        transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <ChevronDown size={14} className="text-foreground-muted" />
                    </span>
                  </button>
                  <div
                    ref={(el) => {
                      if (el) contentRefs.current.set(i, el);
                    }}
                    className="px-4 pb-3 md:px-5 md:pb-4 pl-11 md:pl-12"
                    style={{ display: isOpen ? 'block' : 'none' }}
                  >
                    <p className="text-xs md:text-sm text-foreground-secondary leading-relaxed whitespace-pre-line text-pretty">
                      {section.content.replace(/\*\*(.+?)\*\*/g, '$1')}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Source link */}
        {cardData.source_url && (
          <div
            className="px-4 py-2.5 md:px-5 md:py-3"
            style={{ borderTop: `1px solid var(--card-border)` }}
          >
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
