'use client';

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocalStorage } from './useLocalStorage';
import {
  type UserSettings,
  type CardStyle,
  type DensityLevel,
  type AppTheme,
  type DesktopLayoutDensity,
  DEFAULT_USER_SETTINGS,
} from '@/lib/types';

interface SettingsContextValue {
  settings: UserSettings;
  effectiveTheme: Exclude<AppTheme, 'system'>;
  updateStyle: (style: CardStyle) => void;
  updateDensity: (density: DensityLevel) => void;
  updateTheme: (theme: AppTheme) => void;
  updateDesktopDensity: (density: DesktopLayoutDensity) => void;
  resetDesktopAppearance: () => void;
  resetSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const THEME_OPTIONS = new Set<AppTheme>([
  'light',
  'dark',
  'system',
]);
const DESKTOP_DENSITY_OPTIONS = new Set<DesktopLayoutDensity>([
  'comfortable',
  'compact',
]);

function resolveLegacyTheme(value: Partial<UserSettings>): AppTheme {
  if (THEME_OPTIONS.has(value.theme as AppTheme)) {
    return value.theme as AppTheme;
  }

  if (typeof window !== 'undefined') {
    const legacyGlobalTheme = window.localStorage.getItem('theme');
    if (THEME_OPTIONS.has(legacyGlobalTheme as AppTheme)) {
      return legacyGlobalTheme as AppTheme;
    }
  }

  if (THEME_OPTIONS.has(value.desktopSidebar as AppTheme)) {
    return value.desktopSidebar as AppTheme;
  }

  return DEFAULT_USER_SETTINGS.theme;
}

function normalizeSettings(value: UserSettings): UserSettings {
  const {
    desktopSidebar: _legacyDesktopSidebar,
    ...currentValue
  } = value ?? DEFAULT_USER_SETTINGS;

  return {
    ...DEFAULT_USER_SETTINGS,
    ...currentValue,
    theme: resolveLegacyTheme(value ?? DEFAULT_USER_SETTINGS),
    desktopDensity: DESKTOP_DENSITY_OPTIONS.has(value?.desktopDensity)
      ? value.desktopDensity
      : DEFAULT_USER_SETTINGS.desktopDensity,
  };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [storedSettings, setSettings] = useLocalStorage<UserSettings>(
    'videocapsule-settings',
    DEFAULT_USER_SETTINGS,
  );
  const settings = useMemo(
    () => normalizeSettings(storedSettings),
    [storedSettings],
  );
  const [effectiveTheme, setEffectiveTheme] = useState<Exclude<AppTheme, 'system'>>('light');

  useEffect(() => {
    if (
      storedSettings.theme !== settings.theme
      || 'desktopSidebar' in storedSettings
      || storedSettings.desktopDensity !== settings.desktopDensity
    ) {
      setSettings(settings);
    }
  }, [setSettings, settings, storedSettings]);

  useEffect(() => {
    const root = document.documentElement;
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      const resolvedTheme = settings.theme === 'system'
        ? (systemTheme.matches ? 'dark' : 'light')
        : settings.theme;

      root.setAttribute('data-theme', resolvedTheme);
      root.setAttribute('data-theme-preference', settings.theme);
      // Keep the old attribute during one migration release so existing
      // desktop CSS and already-open windows cannot render a mixed palette.
      root.setAttribute('data-desktop-sidebar', resolvedTheme);
      root.style.colorScheme = resolvedTheme;
      setEffectiveTheme(resolvedTheme);

      try {
        window.localStorage.setItem('theme', settings.theme);
      } catch {
        // A blocked storage write must not stop the visual preference applying.
      }
    };

    applyTheme();
    systemTheme.addEventListener('change', applyTheme);
    root.setAttribute('data-desktop-density', settings.desktopDensity);
    return () => systemTheme.removeEventListener('change', applyTheme);
  }, [settings.desktopDensity, settings.theme]);

  const updateStyle = useCallback(
    (style: CardStyle) => setSettings((prev) => ({ ...normalizeSettings(prev), cardStyle: style })),
    [setSettings],
  );

  const updateDensity = useCallback(
    (density: DensityLevel) => setSettings((prev) => ({ ...normalizeSettings(prev), density })),
    [setSettings],
  );

  const updateTheme = useCallback(
    (theme: AppTheme) => (
      setSettings((prev) => ({ ...normalizeSettings(prev), theme }))
    ),
    [setSettings],
  );

  const updateDesktopDensity = useCallback(
    (desktopDensity: DesktopLayoutDensity) => (
      setSettings((prev) => ({ ...normalizeSettings(prev), desktopDensity }))
    ),
    [setSettings],
  );

  const resetDesktopAppearance = useCallback(
    () => setSettings((prev) => ({
      ...normalizeSettings(prev),
      theme: DEFAULT_USER_SETTINGS.theme,
      desktopDensity: DEFAULT_USER_SETTINGS.desktopDensity,
    })),
    [setSettings],
  );

  const resetSettings = useCallback(
    () => setSettings(DEFAULT_USER_SETTINGS),
    [setSettings],
  );

  return (
    <SettingsContext.Provider
      value={{
        settings,
        effectiveTheme,
        updateStyle,
        updateDensity,
        updateTheme,
        updateDesktopDensity,
        resetDesktopAppearance,
        resetSettings,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error('useSettings must be used within a <SettingsProvider>');
  }
  return ctx;
}
