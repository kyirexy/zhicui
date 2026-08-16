'use client';

import { AuthProvider } from '@/lib/hooks/AuthContext';
import { SettingsProvider } from '@/lib/hooks/SettingsContext';
import { ExtractionProvider } from '@/lib/hooks/ExtractionContext';
import { VideoAnalysisProvider } from '@/lib/hooks/VideoAnalysisContext';
import { CreatorSyncProvider } from '@/lib/hooks/CreatorSyncContext';
import ClientErrorReporter from '@/components/ClientErrorReporter';
import LibraryAutoSyncScheduler from '@/components/LibraryAutoSyncScheduler';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ClientErrorReporter />
      <SettingsProvider>
        <VideoAnalysisProvider>
          <CreatorSyncProvider>
            <ExtractionProvider>
              <LibraryAutoSyncScheduler />
              {children}
            </ExtractionProvider>
          </CreatorSyncProvider>
        </VideoAnalysisProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
