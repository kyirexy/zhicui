import { Sparkles, Minus, Layout, Wand2, Columns3, List } from 'lucide-react';
import type { CardStyle } from './types';

/** Lucide SVG icons mapped to each card style preset.
    Used by the style picker, toolbar, and bottom sheet. */
export const STYLE_ICONS: Record<CardStyle, React.ReactNode> = {
  hero:     <Sparkles size={20} strokeWidth={1.8} />,
  minimal:  <Minus size={20} strokeWidth={1.8} />,
  standard: <Layout size={20} strokeWidth={1.8} />,
  creative: <Wand2 size={20} strokeWidth={1.8} />,
  magazine: <Columns3 size={20} strokeWidth={1.8} />,
  compact:  <List size={20} strokeWidth={1.8} />,
};
