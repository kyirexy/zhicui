import { homedir } from 'node:os';
import { join, win32, posix } from 'node:path';

export function supportsDesktopBridge(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

export function desktopBridgeDirectory(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  localAppData = process.env.LOCALAPPDATA,
): string {
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'Zhicui');
  if (platform === 'win32') return win32.join(localAppData || win32.join(home, 'AppData', 'Local'), 'Zhicui');
  return join(home, '.cache', 'Zhicui');
}
