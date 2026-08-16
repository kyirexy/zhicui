'use client';

import { useSettings } from '@/lib/hooks/SettingsContext';
import StylePicker from '@/components/StylePicker';
import { ProductPage, ProductPageHeader } from '@/components/ui/ProductUI';
import styles from './StylePage.module.css';

export default function StylePage() {
  const { settings, updateStyle, updateDensity } = useSettings();

  return (
    <ProductPage className={styles.page}>
      <ProductPageHeader title="卡片样式" />
      <div className={styles.picker}>
        <StylePicker
          currentStyle={settings.cardStyle}
          currentDensity={settings.density}
          onStyleChange={updateStyle}
          onDensityChange={updateDensity}
        />
      </div>
    </ProductPage>
  );
}
