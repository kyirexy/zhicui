import type { CapacitorConfig } from '@capacitor/cli';

const remoteUi = process.env.CAPACITOR_REMOTE_UI === 'true';
const remoteUiUrl = process.env.CAPACITOR_REMOTE_UI_URL || 'https://luxai.cn';
if (remoteUi && remoteUiUrl !== 'https://luxai.cn') {
  throw new Error('远程 UI 只允许指向 https://luxai.cn');
}

const config: CapacitorConfig = {
  appId: 'com.videocapsule.app',
  appName: '知萃',
  webDir: 'out',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    androidScheme: 'https',
    ...(remoteUi ? { url: remoteUiUrl, cleartext: false } : {}),
    // For development, you can uncomment the line below to point to dev server:
    // url: 'http://192.168.x.x:3000',
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystorePassword: undefined,
      keystoreAlias: undefined,
      keystoreAliasPassword: undefined,
      releaseType: 'APK',
    },
  },
};

export default config;
