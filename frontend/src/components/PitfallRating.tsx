'use client';

import { useState } from 'react';

interface PitfallRatingProps {
  rating: number;
  maxRating?: number;
  size?: 'sm' | 'md' | 'lg';
}

export default function PitfallRating({
  rating,
  maxRating = 5,
  size = 'md',
}: PitfallRatingProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const sizeConfig = {
    sm: { text: 'text-sm', gap: 'gap-0.5', icon: 12 },
    md: { text: 'text-base', gap: 'gap-1', icon: 16 },
    lg: { text: 'text-xl', gap: 'gap-1.5', icon: 20 },
  };

  const cfg = sizeConfig[size];

  return (
    <div className="flex items-center gap-3 md:gap-3.5">
      <span className="text-foreground-secondary text-xs md:text-sm font-medium whitespace-nowrap">
        防踩坑避雷指数
      </span>
      <div
        className={`flex items-center ${cfg.gap}`}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        {Array.from({ length: maxRating }, (_, i) => {
          const isFilled = i < rating;
          const isHovered = hoveredIndex !== null && i <= hoveredIndex;

          return (
            <button
              key={i}
              type="button"
              data-star
              className={`${cfg.text} transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:scale-125 focus:outline-none cursor-default`}
              onMouseEnter={() => setHoveredIndex(i)}
              aria-label={`${i + 1} 星`}
            >
              <span
                className={
                  isFilled
                    ? 'star-filled inline-block transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]'
                    : isHovered
                      ? 'opacity-50 inline-block transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] scale-110'
                      : 'star-empty inline-block transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]'
                }
              >
                ★
              </span>
            </button>
          );
        })}
      </div>
      {/* Rating count badge */}
      <span className="text-xs text-foreground-muted/60 font-medium tabular-nums">
        {rating}/{maxRating}
      </span>
    </div>
  );
}
