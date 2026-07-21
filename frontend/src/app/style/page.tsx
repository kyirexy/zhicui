'use client';

import { Sparkle } from '@phosphor-icons/react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import StylePicker from '@/components/StylePicker';

export default function StylePage() {
  const { settings, updateStyle, updateDensity } = useSettings();

  return (
    <div className="style-page max-w-5xl mx-auto pb-24">
      <header className="style-page__hero">
        <span className="style-page__mark"><Sparkle size={22} weight="fill" /></span>
        <div>
          <p>YOUR VISUAL SYSTEM</p>
          <h1>选一种更像作品的卡片</h1>
          <span>9 套视觉主题，兼顾手机阅读、网页展示与长图导出。</span>
        </div>
      </header>

      <StylePicker
        currentStyle={settings.cardStyle}
        currentDensity={settings.density}
        onStyleChange={updateStyle}
        onDensityChange={updateDensity}
      />
    </div>
  );
}
