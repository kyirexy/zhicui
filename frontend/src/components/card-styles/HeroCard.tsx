'use client';

/**
 * HeroCard — the flagship adaptive card, now with GSAP animations.
 *
 * Reading order is intentional and fixed:
 *   1. Type chip + title         (eyebrow)
 *   2. Hero quote                (staggered character reveal)
 *   3. Stat strip                (count-up animation)
 *   4. Key insight               (analyst's one-line take)
 *   5. Numbered sections         (staggered entrance + hover shimmer)
 *   6. Three-line takeaway       (staggered slide-in)
 *   7. Pitfall meter             (animated fill)
 *
 * Layout density adjusts via three CSS dials on the root:
 *   data-tone        emotional | informational | hybrid
 *   data-density     low | medium | high
 *   class tone-*     recipe | insight | history | product | general
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import gsap from 'gsap';
import {
  type StyleCardProps,
  type ContentTone,
  type ContentDensity,
  CARD_TYPE_CONFIG,
} from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import SectionIcon from '../SectionIcon';
import TranscriptViewer from '../TranscriptViewer';
import { Sparkles, BookmarkCheck, Quote } from 'lucide-react';

/** Format a section's plain-text content into <p>/<ul>/<ol> nodes. */
function formatBody(content: string): React.ReactNode {
  const lines = content.split('\n');
  const out: React.ReactNode[] = [];
  let buffer: string[] = [];
  let listKind: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (buffer.length === 0) return;
    const Tag = listKind === 'ol' ? 'ol' : 'ul';
    out.push(
      <Tag key={`l-${out.length}`}>
        {buffer.map((b, i) => (
          <li key={i}>{inline(b)}</li>
        ))}
      </Tag>,
    );
    buffer = [];
    listKind = null;
  };

  const inline = (text: string): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((p, i) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p,
    );
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushList();
      continue;
    }
    const numbered = t.match(/^(?:[1-9]️⃣\s*|(\d+)[.)]\s*)(.+)/);
    if (numbered) {
      if (listKind !== 'ol') {
        flushList();
        listKind = 'ol';
      }
      buffer.push(numbered[2] || t.replace(/^[1-9]️⃣\s*/, ''));
      continue;
    }
    const bullet = t.match(/^[•\-*]\s+(.+)/);
    if (bullet) {
      if (listKind !== 'ul') {
        flushList();
        listKind = 'ul';
      }
      buffer.push(bullet[1]);
      continue;
    }
    flushList();
    out.push(<p key={`p-${out.length}`}>{inline(t)}</p>);
  }
  flushList();
  return <>{out}</>;
}

function pitfallLabel(rating: number, cardType: string): {
  label: string;
  pct: number;
  hint: string;
  metricLabel: string;
} {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)));
  const pct = (clamped / 5) * 100;

  if (cardType === 'recipe') {
    const labels = ['新手友好', '简单', '中等', '偏难', '难度极高'];
    return { label: labels[clamped - 1], pct, metricLabel: '实操难度', hint: '按视频步骤实操的容易程度' };
  }
  if (cardType === 'product') {
    const labels = ['闭眼入手', '可放心', '需谨慎', '需多比较', '高概率踩雷'];
    return { label: labels[clamped - 1], pct, metricLabel: '入手谨慎度', hint: '直接按视频推荐购买的风险等级' };
  }
  const labels = ['信息扎实', '基本可信', '需自行判断', '建议存疑', '观点偏激进'];
  return { label: labels[clamped - 1], pct, metricLabel: '内容可参考度', hint: '内容偏经验之谈还是建议交叉验证' };
}

function buildStats(cardData: StyleCardProps['cardData']): { label: string; value: string; numericValue: number }[] {
  const out: { label: string; value: string; numericValue: number }[] = [];

  const sectionCount = cardData.sections?.length ?? 0;
  out.push({ label: '核心要点', value: `${sectionCount} 节`, numericValue: sectionCount });

  const wordCount = cardData.transcript_raw?.length ?? 0;
  if (wordCount > 0) {
    const minutes = Math.max(1, Math.round(wordCount / 450));
    out.push({ label: '预计阅读', value: `${minutes} 分钟`, numericValue: minutes });

    const lengthLabel =
      wordCount < 300 ? '短' : wordCount < 1000 ? '中等' : wordCount < 2500 ? '深度' : '长篇';
    out.push({
      label: '内容体量',
      value: `${lengthLabel}（${wordCount.toLocaleString('zh-CN')} 字）`,
      numericValue: 0, // no count animation for text stat
    });
  }

  return out;
}

function resolveProfile(
  cardData: StyleCardProps['cardData'],
  density: ContentDensity,
): { tone: ContentTone; density: ContentDensity } {
  const t: ContentTone =
    cardData.tone ??
    (cardData.card_type === 'recipe' || cardData.card_type === 'product'
      ? 'informational'
      : cardData.card_type === 'insight'
        ? 'hybrid'
        : 'hybrid');
  const d: ContentDensity = cardData.density ?? density ?? 'medium';
  return { tone: t, density: d };
}

/** Animated count display — counts from 0 to target on mount */
function CountUpStat({ value, label }: { value: string; label: string }) {
  const spanRef = useRef<HTMLSpanElement>(null);
  const numMatch = value.match(/^(\d+)/);
  const targetNum = numMatch ? parseInt(numMatch[1], 10) : 0;
  const suffix = numMatch ? value.slice(numMatch[0].length) : value;

  useGsapAnimation((gsap) => {
    if (!shouldAnimate() || targetNum === 0 || !spanRef.current) return;
    const obj = { val: 0 };
    gsap.to(obj, {
      val: targetNum,
      duration: 1.5,
      ease: 'power2.out',
      delay: 0.4,
      onUpdate: () => {
        if (spanRef.current) {
          spanRef.current.textContent = `${Math.round(obj.val)}${suffix}`;
        }
      },
    });
  }, [targetNum, suffix]);

  return (
    <div className="hero-stat">
      <span className="hero-stat-label">{label}</span>
      <span ref={spanRef} className="hero-stat-value">{value}</span>
    </div>
  );
}

export default function HeroCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const { tone, density: effDensity } = resolveProfile(cardData, density);

  // Refs for GSAP targets
  const innerRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);
  const quoteRef = useRef<HTMLDivElement>(null);
  const meterFillRef = useRef<HTMLSpanElement>(null);
  const sectionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const takeawayRefs = useRef<(HTMLLIElement | null)[]>([]);

  // ---- Section hover shimmer (React events, not addEventListener) ----
  const handleSectionEnter = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => {
      if (!shouldAnimate()) return;
      gsap.to(e.currentTarget, {
        boxShadow: `inset 0 0 0 1px ${config.accent}15`,
        backgroundColor: `${config.accent}04`,
        duration: 0.3,
        ease: 'power2.out',
      });
    },
    [config.accent],
  );

  const handleSectionLeave = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => {
      if (!shouldAnimate()) return;
      gsap.to(e.currentTarget, {
        boxShadow: 'inset 0 0 0 1px transparent',
        backgroundColor: 'transparent',
        duration: 0.3,
        ease: 'power2.out',
      });
    },
    [config.accent],
  );

  // ---- Scroll-driven progress ----
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = innerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const total = rect.height + window.innerHeight;
      const scrolled = window.innerHeight - rect.top;
      setProgress(Math.max(0, Math.min(1, scrolled / total)));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // ---- GSAP entrance & hover animations ----
  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;

    // 1. Hero quote — staggered word reveal
    if (quoteRef.current) {
      const words = quoteRef.current.querySelectorAll('.hero-quote-word');
      if (words.length > 0) {
        gsap.from(words, {
          opacity: 0,
          y: 12,
          duration: 0.5,
          stagger: 0.03,
          ease: 'power2.out',
          delay: 0.3,
        });
      }
    }

    // 2. Section stagger entrance
    sectionRefs.current.filter(Boolean).forEach((el, i) => {
      if (!el) return;
      gsap.from(el, {
        opacity: 0,
        x: -24,
        duration: 0.55,
        delay: 0.6 + i * 0.08,
        ease: 'power3.out',
      });
    });

    // 3. Takeaway items stagger slide-in
    takeawayRefs.current.filter(Boolean).forEach((el, i) => {
      if (!el) return;
      gsap.from(el, {
        opacity: 0,
        x: -16,
        duration: 0.4,
        delay: 1.0 + i * 0.1,
        ease: 'power2.out',
      });
    });

    // 4. Meter fill bar animation — delayed so user sees it animate
    if (meterFillRef.current) {
      gsap.from(meterFillRef.current, {
        width: '0%',
        duration: 1.2,
        delay: 1.2,
        ease: 'power3.inOut',
      });
    }
  }, [config.accent]);

  // ---- Build hero quote with word spans for GSAP stagger ----
  const quoteHtml = cardData.hero_quote
    ? cardData.hero_quote.split(/(\s+)/g).map((part, i) =>
        part.trim() ? (
          <span key={i} className="hero-quote-word inline-block">
            {part}
          </span>
        ) : (
          <span key={i}>&nbsp;</span>
        ),
      )
    : null;

  const meter = pitfallLabel(cardData.pitfall_rating, cardData.card_type);
  const stats = buildStats(cardData);
  const showStatsStrip = effDensity !== 'low' && stats.length > 0;
  const showSections = effDensity !== 'low' && cardData.sections.length > 0;
  const showInsight = !!cardData.key_insight && tone !== 'emotional';
  const showMeter =
    effDensity !== 'low' &&
    (cardData.card_type === 'recipe' ||
      cardData.card_type === 'product' ||
      cardData.pitfall_rating !== 3);

  return (
    <div className={`hero-card tone-${cardData.card_type} animate-slide-up`}>
      <div
        ref={cardRef as React.RefObject<HTMLDivElement>}
        className="hero-shell"
        data-tone={tone}
        data-density={effDensity}
      >
        <span className="hero-ribbon" aria-hidden />
        <span
          ref={progressRef}
          className="hero-progress"
          style={{ width: `${progress * 100}%` }}
          aria-hidden
        />

        <div ref={innerRef} className="hero-body flex flex-col">
          {/* 1. Eyebrow + title */}
          <header className="flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="hero-eyebrow">
                <Sparkles size={11} strokeWidth={2.5} aria-hidden />
                {config.label}
              </span>
              {tone === 'emotional' && (
                <span className="hero-eyebrow" style={{ opacity: 0.7 }}>情绪共鸣</span>
              )}
              {tone === 'informational' && (
                <span className="hero-eyebrow" style={{ opacity: 0.7 }}>干货笔记</span>
              )}
              {tone === 'hybrid' && (
                <span className="hero-eyebrow" style={{ opacity: 0.7 }}>观点 + 干货</span>
              )}
            </div>
            <h2 className="text-xl md:text-2xl font-bold text-foreground leading-snug text-balance tracking-tight">
              {cardData.title}
            </h2>
          </header>

          {/* 2. Hero quote — staggered word reveal */}
          {cardData.hero_quote && (
            <figure ref={quoteRef} className="hero-quote-figure">
              <span className="hero-quote-glyph" aria-hidden>&ldquo;</span>
              <blockquote className="hero-quote">{quoteHtml}</blockquote>
            </figure>
          )}

          {/* 3. Stats strip — with count-up animation */}
          {showStatsStrip && (
            <div
              className="grid gap-3 md:gap-4"
              style={{ gridTemplateColumns: `repeat(${Math.min(stats.length, 3)}, minmax(0, 1fr))` }}
            >
              {stats.slice(0, 3).map((s, i) => (
                <CountUpStat key={i} label={s.label} value={s.value} />
              ))}
            </div>
          )}

          {/* 4. Key insight callout */}
          {showInsight && (
            <aside className="hero-insight">
              <span className="hero-insight-label">核心洞察</span>
              {cardData.key_insight}
            </aside>
          )}

          {/* 5. Numbered sections — staggered entrance + hover shimmer */}
          {showSections && (
            <ol className="flex flex-col gap-7 md:gap-8 list-none p-0 m-0">
              {cardData.sections.map((section, i) => (
                <li
                  key={i}
                  ref={(el) => { sectionRefs.current[i] = el; }}
                  className="hero-section rounded-lg transition-shadow duration-300"
                  onMouseEnter={handleSectionEnter}
                  onMouseLeave={handleSectionLeave}
                >
                  <span className="hero-section-marker">
                    <SectionIcon
                      iconKey={section.icon}
                      title={section.title}
                      emoji={section.emoji}
                      size={15}
                      strokeWidth={2.2}
                      className="hero-section-icon"
                    />
                    <span className="num">{i + 1}</span>
                  </span>
                  <div className="min-w-0 flex flex-col gap-2.5">
                    <h3 className="hero-section-title">{section.title}</h3>
                    <div className="hero-section-body">{formatBody(section.content)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}

          {/* 6. Three-line takeaway */}
          {cardData.conclusion && (
            <div className="hero-takeaway">
              <span className="hero-takeaway-marker">
                <BookmarkCheck size={16} strokeWidth={2.2} aria-hidden />
              </span>
              <div className="min-w-0 flex flex-col gap-1.5">
                <span className="text-[11px] font-bold tracking-[0.1em] uppercase text-foreground-muted">
                  三句话带走
                </span>
                <ol className="hero-takeaway-list list-none p-0 m-0">
                  {cardData.conclusion
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 3)
                    .map((line, i) => (
                      <li
                        key={i}
                        ref={(el) => { takeawayRefs.current[i] = el; }}
                        className="hero-takeaway-item"
                      >
                        <span className="num">0{i + 1}</span>
                        <span>{line}</span>
                      </li>
                    ))}
                </ol>
              </div>
            </div>
          )}

          {/* 7. Pitfall meter — animated fill bar */}
          {showMeter && (
            <div className="hero-meter-wrap">
              <div className="hero-meter">
                <span className="hero-meter-label">{meter.metricLabel}</span>
                <span className="hero-meter-track" aria-hidden>
                  <span
                    ref={meterFillRef}
                    className="hero-meter-fill"
                    style={{ width: `${meter.pct}%` }}
                  />
                </span>
                <span className="hero-meter-value">
                  {cardData.pitfall_rating}/5 · {meter.label}
                </span>
              </div>
              <p className="hero-meter-hint">{meter.hint}</p>
            </div>
          )}

          {/* Source attribution */}
          {cardData.source_url && (
            <div className="flex items-center justify-between gap-3 text-[11px] text-foreground-muted pt-2">
              <span className="inline-flex items-center gap-1.5">
                <Quote size={10} strokeWidth={2.2} aria-hidden />
                来源：短视频平台
              </span>
              {cardData.video_id && (
                <span className="font-mono text-[10px] opacity-50 tabular-nums">
                  #{cardData.video_id.slice(-8)}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Transcript inline only at high density */}
      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6">
          <TranscriptViewer transcript={cardData.transcript_raw} />
        </div>
      )}
    </div>
  );
}
