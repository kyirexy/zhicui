'use client';

import { Capacitor } from '@capacitor/core';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { useDesktopUpdate } from '@/lib/hooks/useDesktopUpdate';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useWebBuildUpdateDriver } from '@/lib/hooks/useWebBuildUpdate';
import { supportsWebBuildRefresh } from '@/lib/webBuildPreload';

export default function WebBuildUpdatePrompt() {
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { resolved } = useDesktopApp();
  const extraction = useExtraction();
  const nativeUpdate = useDesktopUpdate();
  // 当前发行 APK 仅有打包页面；刷新该页面并不会获得服务器的新界面。
  const remotePage = typeof window !== 'undefined' && supportsWebBuildRefresh(window.location, Capacitor.isNativePlatform());
  const enabled = remotePage && resolved && !authLoading && !pathname.startsWith('/login')
    && process.env.NODE_ENV !== 'development';
  useWebBuildActivity('global-extraction', extraction.isLoading);
  // 创作者同步与视频解析是服务端持久 job：刷新页面不影响执行，前端恢复轮询即可，
  // 不能把它们当作前台任务阻塞自动更新（否则长任务期间页面永远停在旧版）。
  useWebBuildActivity('native-install', nativeUpdate.update.status === 'installing');
  useWebBuildUpdateDriver(enabled, user?.id || 'public');
  // 网页版本检查与资源预加载仍然运行，但更新在空闲时直接热刷新，不再显示右下角提示。
  return null;
}
