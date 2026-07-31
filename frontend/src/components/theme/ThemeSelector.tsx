'use client';

import { LaptopMinimal, Moon, Sun } from 'lucide-react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import type { AppTheme } from '@/lib/types';

const THEME_OPTIONS: Array<{
  value: AppTheme;
  label: string;
  description: string;
  icon: typeof Sun;
}> = [
  {
    value: 'system',
    label: '跟随系统',
    description: '随设备明暗自动切换',
    icon: LaptopMinimal,
  },
  {
    value: 'light',
    label: '浅色',
    description: '白色为主，轻薄荷点缀',
    icon: Sun,
  },
  {
    value: 'dark',
    label: '深色',
    description: '夜间更柔和',
    icon: Moon,
  },
];

export default function ThemeSelector({
  variant = 'cards',
}: {
  variant?: 'cards' | 'compact';
}) {
  const { settings, updateTheme } = useSettings();

  if (variant === 'compact') {
    const selected = THEME_OPTIONS.find((option) => option.value === settings.theme)
      ?? THEME_OPTIONS[1];
    const SelectedIcon = selected.icon;

    return (
      <label className="theme-select-compact" title={`主题：${selected.label}`}>
        <SelectedIcon size={17} aria-hidden="true" />
        <span className="sr-only">应用主题</span>
        <select
          value={settings.theme}
          onChange={(event) => updateTheme(event.target.value as AppTheme)}
          aria-label="应用主题"
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <div className="theme-choice-grid" role="radiogroup" aria-label="应用主题">
      {THEME_OPTIONS.map((option) => {
        const Icon = option.icon;
        const selected = settings.theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-choice ${selected ? 'is-selected' : ''}`}
            onClick={() => updateTheme(option.value)}
          >
            <span className="theme-choice__preview" data-preview-theme={option.value} aria-hidden="true">
              <span className="theme-choice__preview-rail" />
              <span className="theme-choice__preview-body">
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="theme-choice__label">
              <span className="theme-choice__icon" aria-hidden="true">
                <Icon size={17} />
              </span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
