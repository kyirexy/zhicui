'use client';

import { AuthProvider } from '@/lib/hooks/AuthContext';
import { SettingsProvider } from '@/lib/hooks/SettingsContext';
import { ExtractionProvider } from '@/lib/hooks/ExtractionContext';
import ClientErrorReporter from '@/components/ClientErrorReporter';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ClientErrorReporter />
      <SettingsProvider>
        <ExtractionProvider>{children}</ExtractionProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
