'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ArrowsClockwise,
  CalendarCheck,
  CalendarBlank,
  ChatCircleDots,
  ClipboardText,
  FileText,
  GearSix,
  Heart,
  LinkSimple,
  Lockers,
  UsersThree,
  Sparkle,
  VideoCamera,
} from '@phosphor-icons/react';
import {
  listAgentSources,
  listAgentThreads,
  listDouyinLibraryItems,
  listPlatformLibraryItems,
} from '@/lib/api';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import DailyRecap from '@/components/DailyRecap';
import { HomeVideoActionCard, HomeVideoActionsLayer, useHomeVideoInteractions } from '@/components/HomeVideoActions';
import { useHomeVideoActions } from '@/lib/hooks/useHomeVideoActions';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import { readLibrarySyncSelections, subscribeLibrarySyncSelections } from '@/lib/librarySyncSelection';
import { useAuth } from '@/lib/hooks/AuthContext';
import { buildHomeLinkDestination } from '@/lib/singleLinkImport';
import { sortPlatformLibrarySource } from '@/lib/platformLibraryOrder';
import { getLibraryRevision, isLibraryRevisionCurrent, subscribeLibraryUpdates } from '@/lib/libraryUpdates';
import {
  firstPopulatedHomeMode,
  type HomeChannelMode,
  type HomeChannelPlatform,
} from '@/lib/homeSourceClassification';
import type {
  AgentThread,
  DouyinLibraryItem,
  PlatformLibraryItem,
} from '@/lib/types';
import styles from './WorkspaceActionHome.module.css';

interface ChannelPreview {
  key: string;
  videoId: string;
  href: string;
  title: string;
  cover: string;
  author: string;
}

interface WorkspaceHomeCache {
  savedAt: number;
  threads: AgentThread[];
  readyCount: number | null;
  channelPreviews: Record<ChannelKey, ChannelPreview[]>;
  channelTotals: Record<ChannelKey, number | null>;
  activeModes: Record<ChannelPlatform, ChannelMode>;
}

type ChannelPlatform = HomeChannelPlatform;
type ChannelMode = HomeChannelMode;
type ChannelKey = `${ChannelPlatform}_${ChannelMode}`;

const CHANNEL_PLATFORMS: Array<{
  key: ChannelPlatform;
  label: string;
  description: string;
  modes: Array<{
    key: ChannelMode;
    label: string;
    empty: string;
    Icon: typeof Heart;
  }>;
}> = [
  {
    key: 'douyin',
    label: '抖音',
    description: '喜欢、收藏与自己的作品',
    modes: [
      { key: 'collect', label: '收藏', empty: '还没有同步抖音收藏', Icon: Lockers },
      { key: 'like', label: '喜欢', empty: '还没有同步抖音喜欢', Icon: Heart },
      { key: 'post', label: '作品', empty: '还没有同步自己的抖音作品', Icon: VideoCamera },
    ],
  },
  {
    key: 'bilibili',
    label: 'B站',
    description: '收藏、喜欢与导入视频',
    modes: [
      { key: 'collect', label: '收藏', empty: '还没有同步 B站收藏', Icon: Lockers },
      { key: 'like', label: '喜欢', empty: '还没有同步 B站喜欢', Icon: Heart },
      { key: 'import', label: '导入', empty: '还没有导入 B站视频', Icon: VideoCamera },
    ],
  },
];

const CHANNEL_KEYS: ChannelKey[] = [
  'douyin_collect',
  'douyin_like',
  'douyin_post',
  'bilibili_collect',
  'bilibili_like',
  'bilibili_import',
];

// 收藏台账校准后，旧首页预览也不能在网络响应前闪回错误排名。
const HOME_CACHE_VERSION = 'v9';
const HOME_CACHE_MAX_AGE = 5 * 60 * 1000;

function homeCacheKey(userId: string): string {
  return `zhicui:workspace-home:${HOME_CACHE_VERSION}:${userId}`;
}

function readHomeCache(userId: string): WorkspaceHomeCache | null {
  try {
    const raw = sessionStorage.getItem(homeCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkspaceHomeCache;
    if (!parsed.savedAt || Date.now() - parsed.savedAt > HOME_CACHE_MAX_AGE) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeHomeCache(userId: string, value: Omit<WorkspaceHomeCache, 'savedAt'>): void {
  try {
    sessionStorage.setItem(homeCacheKey(userId), JSON.stringify({ ...value, savedAt: Date.now() }));
  } catch {
    // 缓存只是加速层，存储不可用时不影响主页本身。
  }
}

function emptyChannelRecord<T>(value: T): Record<ChannelKey, T> {
  return Object.fromEntries(CHANNEL_KEYS.map((key) => [key, value])) as Record<ChannelKey, T>;
}

function DouyinBrandIcon() {
  const path = 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z';
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="抖音">
      <path d={path} fill="#25f4ee" transform="translate(-.45 .35)" />
      <path d={path} fill="#fe2c55" transform="translate(.45 -.2)" />
      <path d={path} fill="#111318" />
    </svg>
  );
}

function BilibiliBrandIcon() {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="哔哩哔哩">
      <path fill="currentColor" d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.765-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.386-.947.258-.257.574-.386.947-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373Z" />
    </svg>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date);
}

function toDouyinPreviews(items: DouyinLibraryItem[]): ChannelPreview[] {
  return items.map((item) => ({
    key: item.aweme_id,
    videoId: item.aweme_id,
    href: `/library/detail?id=${encodeURIComponent(item.aweme_id)}`,
    title: item.title,
    cover: item.cover_proxy_url || item.cover_url || '',
    author: item.author_name || '抖音',
  }));
}

function toPlatformPreviews(items: PlatformLibraryItem[]): ChannelPreview[] {
  return items.map((item) => ({
    key: item.id,
    videoId: item.video_id,
    href: `/library/detail?note=${encodeURIComponent(item.id)}`,
    title: item.title,
    cover: item.cover_url || '',
    author: item.author_name || 'B站',
  }));
}

export default function WorkspaceActionHome() {
  const router = useRouter();
  const { user } = useAuth();
  const videoActions = useHomeVideoActions(user?.id);
  const videoInteractions = useHomeVideoInteractions(videoActions);
  useWebBuildActivity('home-video-actions', videoActions.busy.size > 0
    || Boolean(videoInteractions.menu) || Boolean(videoInteractions.dragged));
  const hiddenVideoCount = [...videoActions.preferences.values()].filter((item) => item.platform === 'douyin' && item.hidden).length;
  const [importLink, setImportLink] = useState('');
  const [importError, setImportError] = useState('');
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [readyCount, setReadyCount] = useState<number | null>(null);
  const [channelPreviews, setChannelPreviews] = useState<Record<ChannelKey, ChannelPreview[]>>(
    () => emptyChannelRecord<ChannelPreview[]>([]),
  );
  const [channelTotals, setChannelTotals] = useState<Record<ChannelKey, number | null>>(
    () => emptyChannelRecord<number | null>(null),
  );
  const [activeModes, setActiveModes] = useState<Record<ChannelPlatform, ChannelMode>>({
    douyin: 'collect',
    bilibili: 'collect',
  });
  const touchedModes = useRef<Set<ChannelPlatform>>(new Set());
  const loadedUserId = useRef<string | null>(null);
  const lastSuccessful = useRef<{ userId: string; value: WorkspaceHomeCache } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [todayAnalysisLaunch, setTodayAnalysisLaunch] = useState(0);

  useEffect(() => {
    if (!user?.id) return;
    return subscribeLibraryUpdates(() => setRefreshRevision((value) => value + 1));
  }, [user?.id]);

  useEffect(() => subscribeLibrarySyncSelections(user?.id, ({ platform, mode }) => {
    touchedModes.current.add(platform);
    setActiveModes((current) => ({ ...current, [platform]: mode }));
  }), [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      loadedUserId.current = null;
      lastSuccessful.current = null;
      return;
    }
    let active = true;
    const requestedRevision = getLibraryRevision();
    const isCurrent = () => active && isLibraryRevisionCurrent(requestedRevision);
    const initialLoad = loadedUserId.current !== user.id;
    if (initialLoad) {
      loadedUserId.current = user.id;
      touchedModes.current = new Set();
      setThreads([]);
      setReadyCount(null);
      setChannelPreviews(emptyChannelRecord<ChannelPreview[]>([]));
      setChannelTotals(emptyChannelRecord<number | null>(null));
      setActiveModes({ douyin: 'collect', bilibili: 'collect' });
      setLoading(true);
    }
    const cached = readHomeCache(user.id);
    if (cached && initialLoad) {
      setThreads(cached.threads);
      setReadyCount(cached.readyCount);
      setChannelPreviews(cached.channelPreviews);
      setChannelTotals(cached.channelTotals);
      setActiveModes(cached.activeModes);
      setLoading(false);
    }
    if (initialLoad) {
      const syncModes = readLibrarySyncSelections(user.id);
      for (const platform of ['douyin', 'bilibili'] as const) {
        if (syncModes[platform]) touchedModes.current.add(platform);
      }
      setActiveModes((current) => ({ ...current, ...syncModes }));
    }

    // 失效缓存不等于资料为空；同账号刷新失败时保留上次成功展示的分组。
    const previous = !initialLoad && lastSuccessful.current?.userId === user.id
      ? lastSuccessful.current.value
      : cached;
    const nextPreviews = { ...(previous?.channelPreviews || emptyChannelRecord<ChannelPreview[]>([])) };
    const nextTotals = { ...(previous?.channelTotals || emptyChannelRecord<number | null>(null)) };
    let nextThreads = previous?.threads || [];
    let nextReadyCount = previous?.readyCount ?? null;
    const remember = () => {
      lastSuccessful.current = {
        userId: user.id,
        value: {
          savedAt: Date.now(),
          threads: nextThreads,
          readyCount: nextReadyCount,
          channelPreviews: { ...nextPreviews },
          channelTotals: { ...nextTotals },
          activeModes: previous?.activeModes || { douyin: 'collect', bilibili: 'collect' },
        },
      };
    };
    // 缓存画面已可见时也建立内存基线，覆盖首批请求尚未返回就再次同步的情况。
    remember();

    const publishChannels = () => {
      if (!isCurrent()) return;
      remember();
      setChannelPreviews({ ...nextPreviews });
      setChannelTotals({ ...nextTotals });
      setActiveModes((current) => {
        let changed = false;
        const next = { ...current };
        CHANNEL_PLATFORMS.forEach((platform) => {
          if (touchedModes.current.has(platform.key)) return;
          const firstAvailable = platform.modes.find(({ key: mode }) => (
            (nextTotals[`${platform.key}_${mode}` as ChannelKey] || 0) > 0
          ));
          if (firstAvailable && next[platform.key] !== firstAvailable.key) {
            next[platform.key] = firstAvailable.key;
            changed = true;
          }
        });
        return changed ? next : current;
      });
    };

    const threadRequest = listAgentThreads().then((response) => {
      if (!isCurrent()) return response;
      if (response.success) {
        nextThreads = (response.data?.items || []).slice(0, 3);
        remember();
        setThreads(nextThreads);
      }
      setLoading(false);
      return response;
    }).catch(() => {
      if (isCurrent()) setLoading(false);
      return null;
    });

    const sourceRequest = listAgentSources('all_ready', '', undefined, [], 500).then((response) => {
      if (!isCurrent() || !response.success) return response;
      const sources = response.data;
      nextReadyCount = sources?.ready_count ?? sources?.total ?? 0;
      remember();
      setReadyCount(nextReadyCount);
      return response;
    }).catch(() => null);

    const douyinRequests = (['collect', 'like', 'post'] as const).map((mode) => (
      listDouyinLibraryItems(Math.min(500, 6 + hiddenVideoCount), mode, 'collection', false, true).then((response) => {
        if (!isCurrent() || !response.success) return response;
        const key = `douyin_${mode}` as ChannelKey;
        const total = response.data?.source_total ?? 0;
        // 成功响应（包括真实的 0 条）就是该来源的权威结果。
        nextPreviews[key] = toDouyinPreviews(response.data?.items || []);
        nextTotals[key] = total;
        publishChannels();
        return response;
      }).catch(() => null)
    ));

    // 服务端先按分类筛选和排序，防止其他分类挤占有界列表的前 500 条。
    const biliRequests = (['collect', 'like', 'import'] as const).map((mode) => (
      listPlatformLibraryItems('bilibili', mode).then((response) => {
        if (!isCurrent() || !response.success) return response;
        const key = `bilibili_${mode}` as ChannelKey;
        nextPreviews[key] = toPlatformPreviews(sortPlatformLibrarySource(response.data?.items || [], mode));
        nextTotals[key] = response.data?.total ?? 0;
        publishChannels();
        return response;
      }).catch(() => null)
    ));

    void Promise.allSettled([
      threadRequest,
      sourceRequest,
      ...douyinRequests,
      ...biliRequests,
    ]).then(() => {
      if (!isCurrent()) return;
      const nextActiveModes: Record<ChannelPlatform, ChannelMode> = {
        douyin: firstPopulatedHomeMode('douyin', {
          collect: nextTotals.douyin_collect,
          like: nextTotals.douyin_like,
          post: nextTotals.douyin_post,
        }),
        bilibili: firstPopulatedHomeMode('bilibili', {
          collect: nextTotals.bilibili_collect,
          like: nextTotals.bilibili_like,
          import: nextTotals.bilibili_import,
        }),
      };
      setActiveModes((current) => ({
        douyin: touchedModes.current.has('douyin') ? current.douyin : nextActiveModes.douyin,
        bilibili: touchedModes.current.has('bilibili') ? current.bilibili : nextActiveModes.bilibili,
      }));
      setLoading(false);
      writeHomeCache(user.id, {
        threads: nextThreads,
        readyCount: nextReadyCount,
        channelPreviews: { ...nextPreviews },
        channelTotals: { ...nextTotals },
        activeModes: nextActiveModes,
      });
    });
    return () => { active = false; };
  }, [user?.id, refreshRevision, hiddenVideoCount]);

  const sourceStatus = useMemo(() => {
    if (readyCount === null) return '正在读取资料';
    if (readyCount === 0) return '还没有可提问的视频';
    return `${readyCount.toLocaleString('zh-CN')} 条视频资料已就绪`;
  }, [readyCount]);

  const welcome = useMemo(() => {
    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 11
      ? '早上好'
      : hour < 14
        ? '中午好'
        : hour < 18
          ? '下午好'
          : '晚上好';
    const date = new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(now);
    return { greeting, date };
  }, []);

  const displayName = user?.username?.trim();

  const channelCountLabel = (key: ChannelKey): string => {
    const total = channelTotals[key];
    return total === null ? '—' : total.toLocaleString('zh-CN');
  };

  const submitImportLink = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!importLink.trim()) {
      setImportError('请先粘贴博主主页或视频链接');
      return;
    }
    setImportError('');
    router.push(buildHomeLinkDestination(importLink));
  };

  const pasteImportLink = async () => {
    setImportError('');
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setImportError('剪贴板里没有链接，也可以长按输入框手动粘贴');
        return;
      }
      setImportLink(text.trim());
    } catch {
      setImportError('无法读取剪贴板，请长按输入框粘贴');
    }
  };

  return (
    <main className={styles.home}>
      <div className={styles.mobileBrandBar}>
        <Link href="/" className={styles.mobileBrand} aria-label="知萃首页">
          <img src="/icons/icon-192.png" alt="" width={34} height={34} />
          <strong>知萃</strong>
        </Link>
        <div className={styles.mobileHeaderActions}>
          <Link href="/community" className={styles.mobileFeedback} aria-label="加入交流群">
            <ChatCircleDots size={19} aria-hidden="true" /><span>交流群</span>
          </Link>
          <button
            type="button"
            className={styles.mobileFeedback}
            aria-label="意见反馈"
            onClick={() => window.dispatchEvent(new Event('zhicui:open-feedback'))}
          >
            <ChatCircleDots size={19} weight="regular" aria-hidden="true" />
            <span>反馈</span>
          </button>
          <Link href="/settings" className={styles.mobileSettings} aria-label="打开设置">
            <GearSix size={21} weight="regular" aria-hidden="true" />
          </Link>
        </div>
      </div>

      <section className={styles.mobileImport} aria-labelledby="mobile-import-title">
        <div className={styles.mobileImportHeading}>
          <h1 id="mobile-import-title">粘贴链接</h1>
          <p>支持抖音 / B站博主主页或单条视频</p>
        </div>
        <form onSubmit={submitImportLink} className={styles.mobileImportForm}>
          <label htmlFor="mobile-home-link" className="sr-only">博主主页或单条视频链接</label>
          <div className={styles.mobileImportField}>
            <LinkSimple size={20} weight="regular" aria-hidden="true" />
            <input
              id="mobile-home-link"
              type="text"
              inputMode="url"
              enterKeyHint="go"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={importLink}
              onChange={(event) => {
                setImportLink(event.target.value);
                if (importError) setImportError('');
              }}
              placeholder="粘贴抖音 / B站主页或视频链接"
            />
            <button type="button" className={styles.pasteButton} onClick={() => void pasteImportLink()}>
              <ClipboardText size={17} weight="regular" aria-hidden="true" />
              粘贴
            </button>
          </div>
          <button type="submit" className={styles.importButton} disabled={!importLink.trim()}>
            开始解析
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </button>
        </form>
        {importError ? <p className={styles.mobileImportError} role="alert">{importError}</p> : null}
      </section>

      <header className={styles.welcome}>
        <div>
          <p>{welcome.date}</p>
          <h1>
            {welcome.greeting}{displayName ? `，${displayName}` : ''}
          </h1>
        </div>
      </header>

      <section className={styles.coreFeatures} aria-labelledby="core-features-title">
        <div className={styles.coreFeaturesHeading}>
          <span className={styles.sectionLabel}><Sparkle size={14} weight="fill" aria-hidden="true" />核心功能</span>
          <h2 id="core-features-title">把喜欢的视频，变成能用的答案</h2>
          <p>目前支持抖音和 B站，首页就能开始同步、回顾和提问。</p>
        </div>
        <div className={styles.coreFeatureGrid}>
          <Link href="/library?sync=1" className={`${styles.coreFeature} ${styles.coreFeaturePrimary}`}>
            <span className={styles.coreFeatureIcon} aria-hidden="true"><ArrowsClockwise size={22} weight="bold" /></span>
            <span className={styles.coreFeatureCopy}>
              <strong>同步抖音 / B站</strong>
              <small>同步喜欢、收藏和作品，自动整理成资料</small>
            </span>
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </Link>
          <a href="#yesterday-recap-title" className={styles.coreFeature}>
            <span className={styles.coreFeatureIcon} aria-hidden="true"><CalendarBlank size={22} weight="bold" /></span>
            <span className={styles.coreFeatureCopy}>
              <strong>看看昨天干了什么</strong>
              <small>回顾昨天新增的视频，一键交给 AI 提取</small>
            </span>
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </a>
          <button
            type="button"
            className={styles.coreFeature}
            onClick={() => {
              setTodayAnalysisLaunch((value) => value + 1);
              window.requestAnimationFrame(() => {
                document.getElementById('today-recap-title')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              });
            }}
          >
            <span className={styles.coreFeatureIcon} aria-hidden="true"><CalendarCheck size={22} weight="bold" /></span>
            <span className={styles.coreFeatureCopy}>
              <strong>分析今天新收藏</strong>
              <small>整理今天新增的喜欢与收藏，及时沉淀</small>
            </span>
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </button>
          <Link href="/library/creators" className={styles.coreFeature}>
            <span className={styles.coreFeatureIcon} aria-hidden="true"><UsersThree size={22} weight="bold" /></span>
            <span className={styles.coreFeatureCopy}>
              <strong>博主视频批量提问</strong>
              <small>提取博主全部作品，多选视频后直接问 AI</small>
            </span>
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className={styles.start} aria-labelledby="workspace-start-title">
        <div className={styles.intro}>
          <span className={styles.sectionLabel}>
            <Sparkle size={14} weight="fill" aria-hidden="true" />
            视频知识助手
          </span>
          <h2 id="workspace-start-title">从视频里找答案</h2>
        </div>

        <div className={styles.startAction}>
          <div className={styles.primaryActions}>
            <Link
              href="/library?sync=1"
              className={styles.syncEntry}
              aria-label="同步抖音和 B站视频"
            >
              <span className={styles.syncIcon} aria-hidden="true">
                <ArrowsClockwise size={20} weight="bold" />
              </span>
              <span className={styles.syncCopy}>
                <strong>同步视频</strong>
                <small>更新抖音、B站视频资料</small>
              </span>
              <span className={styles.syncArrow} aria-hidden="true">
                <ArrowRight size={16} weight="bold" />
              </span>
            </Link>

            <Link href="/harness?new=1&source_scope=all_ready" className={styles.askEntry}>
              <span className={styles.askIcon} aria-hidden="true">
                <ChatCircleDots size={20} weight="duotone" />
              </span>
              <span className={styles.askCopy}>
                <strong>去提问</strong>
                <small>基于已同步的视频直接提问</small>
              </span>
              <span className={styles.askArrow} aria-hidden="true">
                <ArrowRight size={16} weight="bold" />
              </span>
            </Link>
          </div>

          <div className={styles.sourceStatus} data-empty={readyCount === 0} role="status">
            <span aria-hidden="true" />
            {sourceStatus}
            <Link href="/library">管理资料</Link>
          </div>
        </div>
      </section>

      <div className={styles.dailyCards} aria-label="每日视频分析">
        <DailyRecap kind="yesterday" videoActions={videoActions} videoInteractions={videoInteractions} />
        <DailyRecap kind="today" launchToken={todayAnalysisLaunch} videoActions={videoActions} videoInteractions={videoInteractions} />
      </div>

      <section className={styles.channels} aria-label="抖音与 B站资料">
        <div className={styles.platformGrid}>
          {CHANNEL_PLATFORMS.map((platform) => {
            const activeMode = activeModes[platform.key];
            const activeConfig = platform.modes.find((mode) => mode.key === activeMode) || platform.modes[0];
            const activeKey = `${platform.key}_${activeMode}` as ChannelKey;
            const previews = (channelPreviews[activeKey] || []).filter((preview) => videoActions.visible({
              platform: platform.key, video_id: preview.videoId, title: preview.title,
            })).slice(0, 3);
            const platformTotal = platform.modes.reduce((total, mode) => {
              const count = channelTotals[`${platform.key}_${mode.key}` as ChannelKey];
              return total + (count || 0);
            }, 0);
            return (
              <article
                key={platform.key}
                className={styles.platformPanel}
                data-platform={platform.key}
                aria-labelledby={`platform-${platform.key}-title`}
              >
                <header className={styles.platformHead}>
                  <div>
                    <span className={styles.platformMark} aria-hidden="true">
                      {platform.key === 'douyin' ? <DouyinBrandIcon /> : <BilibiliBrandIcon />}
                    </span>
                    <span>
                      <h3 id={`platform-${platform.key}-title`}>{platform.label}</h3>
                      <small>{platform.description} · {platformTotal.toLocaleString('zh-CN')} 条</small>
                    </span>
                  </div>
                  <Link href={`/library?platform=${platform.key}&mode=${activeModes[platform.key]}`}>
                    全部
                    <ArrowRight size={13} weight="bold" aria-hidden="true" />
                  </Link>
                </header>

                <div className={styles.modeTabs} role="tablist" aria-label={`${platform.label}来源`}>
                  {platform.modes.map(({ key: mode, label, Icon }) => {
                    const channelKey = `${platform.key}_${mode}` as ChannelKey;
                    const selected = activeMode === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        className={selected ? styles.activeMode : undefined}
                        onClick={() => {
                          touchedModes.current.add(platform.key);
                          setActiveModes((current) => ({ ...current, [platform.key]: mode }));
                        }}
                      >
                        <Icon size={14} weight={selected ? 'fill' : 'regular'} aria-hidden="true" />
                        <span>{label}</span>
                        <small>{channelCountLabel(channelKey)}</small>
                      </button>
                    );
                  })}
                </div>

                <div className={styles.channelStrip}>
                  {previews.length > 0 ? (
                    previews.map((preview) => (
                      <HomeVideoActionCard
                        key={preview.key}
                        video={{ platform: platform.key, video_id: preview.videoId, title: preview.title }}
                        actions={videoActions} interactions={videoInteractions}
                      ><Link
                        href={preview.href}
                        draggable={false}
                        className={styles.channelCard}
                        data-cover={preview.cover ? 'true' : 'false'}
                        aria-label={`打开视频：${preview.title}`}
                      >
                        <span className={styles.channelCardMedia} aria-hidden="true">
                          <LibraryCoverImage
                            src={preview.cover}
                            fallbackClassName={styles.channelCardFallback}
                            fallbackLabel="封面暂不可用"
                            iconSize={16}
                            retryable={false}
                            priority
                          />
                        </span>
                        <span className={styles.channelCardScrim} aria-hidden="true" />
                        <span className={styles.channelCardBody}>
                          <strong>{preview.title}</strong>
                          <small>{preview.author}</small>
                        </span>
                      </Link></HomeVideoActionCard>
                    ))
                  ) : (
                    <div className={styles.channelEmpty}>{!videoActions.ready ? '正在读取首页视频…' : (channelTotals[activeKey] || 0) > 0 ? '本组视频已从首页隐藏，可在视频资料中查看' : activeConfig.empty}</div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <HomeVideoActionsLayer actions={videoActions} interactions={videoInteractions} />

      <div className={styles.utilityArea}>
        <nav className={styles.tools} aria-label="常用操作">
          <Link href="/library" className={styles.toolAction}>
            <span className={styles.toolIcon} aria-hidden="true">
              <VideoCamera size={19} weight="regular" />
            </span>
            <span>
              <strong>管理资料</strong>
              <small>查看渠道与视频</small>
            </span>
            <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </Link>
          <Link href="/extract" className={styles.toolAction}>
            <span className={styles.toolIcon} aria-hidden="true">
              <LinkSimple size={19} weight="regular" />
            </span>
            <span>
              <strong>解析链接</strong>
              <small>处理单条内容</small>
            </span>
            <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </Link>
          <Link href="/plans" className={styles.toolAction}>
            <span className={styles.toolIcon} aria-hidden="true">
              <CalendarCheck size={19} weight="regular" />
            </span>
            <span>
              <strong>今日计划</strong>
              <small>继续要做的事</small>
            </span>
            <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </Link>
          <Link href="/notes" className={styles.toolAction}>
            <span className={styles.toolIcon} aria-hidden="true">
              <FileText size={18} weight="regular" />
            </span>
            <span>
              <strong>知识库</strong>
              <small>收藏与卡片</small>
            </span>
            <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </Link>
        </nav>
      </div>

      <section className={styles.recent} aria-labelledby="recent-conversations-title">
        <header>
          <div>
            <span className={styles.sectionLabel}>最近使用</span>
            <h2 id="recent-conversations-title">继续上次的会话</h2>
          </div>
          {threads.length > 0 && (
            <Link href="/harness">
              全部会话
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </Link>
          )}
        </header>

        {loading ? (
          <div className={styles.skeleton} aria-label="正在读取最近对话">
            <span /><span /><span />
          </div>
        ) : threads.length > 0 ? (
          <div className={styles.threadList}>
            {threads.map((thread) => (
              <Link
                key={thread.id}
                href={`/harness?thread=${encodeURIComponent(thread.id)}`}
                className={styles.thread}
              >
                <span className={styles.threadIcon} aria-hidden="true">
                  <VideoCamera size={17} weight="regular" />
                </span>
                <span className={styles.threadCopy}>
                  <strong>{thread.title || '未命名会话'}</strong>
                  <small>{thread.last_message || `${thread.source_count} 条视频资料`}</small>
                </span>
                <time>{formatUpdatedAt(thread.updated_at)}</time>
                <ArrowRight size={16} weight="regular" aria-hidden="true" />
              </Link>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <ChatCircleDots size={24} weight="duotone" />
            </span>
            <div>
              <h3>你的第一个问题，可以很具体</h3>
              <p>同步视频后，试着问“这几条内容的共同建议是什么？”</p>
            </div>
            <Link href="/harness?new=1&source_scope=all_ready">
              创建会话
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
