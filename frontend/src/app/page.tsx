'use client';

import { useEffect, useState } from 'react';
import DesktopWorkspaceHome from '@/components/DesktopWorkspaceHome';
import WorkspaceActionHome from '@/components/WorkspaceActionHome';
import WebLandingPage from '@/components/WebLandingPage';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeAndroidApp } from '@/lib/douyinNative';

export default function HomePage() {
  const { isDesktop, resolved } = useDesktopApp();
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  if (!resolved || nativeAndroid === null) {
    return <div className="min-h-[68dvh]" aria-hidden="true" />;
  }

  if (isDesktop) {
    return <DesktopWorkspaceHome />;
  }

  if (!nativeAndroid) {
    return <WebLandingPage />;
  }

  return (
    <div className="relative min-h-[calc(100dvh-8rem)] pb-24">
      <WorkspaceActionHome />
    </div>
  );
}
