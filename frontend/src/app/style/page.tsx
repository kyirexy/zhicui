'use client';

import { useSettings } from '@/lib/hooks/SettingsContext';
import { CARD_STYLE_CONFIG, DENSITY_CONFIG, type CardStyle, type DensityLevel } from '@/lib/types';
import { Monitor, Zap } from 'lucide-react';
import { STYLE_ICONS } from '@/lib/style-icons';

export default function StylePage() {
  const { settings, updateStyle, updateDensity } = useSettings();

  return (
    <div className="max-w-2xl mx-auto pb-24">
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-3xl font-bold text-foreground tracking-tight">卡片风格</h1>
        <p className="text-foreground-muted text-sm mt-1">选择你喜欢的卡片展示方式</p>
      </div>

      <section className="mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Monitor size={16} className="text-foreground-muted" />
          <span className="text-sm font-semibold text-foreground">风格预设</span>
        </div>
        <div className="space-y-3">
          {Object.values(CARD_STYLE_CONFIG).map((meta) => {
            const isActive = settings.cardStyle === meta.key;
            return (
              <button key={meta.key} type="button" onClick={() => updateStyle(meta.key)}
                className={`w-full flex items-start gap-4 p-4 rounded-2xl text-left transition-all duration-200 ${
                  isActive
                    ? 'bg-accent-emerald/10 border-2 border-accent-emerald/40'
                    : 'bg-card-bg border-2 border-card-border hover:border-foreground-muted/20'
                }`}>
                <span className="text-accent-emerald flex-shrink-0">{STYLE_ICONS[meta.key]}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-base font-semibold text-foreground">
                    {meta.label}
                    {isActive && <span className="ml-2 text-xs text-accent-emerald">当前</span>}
                  </span>
                  <span className="block text-sm text-foreground-muted mt-1 leading-relaxed">{meta.description}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-4">
          <Zap size={16} className="text-foreground-muted" />
          <span className="text-sm font-semibold text-foreground">信息密度</span>
        </div>
        <div className="space-y-3">
          {(Object.entries(DENSITY_CONFIG) as [DensityLevel, typeof DENSITY_CONFIG[DensityLevel]][]).map(([key, meta]) => {
            const isActive = settings.density === key;
            return (
              <button key={key} type="button" onClick={() => updateDensity(key)}
                className={`w-full flex items-center gap-4 p-4 rounded-2xl text-left transition-all duration-200 ${
                  isActive
                    ? 'bg-accent-emerald/10 border-2 border-accent-emerald/40'
                    : 'bg-card-bg border-2 border-card-border hover:border-foreground-muted/20'
                }`}>
                <span className="text-sm font-semibold text-foreground min-w-[48px]">{meta.label}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-foreground-secondary">{meta.description}</span>
                </span>
                {isActive && <span className="text-xs text-accent-emerald flex-shrink-0">当前</span>}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
