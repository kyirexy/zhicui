export type DesktopBuildChannel = 'development' | 'stable';

export interface DesktopBuildIdentity {
  channel: DesktopBuildChannel;
  displayName: string;
  windowTitle: string;
}

export function desktopBuildIdentity(packaged: boolean): DesktopBuildIdentity {
  if (packaged) {
    return {
      channel: 'stable',
      displayName: '知萃',
      windowTitle: '知萃',
    };
  }
  return {
    channel: 'development',
    displayName: '知萃开发版',
    windowTitle: '知萃开发版 · 本地调试',
  };
}
