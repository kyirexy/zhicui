'use client';

import { useEffect, useState } from 'react';
import { CaretDown, SlidersHorizontal } from '@phosphor-icons/react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { CARD_STYLE_CONFIG, DENSITY_CONFIG, type CardStyle, type CardType, type DensityLevel } from '@/lib/types';
import { StyleIcon } from '@/lib/style-icons';
import StylePreview from './StylePreview';
import StylePicker from './StylePicker';
import BottomSheet from './BottomSheet';

interface StyleToolbarProps {
  styleOverride: CardStyle | null;
  densityOverride: DensityLevel | null;
  onStyleOverride: (style: CardStyle | null) => void;
  onDensityOverride: (density: DensityLevel | null) => void;
  cardType?: CardType;
}

export default function StyleToolbar({
  styleOverride,
  densityOverride,
  onStyleOverride,
  onDensityOverride,
  cardType,
}: StyleToolbarProps) {
  const { settings } = useSettings();
  const [sheetOpen, setSheetOpen] = useState(false);
  const effectiveStyle = styleOverride ?? settings.cardStyle;
  const effectiveDensity = densityOverride ?? settings.density;
  const styleMeta = CARD_STYLE_CONFIG[effectiveStyle];
  const densityMeta = DENSITY_CONFIG[effectiveDensity];

  useEffect(() => {
    const onOpen = () => setSheetOpen(true);
    window.addEventListener('vc:open-style-sheet', onOpen);
    return () => window.removeEventListener('vc:open-style-sheet', onOpen);
  }, []);

  const pickStyle = (style: CardStyle) => {
    onStyleOverride(style === settings.cardStyle ? null : style);
  };

  const pickDensity = (density: DensityLevel) => {
    onDensityOverride(density === settings.density ? null : density);
  };

  return (
    <>
      <div className="style-toolbar-mobile md:hidden">
        <button type="button" className="style-toolbar-trigger" onClick={() => setSheetOpen(true)}>
          <StylePreview style={effectiveStyle} active compact />
          <span className="style-toolbar-trigger__copy">
            <span className="style-toolbar-trigger__eyebrow">
              <SlidersHorizontal size={14} weight="duotone" /> 当前卡片外观
            </span>
            <strong>
              <StyleIcon style={effectiveStyle} active size={17} />
              {styleMeta.label} · {densityMeta.label}
            </strong>
          </span>
          <CaretDown size={18} aria-hidden />
        </button>
      </div>

      <div className="style-toolbar-desktop hidden md:block">
        <button
          type="button"
          className="style-toolbar-trigger style-toolbar-trigger--desktop"
          onClick={() => setSheetOpen(true)}
        >
          <StylePreview style={effectiveStyle} active compact />
          <span className="style-toolbar-trigger__copy">
            <span className="style-toolbar-trigger__eyebrow">
              <SlidersHorizontal size={14} weight="duotone" /> 卡片外观
            </span>
            <strong>
              <StyleIcon style={effectiveStyle} active size={17} />
              {styleMeta.label} · {densityMeta.label}
            </strong>
          </span>
          <span className="style-toolbar-trigger__aside">9 套主题，按需切换</span>
          <CaretDown size={18} aria-hidden />
        </button>
        {(styleOverride !== null || densityOverride !== null) && (
          <p className="style-toolbar-note">当前只覆盖这张卡片；选择带“默认”的选项即可恢复全局设置。</p>
        )}
      </div>

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="卡片外观">
        <StylePicker
          currentStyle={effectiveStyle}
          currentDensity={effectiveDensity}
          onStyleChange={pickStyle}
          onDensityChange={pickDensity}
          globalStyle={settings.cardStyle}
          globalDensity={settings.density}
          cardType={cardType}
        />
        {(styleOverride !== null || densityOverride !== null) && (
          <p className="style-toolbar-note">此处是当前卡片的临时外观，不会覆盖你的全局偏好。</p>
        )}
      </BottomSheet>
    </>
  );
}
