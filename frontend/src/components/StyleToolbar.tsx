'use client';

import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { CARD_STYLE_CONFIG, DENSITY_CONFIG, type CardStyle, type DensityLevel } from '@/lib/types';
import { STYLE_ICONS } from '@/lib/style-icons';
import { Monitor, Zap, ChevronDown } from 'lucide-react';
import BottomSheet from './BottomSheet';

interface StyleToolbarProps {
  styleOverride: CardStyle | null;
  densityOverride: DensityLevel | null;
  onStyleOverride: (style: CardStyle | null) => void;
  onDensityOverride: (density: DensityLevel | null) => void;
}

export default function StyleToolbar({
  styleOverride,
  densityOverride,
  onStyleOverride,
  onDensityOverride,
}: StyleToolbarProps) {
  const { settings } = useSettings();

  const effectiveStyle = styleOverride ?? settings.cardStyle;
  const effectiveDensity = densityOverride ?? settings.density;

  const isOverriding = styleOverride !== null || densityOverride !== null;

  // Mobile sheet open state. Triggered locally by the trigger button OR
  // globally by the BottomTabBar "风格" tab dispatching `vc:open-style-sheet`.
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setSheetOpen(true);
    window.addEventListener('vc:open-style-sheet', onOpen);
    return () => window.removeEventListener('vc:open-style-sheet', onOpen);
  }, []);

  const currentStyleMeta = CARD_STYLE_CONFIG[effectiveStyle];
  const currentDensityMeta = DENSITY_CONFIG[effectiveDensity];

  return (
    <>
      {/* === Mobile (< md): collapsed trigger button === */}
      <div className="md:hidden mb-4">
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-label="调整卡片风格与密度"
          className="w-full flex items-center justify-between gap-3 px-4 py-3
                     rounded-2xl bg-card-bg border border-card-border
                     text-foreground-secondary hover:text-foreground
                     hover:border-foreground-muted/30 transition-all duration-200
                     min-h-[48px]"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Monitor size={14} className="text-foreground-muted" />
            <span>风格</span>
            <span className="inline-flex items-center gap-1 text-xs text-foreground-muted">
              <span className="text-base leading-none text-accent-emerald">{STYLE_ICONS[currentStyleMeta.key]}</span>
              <span>{currentStyleMeta.label}</span>
            </span>
            <span className="mx-1 text-foreground-muted/40">·</span>
            <Zap size={12} className="text-foreground-muted" />
            <span className="text-xs text-foreground-muted">{currentDensityMeta.label}</span>
          </span>
          <ChevronDown size={16} className="text-foreground-muted" />
        </button>
      </div>

      {/* === Desktop (≥ md): original inline chip rows === */}
      <div className="style-toolbar mb-5 hidden md:block">
        {/* Style row */}
        <div className="flex items-center gap-2 mb-3">
          <Monitor size={13} className="text-foreground-muted flex-shrink-0" />
          <span className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide mr-1">
            风格
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {Object.values(CARD_STYLE_CONFIG).map((meta) => {
              const isActive = effectiveStyle === meta.key;
              const isGlobal = meta.key === settings.cardStyle;
              return (
                <button
                  key={meta.key}
                  type="button"
                  onClick={() => {
                    if (meta.key === settings.cardStyle) {
                      onStyleOverride(null);
                    } else {
                      onStyleOverride(meta.key);
                    }
                  }}
                  className={`style-chip inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium
                    transition-all duration-200 whitespace-nowrap
                    ${isActive
                      ? 'bg-accent-emerald text-white shadow-[0_0_12px_rgba(16,185,129,0.25)]'
                      : 'bg-card-bg border border-card-border text-foreground-secondary hover:text-foreground hover:border-foreground-muted/30'
                    }`}
                  title={meta.description}
                >
                  <span className="text-sm leading-none text-accent-emerald">{STYLE_ICONS[meta.key]}</span>
                  <span>{meta.label}</span>
                  {isActive && !isGlobal && (
                    <span className="text-[10px] opacity-80">*</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Density row */}
        <div className="flex items-center gap-2">
          <Zap size={13} className="text-foreground-muted flex-shrink-0" />
          <span className="text-[11px] font-medium text-foreground-muted uppercase tracking-wide mr-1">
            密度
          </span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {(Object.entries(DENSITY_CONFIG) as [DensityLevel, typeof DENSITY_CONFIG[DensityLevel]][]).map(
              ([key, meta]) => {
                const isActive = effectiveDensity === key;
                const isGlobal = key === settings.density;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (key === settings.density) {
                        onDensityOverride(null);
                      } else {
                        onDensityOverride(key);
                      }
                    }}
                    className={`style-chip inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium
                      transition-all duration-200 whitespace-nowrap
                      ${isActive
                        ? 'bg-accent-emerald text-white shadow-[0_0_12px_rgba(16,185,129,0.25)]'
                        : 'bg-card-bg border border-card-border text-foreground-secondary hover:text-foreground hover:border-foreground-muted/30'
                      }`}
                    title={meta.description}
                  >
                    <span>{meta.label}</span>
                    {isActive && !isGlobal && (
                      <span className="text-[10px] opacity-80">*</span>
                    )}
                  </button>
                );
              },
            )}
          </div>
        </div>

        {/* Reset hint when overriding */}
        {isOverriding && (
          <p className="mt-2 text-[11px] text-foreground-muted">
            标记 * 的为当前笔记临时覆盖。点击已选中的选项可恢复全局默认。
          </p>
        )}
      </div>

      {/* === Mobile bottom sheet (rendered always; visibility via `sheetOpen`) === */}
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="卡片风格"
      >
        {/* Style grid — large touch targets */}
        <section className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={14} className="text-foreground-muted" />
            <span className="text-xs font-medium text-foreground-muted uppercase tracking-wide">
              风格
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {Object.values(CARD_STYLE_CONFIG).map((meta) => {
              const isActive = effectiveStyle === meta.key;
              const isGlobal = meta.key === settings.cardStyle;
              return (
                <button
                  key={meta.key}
                  type="button"
                  onClick={() => {
                    if (meta.key === settings.cardStyle) {
                      onStyleOverride(null);
                    } else {
                      onStyleOverride(meta.key);
                    }
                  }}
                  className={`flex items-start gap-3 p-3 rounded-2xl text-left
                    transition-all duration-200 min-h-[64px]
                    ${isActive
                      ? 'bg-accent-emerald/15 border-2 border-accent-emerald/60 text-foreground'
                      : 'bg-card-bg border-2 border-card-border text-foreground-secondary hover:border-foreground-muted/30'
                    }`}
                  aria-pressed={isActive}
                >
                  <span className="text-2xl leading-none flex-shrink-0 text-accent-emerald">{STYLE_ICONS[meta.key]}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground">
                      {meta.label}
                      {isActive && !isGlobal && (
                        <span className="ml-1 text-[10px] text-accent-emerald">*</span>
                      )}
                    </span>
                    <span className="block text-[11px] text-foreground-muted mt-0.5 leading-snug line-clamp-2">
                      {meta.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Density row — also chunky */}
        <section className="mb-2">
          <div className="flex items-center gap-2 mb-3">
            <Zap size={14} className="text-foreground-muted" />
            <span className="text-xs font-medium text-foreground-muted uppercase tracking-wide">
              密度
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(DENSITY_CONFIG) as [DensityLevel, typeof DENSITY_CONFIG[DensityLevel]][]).map(
              ([key, meta]) => {
                const isActive = effectiveDensity === key;
                const isGlobal = key === settings.density;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (key === settings.density) {
                        onDensityOverride(null);
                      } else {
                        onDensityOverride(key);
                      }
                    }}
                    className={`flex flex-col items-center justify-center px-3 py-2.5
                      rounded-2xl text-center transition-all duration-200 min-h-[56px]
                      ${isActive
                        ? 'bg-accent-emerald/15 border-2 border-accent-emerald/60 text-foreground'
                        : 'bg-card-bg border-2 border-card-border text-foreground-secondary hover:border-foreground-muted/30'
                      }`}
                    aria-pressed={isActive}
                  >
                    <span className="text-sm font-semibold text-foreground">
                      {meta.label}
                      {isActive && !isGlobal && (
                        <span className="ml-0.5 text-[10px] text-accent-emerald">*</span>
                      )}
                    </span>
                    <span className="text-[10px] text-foreground-muted mt-0.5 leading-tight">
                      {meta.description}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        </section>

        {isOverriding && (
          <p className="mt-4 text-[11px] text-foreground-muted text-center">
            标记 * 为当前笔记临时覆盖。再次点击已选中的选项可恢复全局默认。
          </p>
        )}
      </BottomSheet>
    </>
  );
}
