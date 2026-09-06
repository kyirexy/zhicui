interface ThemeWindow {
  setBackgroundColor(color: string): void;
  setTitleBarOverlay?: (options: { color: string; symbolColor: string; height: number }) => void;
}

export function applyWindowTheme(platform: NodeJS.Platform, window: ThemeWindow, theme: string): boolean {
  if (theme !== 'light' && theme !== 'dark') return false;
  const dark = theme === 'dark';
  // macOS 使用系统原生标题栏，没有 Windows 的 overlay 方法。
  if (platform !== 'darwin' && typeof window.setTitleBarOverlay === 'function') {
    window.setTitleBarOverlay({
      color: dark ? '#111714' : '#f5f7f6',
      symbolColor: dark ? '#e9efeb' : '#26312b',
      height: 34,
    });
  }
  window.setBackgroundColor(dark ? '#111714' : '#f5f7f6');
  return true;
}
