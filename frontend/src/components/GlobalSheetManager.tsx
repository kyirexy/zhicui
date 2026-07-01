'use client';

import { useEffect, useState } from 'react';
import { Monitor, Zap, Settings, Smartphone } from 'lucide-react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { CARD_STYLE_CONFIG, DENSITY_CONFIG, type CardStyle, type DensityLevel } from '@/lib/types';
import { STYLE_ICONS } from '@/lib/style-icons';
import BottomSheet from './BottomSheet';

/**
 * Globally-mounted listener for BottomTabBar "风格" and "设置" tab events.
 *
 * StyleToolbar also has its own sheet (when rendered inside a card view), but
 * that instance only exists when a card is showing. This global fallback
 * ensures the tabs always respond, even on pages without a rendered card.
 */
export default function GlobalSheetManager() {
  const { settings } = useSettings();
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);

  const [styleOverride, setStyleOverride] = useState<CardStyle | null>(null);
  const [densityOverride, setDensityOverride] = useState<DensityLevel | null>(null);

  const effectiveStyle = styleOverride ?? settings.cardStyle;
  const effectiveDensity = densityOverride ?? settings.density;

  useEffect(() => {
    const onStyle = () => setStyleSheetOpen(true);
    const onSettings = () => setSettingsSheetOpen(true);
    window.addEventListener('vc:open-style-sheet', onStyle);
    window.addEventListener('vc:open-settings-sheet', onSettings);
    return () => {
      window.removeEventListener('vc:open-style-sheet', onStyle);
      window.removeEventListener('vc:open-settings-sheet', onSettings);
    };
  }, []);

  return (
    <>
      {/* ---- Style sheet ---- */}
      <BottomSheet open={styleSheetOpen} onClose={() => setStyleSheetOpen(false)} title="卡片风格">
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={14} className="text-foreground-muted" />
            <span className="text-xs font-medium text-foreground-muted uppercase tracking-wide">风格</span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {Object.values(CARD_STYLE_CONFIG).map((meta) => {
              const isActive = effectiveStyle === meta.key;
              return (
                <button key={meta.key} type="button"
                  onClick={() => setStyleOverride(isActive ? null : meta.key)}
                  className={`flex items-start gap-3 p-3 rounded-2xl text-left transition-all duration-200 min-h-[64px] ${
                    isActive ? 'bg-accent-emerald/15 border-2 border-accent-emerald/60 text-foreground' : 'bg-card-bg border-2 border-card-border text-foreground-secondary hover:border-foreground-muted/30'
                  }`}>
                  <span className="text-2xl leading-none flex-shrink-0 text-accent-emerald">{STYLE_ICONS[meta.key]}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground">{meta.label}</span>
                    <span className="block text-[11px] text-foreground-muted mt-0.5 leading-snug line-clamp-2">{meta.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
        <section>
          <div className="flex items-center gap-2 mb-3">
            <Zap size={14} className="text-foreground-muted" />
            <span className="text-xs font-medium text-foreground-muted uppercase tracking-wide">密度</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(DENSITY_CONFIG) as [DensityLevel, typeof DENSITY_CONFIG[DensityLevel]][]).map(([key, meta]) => {
              const isActive = effectiveDensity === key;
              return (
                <button key={key} type="button"
                  onClick={() => setDensityOverride(isActive ? null : key)}
                  className={`flex flex-col items-center justify-center px-3 py-2.5 rounded-2xl text-center transition-all duration-200 min-h-[56px] ${
                    isActive ? 'bg-accent-emerald/15 border-2 border-accent-emerald/60' : 'bg-card-bg border-2 border-card-border text-foreground-secondary hover:border-foreground-muted/30'
                  }`}>
                  <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                  <span className="text-[10px] text-foreground-muted mt-0.5 leading-tight">{meta.description}</span>
                </button>
              );
            })}
          </div>
        </section>
      </BottomSheet>

      {/* ---- Settings sheet ---- */}
      <BottomSheet open={settingsSheetOpen} onClose={() => setSettingsSheetOpen(false)} title="设置">
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-card-bg border border-card-border">
            <div className="flex items-center gap-3">
              <Smartphone size={18} className="text-accent-emerald" />
              <div>
                <p className="text-sm font-semibold text-foreground">知萃 KnowBrew</p>
                <p className="text-xs text-foreground-muted mt-0.5">视频知识卡片提取工具 v0.1.0</p>
              </div>
            </div>
          </div>
          <div className="p-4 rounded-2xl bg-card-bg border border-card-border">
            <p className="text-xs text-foreground-muted leading-relaxed">
              连接 PC 后端以使用完整功能。确保手机与电脑在同一网络，或通过 USB 连接并使用 adb reverse。
            </p>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
