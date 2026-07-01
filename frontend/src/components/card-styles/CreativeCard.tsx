'use client';

import { useRef, useState, useCallback } from 'react';
import gsap from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { type StyleCardProps, CARD_TYPE_CONFIG } from '@/lib/types';
import { useGsapAnimation, shouldAnimate } from '@/lib/hooks/useGsapAnimation';
import CardSection from '../CardSection';
import Conclusion from '../Conclusion';
import PitfallRating from '../PitfallRating';
import TranscriptViewer from '../TranscriptViewer';

// Register once at module level
gsap.registerPlugin(MotionPathPlugin);

/**
 * CreativeCard — 真正有创意的视觉风格。
 *
 * GSAP 驱动的：
 * - 背景渐变缓慢流动（hue 循环）
 * - 标题霓虹发光脉冲
 * - 浮动粒子沿贝塞尔曲线运动
 * - 卡片 hover 时 3D 透视倾斜（视差）
 * - 装饰分隔线描边动画
 */
export default function CreativeCard({ cardData, density, cardRef }: StyleCardProps) {
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const rootRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const particle1Ref = useRef<HTMLDivElement>(null);
  const particle2Ref = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // ---- 3D tilt state ----
  const [tilt, setTilt] = useState({ x: 0, y: 0 });

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!shouldAnimate()) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 2; // -1 .. 1
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
      setTilt({ x: x * 4, y: y * -4 }); // max ±4°
    },
    [],
  );

  const handleMouseLeave = useCallback(() => {
    setTilt({ x: 0, y: 0 });
  }, []);

  // ---- GSAP animations ----
  useGsapAnimation((gsap) => {
    if (!shouldAnimate()) return;

    // 1. Background gradient flow — slow hue rotation on the glow orbs
    if (glowRef.current) {
      gsap.to(glowRef.current, {
        rotation: 360,
        duration: 20,
        repeat: -1,
        ease: 'none',
      });
    }

    // 2. Neon glow pulse on title
    if (titleRef.current) {
      gsap.to(titleRef.current, {
        textShadow: `0 0 20px ${config.accent}40, 0 0 40px ${config.accent}20, 0 0 80px ${config.accent}10`,
        duration: 2,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut',
      });
    }

    // 3. Bezier-path floating particles
    if (particle1Ref.current) {
      gsap.to(particle1Ref.current, {
        motionPath: {
          path: [
            { x: 0, y: 0 },
            { x: 30, y: -20 },
            { x: -20, y: -40 },
            { x: 10, y: -15 },
            { x: 0, y: 0 },
          ],
          curviness: 1.5,
        },
        duration: 7,
        repeat: -1,
        ease: 'none',
      });
    }
    if (particle2Ref.current) {
      gsap.to(particle2Ref.current, {
        motionPath: {
          path: [
            { x: 0, y: 0 },
            { x: -25, y: 15 },
            { x: 20, y: 35 },
            { x: -10, y: 10 },
            { x: 0, y: 0 },
          ],
          curviness: 1.3,
        },
        duration: 9,
        repeat: -1,
        ease: 'none',
        delay: 1,
      });
    }

    // 4. Divider draw animation
    if (dividerRef.current) {
      gsap.from(dividerRef.current, {
        scaleX: 0,
        duration: 1.2,
        ease: 'power3.out',
        delay: 0.3,
        transformOrigin: 'center',
      });
    }
  }, [config.accent]);

  return (
    <div
      className="creative-card"
      ref={rootRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        perspective: '800px',
      }}
    >
      {/* 3D tilt wrapper */}
      <div
        ref={cardRef as React.RefObject<HTMLDivElement>}
        className="relative rounded-2xl overflow-hidden"
        style={{
          background: `linear-gradient(160deg, ${config.accent}08 0%, var(--card-bg) 30%, var(--card-bg) 70%, ${config.accent}06 100%)`,
          border: `1px solid ${config.accent}18`,
          transform: `rotateX(${tilt.y}deg) rotateY(${tilt.x}deg)`,
          transition: 'transform 0.4s cubic-bezier(0.23, 1, 0.32, 1)',
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Large decorative glow orb — slowly rotating */}
        <div
          ref={glowRef}
          className="absolute -top-20 -right-20 w-60 h-60 rounded-full opacity-[0.06] pointer-events-none blur-3xl"
          style={{
            background: `conic-gradient(from 0deg, ${config.accent}40, ${config.accent}10, transparent 70%)`,
          }}
        />
        <div
          className="absolute -bottom-20 -left-20 w-60 h-60 rounded-full opacity-[0.04] pointer-events-none blur-3xl"
          style={{
            background: `conic-gradient(from 180deg, ${config.accent}30, ${config.accent}08, transparent 70%)`,
          }}
        />

        {/* Floating accent particles — bezier paths via GSAP */}
        <div
          ref={particle1Ref}
          className="absolute top-8 right-8 w-2.5 h-2.5 rounded-full opacity-25 pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${config.accent}, transparent)`,
            boxShadow: `0 0 12px ${config.accent}60`,
          }}
        />
        <div
          ref={particle2Ref}
          className="absolute bottom-12 right-12 w-1.5 h-1.5 rounded-full opacity-20 pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${config.accent}, transparent)`,
            boxShadow: `0 0 8px ${config.accent}40`,
          }}
        />

        {/* Header — large emoji centered with glow */}
        <div className="relative px-6 pt-8 pb-5 md:px-8 md:pt-10 md:pb-6 text-center">
          <span
            className="block text-5xl md:text-6xl mb-4"
            style={{
              filter: `drop-shadow(0 0 24px ${config.accent}30)`,
              transform: 'translateZ(20px)',
            }}
          >
            {config.emoji}
          </span>
          <span
            className="inline-block px-3 py-1 rounded-full text-xs font-semibold tracking-wide uppercase mb-3"
            style={{
              background: `${config.accent}18`,
              color: config.accent,
              border: `1px solid ${config.accent}30`,
              transform: 'translateZ(10px)',
            }}
          >
            {config.label}
          </span>
          <h2
            ref={titleRef}
            className="text-xl md:text-2xl font-bold text-foreground leading-snug text-balance max-w-xl mx-auto"
            style={{ transform: 'translateZ(15px)' }}
          >
            {cardData.title}
          </h2>
        </div>

        {/* Decorative divider with draw animation */}
        <div className="px-6 md:px-8">
          <div
            ref={dividerRef}
            className="h-px w-full"
            style={{
              background: `linear-gradient(90deg, transparent, ${config.accent}50, ${config.accent}25, transparent)`,
            }}
          />
        </div>

        {/* Pitfall rating */}
        {density !== 'low' && (
          <div className="px-6 py-4 md:px-8 md:py-5" style={{ transform: 'translateZ(8px)' }}>
            <PitfallRating rating={cardData.pitfall_rating} size="lg" />
          </div>
        )}

        {/* Sections */}
        {density !== 'low' && cardData.sections.length > 0 && (
          <div className="px-6 pb-6 md:px-8 md:pb-8 space-y-6" style={{ transform: 'translateZ(5px)' }}>
            {cardData.sections.map((section, index) => (
              <CardSection key={index} section={section} index={index} accentColor={config.accent} />
            ))}
          </div>
        )}

        {/* Conclusion — gradient bezel box */}
        {cardData.conclusion && (
          <div className="px-6 pb-6 md:px-8 md:pb-8" style={{ transform: 'translateZ(10px)' }}>
            <div
              className="rounded-2xl p-[1.5px]"
              style={{
                background: `linear-gradient(135deg, ${config.accent}50, ${config.accent}20 40%, ${config.accent}35 60%, ${config.accent}15)`,
              }}
            >
              <div
                className="rounded-[13px] p-5 md:p-6"
                style={{ background: `${config.accent}08` }}
              >
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                  <span style={{ color: config.accent }}>✦</span>
                  3行字终极结论
                </h3>
                <div className="space-y-2.5">
                  {cardData.conclusion.split('\n').filter(Boolean).map((line, i) => (
                    <p key={i} className="text-sm text-foreground-secondary leading-relaxed text-pretty">
                      {line}
                    </p>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Pitfall for low density */}
        {density === 'low' && (
          <div className="px-6 pb-6 md:px-8 md:pb-8">
            <PitfallRating rating={cardData.pitfall_rating} size="md" />
          </div>
        )}

        {/* Source URL */}
        {cardData.source_url && (
          <div className="px-6 pb-5 md:px-8 md:pb-6" style={{ transform: 'translateZ(3px)' }}>
            <a
              href={cardData.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-foreground-muted hover:text-foreground-secondary transition-colors duration-300 underline underline-offset-2"
            >
              查看原始视频
            </a>
          </div>
        )}
      </div>

      {/* Transcript for high density */}
      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6">
          <TranscriptViewer transcript={cardData.transcript_raw} />
        </div>
      )}
    </div>
  );
}
