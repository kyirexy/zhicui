'use client';

import type { MarqueeRect } from '@/lib/hooks/useMarqueeSelection';
import styles from './MarqueeSelectionOverlay.module.css';

interface MarqueeSelectionOverlayProps {
  rect: MarqueeRect | null;
}

export default function MarqueeSelectionOverlay({ rect }: MarqueeSelectionOverlayProps) {
  return (
    <div
      className={styles.overlay}
      aria-hidden="true"
      data-visible={Boolean(rect)}
      style={{
        left: rect?.left ?? 0,
        top: rect?.top ?? 0,
        width: Math.max(rect?.width ?? 1, 1),
        height: Math.max(rect?.height ?? 1, 1),
      }}
    />
  );
}
