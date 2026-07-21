import type { CardStyle } from '@/lib/types';

interface StylePreviewProps {
  style: CardStyle;
  active?: boolean;
  compact?: boolean;
}

/** Small, DOM-only style thumbnail. It deliberately avoids mounting card GSAP. */
export default function StylePreview({ style, active = false, compact = false }: StylePreviewProps) {
  return (
    <span
      className={`style-preview style-preview--${style} ${active ? 'is-active' : ''} ${compact ? 'is-compact' : ''}`}
      aria-hidden
    >
      <span className="style-preview__glow" />
      <span className="style-preview__eyebrow" />
      <span className="style-preview__title" />
      <span className="style-preview__grid">
        <i /><i /><i />
      </span>
      <span className="style-preview__footer" />
    </span>
  );
}
