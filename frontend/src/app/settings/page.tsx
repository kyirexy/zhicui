'use client';

import {
  Check,
  Cpu,
  Globe,
  Monitor,
  RotateCcw,
  Rows3,
  Rows4,
  Smartphone,
} from 'lucide-react';
import AppUpdateSettingsCard from '@/components/AppUpdateSettingsCard';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import ThemeSelector from '@/components/theme/ThemeSelector';
import { useSettings } from '@/lib/hooks/SettingsContext';
import type { DesktopLayoutDensity } from '@/lib/types';

const WEB_APP_VERSION = '1.1.9';

const DENSITY_OPTIONS: Array<{
  value: DesktopLayoutDensity;
  label: string;
  description: string;
  icon: typeof Rows3;
}> = [
  {
    value: 'comfortable',
    label: '舒展',
    description: '留白更充足',
    icon: Rows3,
  },
  {
    value: 'compact',
    label: '紧凑',
    description: '同屏内容更多',
    icon: Rows4,
  },
];

export default function SettingsPage() {
  const { isDesktop } = useDesktopApp();
  const {
    settings,
    updateDesktopDensity,
    resetDesktopAppearance,
  } = useSettings();

  return (
    <div className="desktop-core-page desktop-settings-page mx-auto max-w-3xl pb-4 md:pb-24">
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-3xl font-bold text-foreground text-balance">设置</h1>
        <p className="text-foreground-muted text-sm mt-1 text-pretty">调整外观，管理更新与连接状态</p>
      </div>

      <div className="space-y-4">
        <section className="settings-product-card">
          <div className="settings-product-card__identity">
            <img src="/icons/icon-192.png" alt="" width="48" height="48" />
            <div>
              <p className="text-base font-semibold text-foreground">知萃 KnowBrew</p>
              <p className="text-xs text-foreground-muted mt-0.5">Web v{WEB_APP_VERSION}</p>
            </div>
          </div>
          <p>
            把抖音收藏、喜欢和自己的作品整理成完整文案，再继续提问、生成知识卡或行动计划。
          </p>
        </section>

        <section className="appearance-settings-card" aria-labelledby="appearance-settings-title">
          <header className="appearance-settings-card__header">
            <div>
              <span className="appearance-settings-card__eyebrow">
                {isDesktop ? '当前 Windows 设备' : '当前设备'}
              </span>
              <h2 id="appearance-settings-title">外观与布局</h2>
              <p>只保留三种主题，选择后立即生效并保存在这台设备。</p>
            </div>
            <button
              type="button"
              className="appearance-settings-card__reset"
              onClick={resetDesktopAppearance}
            >
              <RotateCcw size={15} aria-hidden="true" />
              恢复默认
            </button>
          </header>

          <div className="appearance-settings-card__body">
            <fieldset className="appearance-control-group">
              <legend>应用主题</legend>
              <ThemeSelector />
            </fieldset>

            <fieldset className="appearance-control-group">
              <legend>桌面布局</legend>
              <div className="appearance-option-grid">
                {DENSITY_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = settings.desktopDensity === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`appearance-option ${selected ? 'is-selected' : ''}`}
                      onClick={() => updateDesktopDensity(option.value)}
                    >
                      <span className="appearance-option__icon" aria-hidden="true">
                        <Icon size={18} />
                      </span>
                      <span className="appearance-option__copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span className="appearance-option__check" aria-hidden="true">
                        {selected && <Check size={14} strokeWidth={2.4} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

          </div>
        </section>

        <AppUpdateSettingsCard />

        <section className="settings-info-list">
          <div className="flex items-center gap-3">
            <Smartphone size={18} className="text-accent-emerald flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">连接方式</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                正式版通过 HTTPS 安全连接 luxai.cn，登录状态保存在当前设备
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Globe size={18} className="text-foreground-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">Web 版</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                网页端、Android 与 Windows 桌面端共用账号、视频资料库、知识卡和计划
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Monitor size={18} className="text-foreground-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">Windows 桌面端</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                支持在本机 Chrome 或 Edge 完成抖音扫码，启动后自动检查新版
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Cpu size={18} className="text-foreground-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">AI 引擎</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                使用管理端当前启用的模型配置，切换模型后无需重新安装 App
              </p>
            </div>
          </div>
        </section>

        <div className="settings-footnote">
          <p className="text-xs text-foreground-muted leading-relaxed text-center">
            Android 与 Windows 桌面端会自动检查新版，也可以随时在本页手动检查。
          </p>
        </div>
      </div>
    </div>
  );
}
