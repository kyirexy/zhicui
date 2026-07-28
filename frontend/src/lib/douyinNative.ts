import { Capacitor, registerPlugin } from '@capacitor/core';

interface DouyinBridgePlugin {
  saveLoginQr(options: { dataUrl: string }): Promise<{
    saved: boolean;
    fileName: string;
    album: string;
  }>;
  openDouyin(): Promise<{
    installed: boolean;
    destination: 'app' | 'web';
  }>;
}

const DouyinBridge = registerPlugin<DouyinBridgePlugin>('DouyinBridge');

export function isNativeAndroidApp(): boolean {
  return (
    typeof window !== 'undefined'
    && Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
  );
}

export async function saveDouyinLoginQrToGallery(dataUrl: string) {
  if (!isNativeAndroidApp()) {
    throw new Error('当前环境不支持原生相册保存');
  }
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('二维码图片格式无效');
  }
  return DouyinBridge.saveLoginQr({ dataUrl });
}

export async function openDouyinFromAndroidApp() {
  if (!isNativeAndroidApp()) {
    throw new Error('当前环境不支持原生启动抖音');
  }
  return DouyinBridge.openDouyin();
}
