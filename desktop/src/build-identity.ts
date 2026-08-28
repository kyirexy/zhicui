export type DesktopBuildChannel = 'development' | 'beta' | 'stable';

export interface DesktopBuildIdentity {
  channel: DesktopBuildChannel;
  displayName: string;
  windowTitle: string;
}

export function desktopBuildIdentity(
  packaged: boolean,
  packagedChannel: 'beta' | 'stable' = 'beta',
): DesktopBuildIdentity {
  if (packaged) {
    if (packagedChannel === 'beta') {
      return {
        channel: 'beta',
        displayName: '知萃公测版',
        windowTitle: '知萃 · 公测版',
      };
    }
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
