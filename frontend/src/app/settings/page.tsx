'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowsClockwise,
  ChatCircleDots,
  Cpu,
  GearSix,
  HardDrives,
  Info,
  MagnifyingGlass,
  PaintBrushBroad,
  SignOut,
  ShieldCheck,
  UserCircle,
  X,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import {
  Check,
  RotateCcw,
  Rows3,
  Rows4,
} from 'lucide-react';
import AppUpdateSettingsCard from '@/components/AppUpdateSettingsCard';
import AccountDataSettingsCard from '@/components/AccountDataSettingsCard';
import AgentSourceLimitSettingsCard from '@/components/AgentSourceLimitSettingsCard';
import AutoSyncSettingsCard from '@/components/AutoSyncSettingsCard';
import DesktopMediaSettingsCard from '@/components/DesktopMediaSettingsCard';
import LocalDataSettingsCard from '@/components/LocalDataSettingsCard';
import QuickSyncSettingsCard from '@/components/QuickSyncSettingsCard';
import UserAIProviderSettingsCard from '@/components/UserAIProviderSettingsCard';
import UserCustomModelsSettingsCard from '@/components/UserCustomModelsSettingsCard';
import UserVisionProviderSettingsCard from '@/components/UserVisionProviderSettingsCard';
import ClientCapabilitySettingsCard from '@/components/ClientCapabilitySettingsCard';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import ThemeSelector from '@/components/theme/ThemeSelector';
import { isNativeAndroidApp } from '@/lib/douyinNative';
import { useAuth } from '@/lib/hooks/AuthContext';
import { useSettings } from '@/lib/hooks/SettingsContext';
import { useIsMobile } from '@/lib/hooks/useMediaQuery';
import type { DesktopLayoutDensity } from '@/lib/types';
import styles from './SettingsWorkspace.module.css';

const WEB_APP_VERSION = '1.1.10';

type SettingsSectionId = 'general' | 'account' | 'appearance' | 'storage' | 'sync' | 'models' | 'ai' | 'about';

interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  description: string;
  keywords: string;
  icon: PhosphorIcon;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'general',
    label: '常规',
    description: '当前设备和账号同步状态',
    keywords: '应用 设备 连接 版本 桌面端 网页端',
    icon: GearSix,
  },
  {
    id: 'account',
    label: '账号与数据',
    description: '导出个人数据、法律信息和账号注销',
    keywords: '账号 隐私 协议 数据 导出 下载 注销 删除 投诉 支持',
    icon: ShieldCheck,
  },
  {
    id: 'appearance',
    label: '外观',
    description: '调整主题和内容间距',
    keywords: '主题 深色 浅色 系统 紧凑 舒展',
    icon: PaintBrushBroad,
  },
  {
    id: 'storage',
    label: '存储与缓存',
    description: '管理首页缓存和本地视频文件',
    keywords: '本地 存储 缓存 首页 视频 下载 文件 备份',
    icon: HardDrives,
  },
  {
    id: 'sync',
    label: '同步与问答',
    description: '手动更新多渠道视频并控制问答列表数量',
    keywords: '同步 手动 风控 抖音 收藏 喜欢 作品 视频 数量 问答',
    icon: ArrowsClockwise,
  },
  {
    id: 'models',
    label: '模型',
    description: '选择平台模型或接入多条自己的模型',
    keywords: '模型 自定义 供应商 API Key Base OpenAI DeepSeek 接入',
    icon: ChatCircleDots,
  },
  {
    id: 'ai',
    label: 'AI 服务',
    description: '默认即可使用，需要时再接入自己的模型',
    keywords: '视觉 图片 问答 供应商 API Key Base 基础 AI',
    icon: Cpu,
  },
  {
    id: 'about',
    label: '版本更新',
    description: '查看当前版本并检查更新',
    keywords: '关于 更新 版本 Windows Android',
    icon: Info,
  },
];

const MOBILE_HIDDEN_SECTIONS = new Set<SettingsSectionId>(['appearance', 'ai']);

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

function SettingsWorkspace() {
  const { isDesktop } = useDesktopApp();
  const { user, logout } = useAuth();
  const { settings, updateDesktopDensity, resetDesktopAppearance } = useSettings();
  const isMobile = useIsMobile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState('');
  const [nativeAndroid, setNativeAndroid] = useState(false);
  const sectionParam = searchParams.get('section');

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  useEffect(() => {
    if (isMobile && MOBILE_HIDDEN_SECTIONS.has(sectionParam as SettingsSectionId)) {
      router.replace('/settings?section=general', { scroll: false });
    }
  }, [isMobile, router, sectionParam]);

  const availableSections = useMemo(
    () => isMobile ? SETTINGS_SECTIONS.filter((section) => !MOBILE_HIDDEN_SECTIONS.has(section.id)) : SETTINGS_SECTIONS,
    [isMobile],
  );
  const activeSection = availableSections.find((section) => section.id === sectionParam)
    ?? availableSections[0];

  const visibleSections = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalizedQuery) return availableSections;
    return availableSections.filter((section) => (
      `${section.label} ${section.description} ${section.keywords}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalizedQuery)
    ));
  }, [availableSections, query]);

  const selectSection = (id: SettingsSectionId) => {
    setQuery('');
    router.replace(`/settings?section=${id}`, { scroll: false });
  };

  return (
    <div className={`desktop-settings-page ${styles.workspace}`}>
      <aside className={styles.rail} aria-label="设置分类">
        <Link href="/" className={styles.backLink}>
          <ArrowLeft size={16} aria-hidden="true" />
          返回应用
        </Link>

        <label className={styles.search}>
          <MagnifyingGlass size={16} aria-hidden="true" />
          <span className="sr-only">搜索设置</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设置…"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="清除搜索">
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </label>

        <p className={styles.groupLabel}>个人</p>
        <nav className={styles.navigation}>
          {visibleSections.map((section) => {
            const Icon = section.icon;
            const selected = section.id === activeSection.id;
            return (
              <button
                key={section.id}
                type="button"
                className={`${styles.navButton} ${selected ? styles.navButtonActive : ''}`}
                data-section-id={section.id}
                aria-current={selected ? 'page' : undefined}
                onClick={() => selectSection(section.id)}
              >
                <Icon size={17} weight={selected ? 'fill' : 'regular'} aria-hidden="true" />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>
        {visibleSections.length === 0 && (
          <div className={styles.emptySearch}>
            <p>没有找到相关设置</p>
            <button type="button" onClick={() => setQuery('')}>清除搜索</button>
          </div>
        )}
        <div className={styles.railVersion}>知萃 · Web v{WEB_APP_VERSION}</div>
      </aside>

      <main className={styles.content}>
        <div className={styles.contentInner}>
          <h1 className="sr-only">{activeSection.label}</h1>

          <div className={styles.sectionStack}>
            {activeSection.id === 'general' && (
              <>
                <section className={styles.summaryCard} aria-label="当前应用状态">
                  <div className={styles.summaryRow}>
                    <div>
                      <strong>当前使用</strong>
                      <span>这些设置只影响这台设备</span>
                    </div>
                    <b>{nativeAndroid ? 'Android App' : isDesktop ? 'Windows 桌面端' : '网页端'}</b>
                  </div>
                  <div className={styles.summaryRow}>
                    <div>
                      <strong>账号内容</strong>
                      <span>视频资料、知识和计划跟随账号；平台采集只手动执行</span>
                    </div>
                    <b className={styles.healthy}>手动同步</b>
                  </div>
                  <div className={styles.summaryRow}>
                    <div>
                      <strong>网页版本</strong>
                      <span>客户端版本可在“版本更新”中查看</span>
                    </div>
                    <b className="tabular-nums">v{WEB_APP_VERSION}</b>
                  </div>
                </section>

                <ClientCapabilitySettingsCard />

                <section className={styles.mobileActions} aria-label="账号与帮助">
                  <div className={styles.mobileAccount}>
                    <span aria-hidden="true"><UserCircle size={22} /></span>
                    <div>
                      <strong>{user?.username || '我的账号'}</strong>
                      <small>{user?.email || '内容已安全同步'}</small>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('zhicui:open-feedback'))}
                  >
                    <ChatCircleDots size={19} aria-hidden="true" />
                    <span>意见反馈</span>
                  </button>
                  <button type="button" onClick={() => selectSection('about')}>
                    <Info size={19} aria-hidden="true" />
                    <span>检查更新</span>
                  </button>
                  <button
                    type="button"
                    className={styles.mobileLogout}
                    onClick={() => {
                      logout();
                      router.replace('/login');
                    }}
                  >
                    <SignOut size={19} aria-hidden="true" />
                    <span>退出登录</span>
                  </button>
                </section>
              </>
            )}

            {activeSection.id === 'account' && (
              <AccountDataSettingsCard />
            )}

            {activeSection.id === 'appearance' && (
              <section className="appearance-settings-card" aria-labelledby="appearance-settings-title">
                <header className="appearance-settings-card__header">
                  <div>
                    <h2 id="appearance-settings-title">显示方式</h2>
                    <p>修改后立即生效，只保存在当前设备。</p>
                  </div>
                  <button type="button" className="appearance-settings-card__reset" onClick={resetDesktopAppearance}>
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
                            <span className="appearance-option__icon" aria-hidden="true"><Icon size={18} /></span>
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
            )}

            {activeSection.id === 'storage' && (
              <>
                <LocalDataSettingsCard />
                <DesktopMediaSettingsCard />
              </>
            )}

            {activeSection.id === 'sync' && (
              <>
                <QuickSyncSettingsCard />
                <AgentSourceLimitSettingsCard />
                <AutoSyncSettingsCard />
              </>
            )}
            {activeSection.id === 'models' && (
              <section className={styles.technicalSection}>
                <UserCustomModelsSettingsCard />
              </section>
            )}
            {activeSection.id === 'ai' && !isMobile && (
              <section className={styles.technicalSection}>
                <UserAIProviderSettingsCard />
                <UserVisionProviderSettingsCard />
              </section>
            )}

            {activeSection.id === 'about' && (
              <AppUpdateSettingsCard />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className={styles.loading}>正在打开设置…</div>}>
      <SettingsWorkspace />
    </Suspense>
  );
}
