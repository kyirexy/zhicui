import {
  BookOpenText,
  CalendarCheck,
  Clapperboard,
  House,
  Link2,
  Plug,
  Sparkles,
  UserRound,
  Video,
  type LucideIcon,
} from 'lucide-react';
import type { ProductDestinationId } from './productNavigation';

export const PRODUCT_NAVIGATION_ICONS: Record<ProductDestinationId, LucideIcon> = {
  home: House,
  library: Video,
  extract: Link2,
  creators: UserRound,
  harness: Sparkles,
  studio: Clapperboard,
  'agent-access': Plug,
  knowledge: BookOpenText,
  plans: CalendarCheck,
};
