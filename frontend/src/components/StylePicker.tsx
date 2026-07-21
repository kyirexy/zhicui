'use client';

import { useMemo, useState } from 'react';
import { CheckCircle, Gauge, Palette } from '@phosphor-icons/react';
import {
  CARD_STYLE_CONFIG,
  DENSITY_CONFIG,
  type CardType,
  type CardStyle,
  type DensityLevel,
} from '@/lib/types';
import { StyleIcon } from '@/lib/style-icons';
import StylePreview from './StylePreview';

interface StylePickerProps {
  currentStyle: CardStyle;
  currentDensity: DensityLevel;
  onStyleChange: (style: CardStyle) => void;
  onDensityChange: (density: DensityLevel) => void;
  globalStyle?: CardStyle;
  globalDensity?: DensityLevel;
  compact?: boolean;
  cardType?: CardType;
}

type StyleGroup = 'all' | 'reading' | 'expressive' | 'professional';

const STYLE_GROUPS: { key: StyleGroup; label: string; styles: CardStyle[] }[] = [
  { key: 'all', label: '全部', styles: Object.keys(CARD_STYLE_CONFIG) as CardStyle[] },
  { key: 'reading', label: '清晰阅读', styles: ['minimal', 'standard', 'compact', 'paper'] },
  { key: 'expressive', label: '视觉表达', styles: ['hero', 'creative', 'magazine', 'aurora'] },
  { key: 'professional', label: '专业呈现', styles: ['blueprint'] },
];

const RECOMMENDED_STYLES: Record<CardType, CardStyle[]> = {
  recipe: ['paper', 'standard'],
  insight: ['hero', 'minimal', 'aurora'],
  history: ['magazine', 'paper'],
  product: ['creative', 'standard'],
  plan: ['blueprint', 'compact'],
  general: ['standard', 'paper'],
};

export default function StylePicker({
  currentStyle,
  currentDensity,
  onStyleChange,
  onDensityChange,
  globalStyle,
  globalDensity,
  compact = false,
  cardType = 'general',
}: StylePickerProps) {
  const [activeGroup, setActiveGroup] = useState<StyleGroup>('all');
  const visibleStyles = useMemo(() => {
    const keys = STYLE_GROUPS.find((group) => group.key === activeGroup)?.styles ?? [];
    return keys.map((key) => CARD_STYLE_CONFIG[key]);
  }, [activeGroup]);
  const recommended = RECOMMENDED_STYLES[cardType];

  return (
    <div className={`style-picker ${compact ? 'is-compact' : ''}`}>
      <section className="style-picker__section" aria-labelledby="style-picker-title">
        <div className="style-picker__heading">
          <Palette size={17} weight="duotone" />
          <div>
            <h3 id="style-picker-title">卡片视觉</h3>
            <p>选择接近真实成片的缩略预览</p>
          </div>
        </div>

        <div className="style-picker__filters" role="group" aria-label="按用途筛选卡片主题">
          {STYLE_GROUPS.map((group) => (
            <button
              key={group.key}
              type="button"
              className={activeGroup === group.key ? 'is-active' : ''}
              onClick={() => setActiveGroup(group.key)}
              aria-pressed={activeGroup === group.key}
            >
              {group.label}
              <span>{group.styles.length}</span>
            </button>
          ))}
        </div>

        <div className="style-picker__grid">
          {visibleStyles.map((meta) => {
            const active = currentStyle === meta.key;
            const isGlobal = globalStyle === meta.key;
            const isRecommended = recommended.includes(meta.key);
            return (
              <button
                key={meta.key}
                type="button"
                className={`style-choice ${active ? 'is-active' : ''}`}
                onClick={() => onStyleChange(meta.key)}
                aria-pressed={active}
                aria-label={`选择${meta.label}风格：${meta.description}`}
              >
                <StylePreview style={meta.key} active={active} />
                <span className="style-choice__copy">
                  <span className="style-choice__name">
                    <StyleIcon style={meta.key} active={active} size={18} />
                    <strong>{meta.label}</strong>
                    {isRecommended && (
                      <span className="style-choice__recommended">适合当前内容</span>
                    )}
                    {isGlobal && globalStyle !== currentStyle && (
                      <span className="style-choice__default">默认</span>
                    )}
                  </span>
                  <span className="style-choice__description">{meta.description}</span>
                </span>
                {active && (
                  <CheckCircle className="style-choice__check" size={21} weight="fill" aria-hidden />
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="style-picker__section" aria-labelledby="density-picker-title">
        <div className="style-picker__heading">
          <Gauge size={17} weight="duotone" />
          <div>
            <h3 id="density-picker-title">信息密度</h3>
            <p>控制卡片留白与每屏信息量</p>
          </div>
        </div>
        <div className="density-picker">
          {(Object.entries(DENSITY_CONFIG) as [DensityLevel, (typeof DENSITY_CONFIG)[DensityLevel]][]).map(
            ([key, meta]) => {
              const active = currentDensity === key;
              const isGlobal = globalDensity === key;
              return (
                <button
                  key={key}
                  type="button"
                  className={`density-choice ${active ? 'is-active' : ''}`}
                  onClick={() => onDensityChange(key)}
                  aria-pressed={active}
                >
                  <span className="density-choice__bars" aria-hidden>
                    <i /><i /><i />
                  </span>
                  <span>
                    <strong>{meta.label}</strong>
                    <small>{meta.description}</small>
                  </span>
                  {isGlobal && globalDensity !== currentDensity && (
                    <span className="density-choice__default">默认</span>
                  )}
                </button>
              );
            },
          )}
        </div>
      </section>
    </div>
  );
}
