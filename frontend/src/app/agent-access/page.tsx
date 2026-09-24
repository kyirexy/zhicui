'use client';

import { useEffect, useState } from 'react';
import AgentAccessSettingsCard from '@/components/AgentAccessSettingsCard';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { isNativeAndroidApp, isNativeMobileApp } from '@/lib/douyinNative';
import { useAuth } from '@/lib/hooks/AuthContext';
import styles from './page.module.css';

export default function AgentAccessPage() {
  const { isDesktop } = useDesktopApp();
  const { user } = useAuth();
  const [nativePlatform, setNativePlatform] = useState({ android: false, ios: false });

  useEffect(() => {
    const android = isNativeAndroidApp();
    setNativePlatform({ android, ios: isNativeMobileApp() && !android });
  }, []);

  return (
    <div className={styles.workspace}>
      <AgentAccessSettingsCard
        key={user?.id || 'signed-out'}
        isDesktop={isDesktop}
        nativeAndroid={nativePlatform.android}
        nativeIOS={nativePlatform.ios}
      />
    </div>
  );
}
