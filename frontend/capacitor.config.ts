import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.videocapsule.app',
  appName: '知萃',
  webDir: 'out',
  ios: {
    contentInset: 'automatic',
  },
  server: {
    androidScheme: 'https',
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
