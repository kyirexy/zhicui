'use client';

import { useEffect, useState } from 'react';
import { DeviceMobile, Sparkle } from '@phosphor-icons/react';
import { useSettings } from '@/lib/hooks/SettingsContext';
import StylePicker from './StylePicker';
import BottomSheet from './BottomSheet';

/** Keeps the mobile bottom tabs useful even when no card is currently mounted. */
export default function GlobalSheetManager() {
  const { settings, updateStyle, updateDensity } = useSettings();
  const [styleSheetOpen, setStyleSheetOpen] = useState(false);
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false);

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
      <BottomSheet open={styleSheetOpen} onClose={() => setStyleSheetOpen(false)} title="全局卡片外观">
        <StylePicker
          currentStyle={settings.cardStyle}
          currentDensity={settings.density}
          onStyleChange={updateStyle}
          onDensityChange={updateDensity}
        />
        <p className="style-toolbar-note">选择会自动保存，后续生成和打开的卡片都会使用这套外观。</p>
      </BottomSheet>

      <BottomSheet open={settingsSheetOpen} onClose={() => setSettingsSheetOpen(false)} title="设置">
        <div className="global-settings-sheet">
          <div className="global-settings-card">
            <span className="global-settings-card__icon"><Sparkle size={21} weight="duotone" /></span>
            <div>
              <strong>知萃 VideoCapsule</strong>
              <p>把长内容，萃取成可以继续探索的知识卡片。</p>
            </div>
          </div>
          <div className="global-settings-card">
            <span className="global-settings-card__icon"><DeviceMobile size={21} weight="duotone" /></span>
            <div>
              <strong>移动端连接</strong>
              <p>手机与电脑处于同一网络时可连接本地服务；生产版会自动使用 luxai.cn。</p>
            </div>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
