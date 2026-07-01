'use client';

import { AuthProvider } from '@/lib/hooks/AuthContext';
import { SettingsProvider } from '@/lib/hooks/SettingsContext';
import { ExtractionProvider } from '@/lib/hooks/ExtractionContext';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <SettingsProvider>
        <ExtractionProvider>{children}</ExtractionProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
