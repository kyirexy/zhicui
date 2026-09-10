'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowsClockwise, BookmarkSimple, CalendarBlank, Heart, Sparkle } from '@phosphor-icons/react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  dailyRecapDateLabel,
  dailyRecapItemHref,
  dailyRecapTimezone,
  getDailyRecap,
  type DailyRecap as DailyRecapData,
} from '@/lib/dailyRecapApi';
import { getLibraryRevision, isLibraryRevisionCurrent, subscribeLibraryUpdates } from '@/lib/libraryUpdates';
import { prepareDailyRecap } from '@/lib/prepareDailyRecap';
import styles from './DailyRecap.module.css';

/** 首页操作区的日常回顾：继承现有主题，清楚标明首次同步时间，桌面与移动端共用。 */
export default function DailyRecap() {
  const { user } = useAuth();
  // 更换账号时整个回顾状态重建，旧账号的数据不会短暂显示给新账号。
  return user?.id ? <DailyRecapContent key={user.id} userId={user.id} /> : null;
}

function DailyRecapContent({ userId }: { userId: string }) {
  const router = useRouter();
  const [recap, setRecap] = useState<DailyRecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prepareError, setPrepareError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const [progress, setProgress] = useState('');
  const [expanded, setExpanded] = useState(false);
  const prepareRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    const unsubscribe = subscribeLibraryUpdates(refresh);
    let day = new Intl.DateTimeFormat('en-CA', { timeZone: dailyRecapTimezone() }).format(new Date());
    const timer = setInterval(() => {
      const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: dailyRecapTimezone() }).format(new Date());
      if (nextDay === day) return;
      day = nextDay;
      setRecap(null);
      setLoading(true);
      setExpanded(false);
      refresh();
    }, 60_000);
    return () => { unsubscribe(); clearInterval(timer); prepareRequest.current?.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sequence = ++requestSequence.current;
    const libraryRevision = getLibraryRevision();
    const current = () => !controller.signal.aborted && sequence === requestSequence.current
      && isLibraryRevisionCurrent(libraryRevision);
    void getDailyRecap(dailyRecapTimezone(), controller.signal).then((data) => {
      if (!current()) return;
      setRecap(data);
      setLoading(false);
      setError('');
    }).catch((reason: unknown) => {
      if (!current()) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : '昨日回顾暂时未能读取，请重试');
    });
    return () => controller.abort();
  }, [revision]);

  const prepare = async () => {
    if (!recap || recap.total === 0 || prepareRequest.current) return;
    const controller = new AbortController();
    prepareRequest.current = controller;
    setPreparing(true);
    setError('');
    setPrepareError('');
    setProgress('正在准备昨日资料…');
    try {
      const result = await prepareDailyRecap(recap, (message) => {
        if (!controller.signal.aborted) setProgress(message);
      }, controller.signal, userId);
      if (!controller.signal.aborted) router.push(result.href);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) {
        setPrepareError(reason instanceof Error ? reason.message : '解析暂未完成，已完成的文稿会保留，请重试');
      }
    } finally {
      if (!controller.signal.aborted) {
        prepareRequest.current = null;
        setPreparing(false);
        setProgress('');
        setRevision((value) => value + 1);
      }
    }
  };

  const items = recap ? (expanded ? recap.items : recap.preview).slice(0, expanded ? 100 : 3) : [];
  const available = Boolean(recap && recap.total > 0);
  const dateLabel = recap ? dailyRecapDateLabel(recap.date) : '';

  return (
    <section className={styles.recap} aria-labelledby="daily-recap-title" data-loading={loading}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <CalendarBlank size={21} aria-hidden="true" />
          <h2 id="daily-recap-title">昨日回顾</h2>
          {dateLabel ? <time dateTime={recap?.date}>{dateLabel}</time> : null}
        </div>
        <p className={styles.description}>昨天新同步的点赞与收藏，一起提取文稿、交给 AI 梳理。</p>
      </div>

      <div className={styles.action}>
        {available ? (
          <button className={styles.primary} type="button" onClick={() => void prepare()} disabled={preparing || loading}>
            {preparing ? <ArrowsClockwise size={18} className={styles.spinning} aria-hidden="true" /> : <Sparkle size={18} aria-hidden="true" />}
            {preparing ? '正在提取解析' : prepareError ? '继续提取解析' : '一键提取解析'}
            {!preparing ? <ArrowRight size={16} aria-hidden="true" /> : null}
          </button>
        ) : !loading && !error ? (
          <Link href="/library?sync=1" className={styles.primary}>同步视频 <ArrowRight size={16} aria-hidden="true" /></Link>
        ) : null}
        {recap && available && !preparing ? (
          <span className={styles.readyCount}>{recap.ready_count} 条文稿已就绪，已有文稿直接复用</span>
        ) : null}
        {recap?.has_more ? <span className={styles.scopeLimit}>本次解析前 {recap.items.length} 条</span> : null}
      </div>

      {loading ? (
        <div className={styles.loading} role="status"><span className={styles.loadingBar} aria-hidden="true" />正在读取昨日记录…</div>
      ) : available && recap ? (
        <>
          <div className={styles.counts}>
            <strong>{recap.total.toLocaleString('zh-CN')} 条视频</strong>
            <span><Heart size={15} aria-hidden="true" />喜欢 {recap.like_count}</span>
            <span><BookmarkSimple size={15} aria-hidden="true" />收藏 {recap.collect_count}</span>
            {recap.total > 3 ? (
              <button type="button" aria-expanded={expanded} aria-controls="daily-recap-items" onClick={() => setExpanded((value) => !value)}>
                {expanded ? '收起列表' : '查看列表'}<ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <ul id="daily-recap-items" className={styles.items} data-expanded={expanded}>
            {items.map((item) => (
              <li key={item.id}>
                <Link href={dailyRecapItemHref(item)} className={styles.item} aria-label={`打开视频：${item.title}`}>
                  <span className={styles.cover} aria-hidden="true">
                    <LibraryCoverImage src={item.cover_url} fallbackClassName={styles.coverFallback} retryable={false} iconSize={18} />
                  </span>
                  <span className={styles.itemCopy}>
                    <strong>{item.title || '未命名视频'}</strong>
                    <small>{item.platform === 'douyin' ? '抖音' : 'B站'}{item.author_name ? ` · ${item.author_name}` : ''}</small>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {expanded && recap.has_more ? <p className={styles.note}>先展示前 {recap.items.length} 条，其余记录可在视频资料中查看。</p> : null}
        </>
      ) : !error ? (
        <p className={styles.empty}>昨天没有新同步记录。先同步点赞与收藏，之后就能在这里回顾。</p>
      ) : null}

      {preparing ? <p className={styles.progress} role="status">{progress}<span>完成的文稿会保存，可以继续浏览其他资料。</span></p> : null}
      {prepareError ? <p className={styles.progress} role="alert">{prepareError}<span>已完成的文稿会保留，点击“继续提取解析”可重试。</span></p> : null}
      {error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setLoading(!recap); setRevision((value) => value + 1); }}>重新读取</button></div> : null}
      {recap ? (
        <p className={styles.note}>按知萃首次同步记录，平台未提供实际点赞、收藏时间。{recap.initial_import_count > 0 ? `其中 ${recap.initial_import_count} 条来自首次导入，可能包含更早的收藏。` : ''}{(recap.initial_import_unknown_count || 0) > 0 ? '部分旧记录无法区分是否为首次历史导入。' : ''}</p>
      ) : null}
    </section>
  );
}
