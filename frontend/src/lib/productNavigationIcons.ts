import {
  BookOpenText,
  CalendarCheck,
  House,
  Sparkles,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { ProductDestinationId } from './productNavigation';

export const PRODUCT_NAVIGATION_ICONS: Record<ProductDestinationId, LucideIcon> = {
  home: House,
  library: Video,
  assistant: Sparkles,
  knowledge: BookOpenText,
  plans: CalendarCheck,
};
