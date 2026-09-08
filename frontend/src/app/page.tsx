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

  const runtimePending = !resolved || nativeMobile === null;
  if (runtimePending || (!isDesktop && !nativeMobile)) {
    // 服务端首屏直接输出官网；原生启动标记会隐藏这层公开内容，避免闪屏。
    // 检测完成后保留同一棵官网节点，不重复挂载演示和下载组件。
    return (
      <div className={runtimePending ? 'browser-home-bootstrap' : undefined}>
        <WebLandingPage />
      </div>
    );
  }

  if (isDesktop) {
    return <DesktopWorkspaceHome />;
  }

  return (
    <div className="relative min-h-[calc(100dvh-8rem)] pb-24">
      <WorkspaceActionHome />
    </div>
  );
}
