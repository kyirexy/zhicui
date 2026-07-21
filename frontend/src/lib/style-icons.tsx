import {
  Circuitry,
  Columns,
  GridFour,
  ListBullets,
  MagicWand,
  Minus,
  Notebook,
  Sparkle,
  WaveSine,
  type Icon,
} from '@phosphor-icons/react';
import type { CardStyle } from './types';

const STYLE_ICON_COMPONENTS: Record<CardStyle, Icon> = {
  hero: Sparkle,
  minimal: Minus,
  standard: GridFour,
  creative: MagicWand,
  magazine: Columns,
  compact: ListBullets,
  aurora: WaveSine,
  blueprint: Circuitry,
  paper: Notebook,
};

interface StyleIconProps {
  style: CardStyle;
  active?: boolean;
  size?: number;
  className?: string;
}

/** Consistent duotone icon treatment shared by all style selectors. */
export function StyleIcon({ style, active = false, size = 20, className = '' }: StyleIconProps) {
  const IconComponent = STYLE_ICON_COMPONENTS[style];
  return (
    <span className={`style-icon ${active ? 'is-active' : ''} ${className}`} aria-hidden>
      <IconComponent size={size} weight={active ? 'fill' : 'duotone'} />
    </span>
  );
}
