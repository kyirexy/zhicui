'use client';

import { useEffect, useState } from 'react';
import DesktopWorkspaceHome from '@/components/DesktopWorkspaceHome';
import WorkspaceActionHome from '@/components/WorkspaceActionHome';
import WebLandingPage from '@/components/WebLandingPage';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeMobileApp } from '@/lib/douyinNative';

export default function HomePage() {
  const { isDesktop, resolved } = useDesktopApp();
  const [nativeMobile, setNativeMobile] = useState<boolean | null>(null);

  useEffect(() => {
    const isDevelopmentMobilePreview = (
      process.env.NODE_ENV === 'development'
      && new URLSearchParams(window.location.search).get('previewMobile') === '1'
    );
    setNativeMobile(isDevelopmentMobilePreview || isNativeMobileApp());
  }, []);

  if (!resolved || nativeMobile === null) {
    return <div className="min-h-[68dvh]" aria-hidden="true" />;
  }

  if (isDesktop) {
    return <DesktopWorkspaceHome />;
  }

  if (!nativeMobile) {
    return <WebLandingPage />;
  }

  return (
    <div className="relative min-h-[calc(100dvh-8rem)] pb-24">
      <WorkspaceActionHome />
    </div>
  );
}
