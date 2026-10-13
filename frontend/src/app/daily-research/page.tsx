'use client';

import DailyResearchWorkspace from '@/components/daily-research/DailyResearchWorkspace';
import { useAuth } from '@/lib/hooks/AuthContext';

export default function DailyResearchPage() {
  const { user } = useAuth();
  return user ? <DailyResearchWorkspace key={user.id} accountEmail={user.email} /> : null;
}
