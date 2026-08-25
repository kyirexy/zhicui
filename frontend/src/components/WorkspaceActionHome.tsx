'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowsClockwise,
  CalendarCheck,
  ChatCircleDots,
  FileText,
  GearSix,
  Heart,
  LinkSimple,
  Lockers,
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
import { useAuth } from '@/lib/hooks/AuthContext';
import type {
  AgentSource,
  AgentThread,
  DouyinLibraryItem,
  PlatformLibraryItem,
} from '@/lib/types';
import styles from './WorkspaceActionHome.module.css';

interface ChannelPreview {
  key: string;
  href: string;
  title: string;
  cover: string;
  author: string;
}

type ChannelPlatform = 'douyin' | 'bilibili';
type ChannelMode = 'collect' | 'like' | 'post';
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
    description: '收藏、喜欢与投稿 / 导入',
    modes: [
      { key: 'collect', label: '收藏', empty: '还没有同步 B站收藏', Icon: Lockers },
      { key: 'like', label: '喜欢', empty: '还没有同步 B站喜欢', Icon: Heart },
      { key: 'post', label: '作品', empty: '还没有同步 B站投稿或导入视频', Icon: VideoCamera },
    ],
  },
];

const CHANNEL_KEYS: ChannelKey[] = [
  'douyin_collect',
  'douyin_like',
  'douyin_post',
  'bilibili_collect',
  'bilibili_like',
  'bilibili_post',
];

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
  return items.slice(0, 3).map((item) => ({
    key: item.aweme_id,
    href: `/library/detail?id=${encodeURIComponent(item.aweme_id)}`,
    title: item.title,
    cover: item.cover_proxy_url || item.cover_url || '',
    author: item.author_name || '抖音',
  }));
}

function toPlatformPreviews(items: PlatformLibraryItem[]): ChannelPreview[] {
  return items.slice(0, 3).map((item) => ({
    key: item.id,
    href: `/library/detail?note=${encodeURIComponent(item.id)}`,
    title: item.title,
    cover: item.cover_url || '',
    author: item.author_name || 'B站',
  }));
}

function toAgentPreviews(items: AgentSource[]): ChannelPreview[] {
  return items.slice(0, 3).map((item) => ({
    key: item.note_id,
    href: `/library/detail?note=${encodeURIComponent(item.note_id)}`,
    title: item.title,
    cover: item.cover_url || '',
    author: item.author_name || (item.platform === 'bilibili' ? 'B站' : '抖音'),
  }));
}

export default function WorkspaceActionHome() {
  const { user } = useAuth();
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      listAgentThreads(),
      listAgentSources('all_ready', '', undefined, [], 500),
      listDouyinLibraryItems(6, 'collect'),
      listDouyinLibraryItems(6, 'like'),
      listDouyinLibraryItems(6, 'post'),
      listPlatformLibraryItems('bilibili'),
    ]).then((results) => {
      if (!active) return;
      const [threadResult, sourceResult, collectResult, likeResult, postResult, biliResult] = results;
      const nextPreviews = emptyChannelRecord<ChannelPreview[]>([]);
      const nextTotals = emptyChannelRecord<number | null>(null);

      if (threadResult.status === 'fulfilled' && threadResult.value.success) {
        setThreads((threadResult.value.data?.items || []).slice(0, 3));
      }
      if (sourceResult.status === 'fulfilled' && sourceResult.value.success) {
        const sources = sourceResult.value.data;
        setReadyCount(sources?.ready_count ?? sources?.total ?? 0);
        const bilibiliBuckets: Record<ChannelMode, AgentSource[]> = {
          collect: [],
          like: [],
          post: [],
        };
        (sources?.items || []).forEach((item) => {
          if (item.platform !== 'bilibili') return;
          const mode = item.source_mode === 'collect' || item.source_mode === 'like'
            ? item.source_mode
            : 'post';
          bilibiliBuckets[mode].push(item);
        });
        (Object.keys(bilibiliBuckets) as ChannelMode[]).forEach((mode) => {
          const key = `bilibili_${mode}` as ChannelKey;
          nextPreviews[key] = toAgentPreviews(bilibiliBuckets[mode]);
          nextTotals[key] = bilibiliBuckets[mode].length;
        });
      }
      if (collectResult.status === 'fulfilled' && collectResult.value.success) {
        nextPreviews.douyin_collect = toDouyinPreviews(collectResult.value.data?.items || []);
        nextTotals.douyin_collect = collectResult.value.data?.source_total ?? 0;
      }
      if (likeResult.status === 'fulfilled' && likeResult.value.success) {
        nextPreviews.douyin_like = toDouyinPreviews(likeResult.value.data?.items || []);
        nextTotals.douyin_like = likeResult.value.data?.source_total ?? 0;
      }
      if (postResult.status === 'fulfilled' && postResult.value.success) {
        nextPreviews.douyin_post = toDouyinPreviews(postResult.value.data?.items || []);
        nextTotals.douyin_post = postResult.value.data?.source_total ?? 0;
      }
      if (biliResult.status === 'fulfilled' && biliResult.value.success) {
        const fallbackItems = biliResult.value.data?.items || [];
        if ((nextTotals.bilibili_collect || 0) + (nextTotals.bilibili_like || 0) + (nextTotals.bilibili_post || 0) === 0) {
          const fallbackBuckets: Record<ChannelMode, PlatformLibraryItem[]> = {
            collect: [],
            like: [],
            post: [],
          };
          fallbackItems.forEach((item) => {
            const mode = item.source_mode === 'collect' || item.source_mode === 'like'
              ? item.source_mode
              : 'post';
            fallbackBuckets[mode].push(item);
          });
          (Object.keys(fallbackBuckets) as ChannelMode[]).forEach((mode) => {
            const key = `bilibili_${mode}` as ChannelKey;
            nextPreviews[key] = toPlatformPreviews(fallbackBuckets[mode]);
            nextTotals[key] = fallbackBuckets[mode].length;
          });
        }
      }
      setChannelPreviews(nextPreviews);
      setChannelTotals(nextTotals);
      setActiveModes({
        douyin: (nextTotals.douyin_collect || 0) > 0
          ? 'collect'
          : (nextTotals.douyin_like || 0) > 0
            ? 'like'
            : 'post',
        bilibili: (nextTotals.bilibili_collect || 0) > 0
          ? 'collect'
          : (nextTotals.bilibili_like || 0) > 0
            ? 'like'
            : 'post',
      });
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

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

  return (
    <main className={styles.home}>
      <div className={styles.mobileBrandBar}>
        <Link href="/" className={styles.mobileBrand} aria-label="知萃首页">
          <img src="/icons/icon-192.png" alt="" width={34} height={34} />
          <strong>知萃</strong>
        </Link>
        <Link href="/settings" className={styles.mobileSettings} aria-label="打开设置">
          <GearSix size={21} weight="regular" aria-hidden="true" />
        </Link>
      </div>

      <header className={styles.welcome}>
        <div>
          <p>{welcome.date}</p>
          <h1>
            {welcome.greeting}{displayName ? `，${displayName}` : ''}
          </h1>
        </div>
        <Link href="/library?sync=1" className={styles.welcomeSync}>
          <ArrowsClockwise size={16} weight="regular" aria-hidden="true" />
          同步视频
        </Link>
      </header>

      <section className={styles.start} aria-labelledby="workspace-start-title">
        <div className={styles.intro}>
          <span className={styles.sectionLabel}>
            <Sparkle size={14} weight="fill" aria-hidden="true" />
            视频知识助手
          </span>
          <h2 id="workspace-start-title">从视频里找答案</h2>
        </div>

        <div className={styles.startAction}>
          <Link href="/harness?new=1&source_scope=all_ready" className={styles.askEntry}>
            <span className={styles.askIcon} aria-hidden="true">
              <ChatCircleDots size={20} weight="duotone" />
            </span>
            <span className={styles.askCopy}>
              <strong>问点什么</strong>
              <small>基于已同步的视频直接提问</small>
            </span>
            <span className={styles.askArrow} aria-hidden="true">
              <ArrowRight size={16} weight="bold" />
            </span>
          </Link>

          <div className={styles.sourceStatus} data-empty={readyCount === 0} role="status">
            <span aria-hidden="true" />
            {sourceStatus}
            <Link href="/library">管理资料</Link>
          </div>
        </div>
      </section>

      <section className={styles.channels} aria-labelledby="channel-stats-title">
        <header>
          <div>
            <span className={styles.sectionLabel}>渠道动态</span>
            <h2 id="channel-stats-title">最新同步</h2>
          </div>
          <Link href="/library">
            管理
            <ArrowRight size={14} weight="bold" aria-hidden="true" />
          </Link>
        </header>
        <div className={styles.platformGrid}>
          {CHANNEL_PLATFORMS.map((platform) => {
            const activeMode = activeModes[platform.key];
            const activeConfig = platform.modes.find((mode) => mode.key === activeMode) || platform.modes[0];
            const activeKey = `${platform.key}_${activeMode}` as ChannelKey;
            const previews = channelPreviews[activeKey] || [];
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
                  <Link href={`/library?platform=${platform.key}`}>
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
                        onClick={() => setActiveModes((current) => ({ ...current, [platform.key]: mode }))}
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
                      <Link
                        key={preview.key}
                        href={preview.href}
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
                          />
                        </span>
                        <span className={styles.channelCardScrim} aria-hidden="true" />
                        <span className={styles.channelCardBody}>
                          <strong>{preview.title}</strong>
                          <small>{preview.author}</small>
                        </span>
                      </Link>
                    ))
                  ) : (
                    <div className={styles.channelEmpty}>{activeConfig.empty}</div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <div className={styles.utilityArea}>
        <nav className={styles.tools} aria-label="常用操作">
          <Link href="/library?sync=1" className={styles.toolAction}>
            <span className={styles.toolIcon} aria-hidden="true">
              <ArrowsClockwise size={19} weight="regular" />
            </span>
            <span>
              <strong>同步视频</strong>
              <small>更新渠道与作品</small>
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
