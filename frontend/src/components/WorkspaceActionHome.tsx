'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowsClockwise,
  CalendarCheck,
  ChatCircleDots,
  GearSix,
  LinkSimple,
  Sparkle,
  VideoCamera,
} from '@phosphor-icons/react';
import { listAgentSources, listAgentThreads } from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import type { AgentThread } from '@/lib/types';
import styles from './WorkspaceActionHome.module.css';

interface Props {
  onOpenSingleLink?: () => void;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date);
}

export default function WorkspaceActionHome({ onOpenSingleLink }: Props) {
  const { user } = useAuth();
  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [readyCount, setReadyCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      listAgentThreads(),
      listAgentSources('all_ready', '', undefined, [], 1),
    ]).then(([threadResult, sourceResult]) => {
      if (!active) return;
      if (threadResult.status === 'fulfilled' && threadResult.value.success) {
        setThreads((threadResult.value.data?.items || []).slice(0, 3));
      }
      if (sourceResult.status === 'fulfilled' && sourceResult.value.success) {
        setReadyCount(
          sourceResult.value.data?.ready_count
          ?? sourceResult.value.data?.total
          ?? 0,
        );
      }
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
        <p>{welcome.date}</p>
        <h1>
          {welcome.greeting}{displayName ? `，${displayName}` : ''}
        </h1>
        <span>从一个真正想弄明白的问题开始。</span>
      </header>

      <section className={styles.start} aria-labelledby="workspace-start-title">
        <div className={styles.intro}>
          <span className={styles.sectionLabel}>
            <Sparkle size={14} weight="fill" aria-hidden="true" />
            视频知识助手
          </span>
          <h2 id="workspace-start-title">今天想从视频里了解什么？</h2>
          <p>选择一条或一组已同步的视频，知萃会先读完原文，再带着依据回答。</p>
        </div>

        <Link href="/agent?new=1&source_scope=all_ready" className={styles.askEntry}>
          <span className={styles.askIcon} aria-hidden="true">
            <ChatCircleDots size={20} weight="duotone" />
          </span>
          <span className={styles.askCopy}>
            <strong>输入你的问题</strong>
            <small>例如：这些视频里，新手最应该先做什么？</small>
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
      </section>

      <nav
        className={styles.tools}
        data-single-link={onOpenSingleLink ? 'true' : 'false'}
        aria-label="常用操作"
      >
        <Link href="/library" className={`${styles.toolAction} ${styles.primaryTool}`}>
          <span className={styles.toolIcon} aria-hidden="true">
            <ArrowsClockwise size={19} weight="regular" />
          </span>
          <span>
            <strong>同步视频</strong>
            <small>更新收藏与作品</small>
          </span>
          <ArrowRight size={15} weight="bold" aria-hidden="true" />
        </Link>
        {onOpenSingleLink && (
          <button type="button" className={styles.toolAction} onClick={onOpenSingleLink}>
            <span className={styles.toolIcon} aria-hidden="true">
              <LinkSimple size={19} weight="regular" />
            </span>
            <span>
              <strong>解析链接</strong>
              <small>处理单条内容</small>
            </span>
            <ArrowRight size={15} weight="bold" aria-hidden="true" />
          </button>
        )}
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
      </nav>

      <section className={styles.recent} aria-labelledby="recent-conversations-title">
        <header>
          <div>
            <span className={styles.sectionLabel}>最近使用</span>
            <h2 id="recent-conversations-title">继续上次的会话</h2>
          </div>
          {threads.length > 0 && (
            <Link href="/agent">
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
                href={`/agent?thread=${encodeURIComponent(thread.id)}`}
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
            <Link href="/agent?new=1&source_scope=all_ready">
              创建会话
              <ArrowRight size={14} weight="bold" aria-hidden="true" />
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
