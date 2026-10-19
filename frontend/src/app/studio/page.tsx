'use client';

import StudioWorkspace from '@/components/studio/StudioWorkspace';
import { useAuth } from '@/lib/hooks/AuthContext';

export default function StudioPage() {
  const { user } = useAuth();
  return user ? <StudioWorkspace key={user.id} /> : null;
}
