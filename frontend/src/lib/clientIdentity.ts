import { Capacitor } from '@capacitor/core';
import { detectDesktopRuntime } from './desktopRuntime';
import type { ZhicuiClientType } from './api';

export async function currentClientType(): Promise<ZhicuiClientType> {
  if (typeof window === 'undefined') return 'web';
  const runtime = await detectDesktopRuntime();
  if (runtime) return runtime.platform === 'darwin' ? 'macos' : 'windows';
  const platform = Capacitor.getPlatform();
  return Capacitor.isNativePlatform() && (platform === 'ios' || platform === 'android') ? platform : 'web';
}
