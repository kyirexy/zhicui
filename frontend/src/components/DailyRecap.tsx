'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, ArrowsClockwise, BookmarkSimple, CalendarBlank, Heart, Sparkle } from '@phosphor-icons/react';
import LibraryCoverImage from '@/components/LibraryCoverImage';
import { HomeVideoActionCard, type HomeVideoInteractions } from '@/components/HomeVideoActions';
import type { HomeVideoActions } from '@/lib/hooks/useHomeVideoActions';
import { useWebBuildActivity } from '@/lib/hooks/useWebBuildActivity';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  dailyRecapDateLabel,
  dailyRecapItemHref,
  dailyRecapTimezone,
  getDailyAnalysis,
  getDailyRecap,
  type DailyRecap as DailyRecapData,
} from '@/lib/dailyRecapApi';
import { getLibraryRevision, isLibraryRevisionCurrent, subscribeLibraryUpdates } from '@/lib/libraryUpdates';
import { prepareDailyRecap, type DailyRecapKind } from '@/lib/prepareDailyRecap';
import { syncDailyAnalysisSources } from '@/lib/syncDailyAnalysisSources';
import styles from './DailyRecap.module.css';

/** 首页操作区的日常回顾：继承现有主题，清楚标明首次同步时间，桌面与移动端共用。 */
export default function DailyRecap({ videoActions, videoInteractions, kind = 'yesterday', launchToken = 0 }: { videoActions: HomeVideoActions; videoInteractions: HomeVideoInteractions; kind?: DailyRecapKind; launchToken?: number }) {
  const { user } = useAuth();
  // 更换账号时整个回顾状态重建，旧账号的数据不会短暂显示给新账号。
  return user?.id ? <DailyRecapContent key={`${user.id}:${kind}`} userId={user.id} profileKey={user.agent_profile_key || 'guest'} kind={kind} launchToken={launchToken} videoActions={videoActions} videoInteractions={videoInteractions} /> : null;
}

function DailyRecapContent({ userId, profileKey, kind, launchToken, videoActions, videoInteractions }: { userId: string; profileKey: string; kind: DailyRecapKind; launchToken: number; videoActions: HomeVideoActions; videoInteractions: HomeVideoInteractions }) {
  const router = useRouter();
  const [recap, setRecap] = useState<DailyRecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prepareError, setPrepareError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  useWebBuildActivity(`home-recap-${kind}`, preparing);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const prepareRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const consumedLaunchToken = useRef(0);

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
    const timezone = dailyRecapTimezone();
    const request = kind === 'today'
      ? getDailyAnalysis(timezone, controller.signal)
      : getDailyRecap(timezone, controller.signal);
    void request.then((data) => {
      if (!current()) return;
      setRecap(data);
      setLoading(false);
      setError('');
    }).catch((reason: unknown) => {
      if (!current()) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : `${kind === 'today' ? '今日分析' : '昨日回顾'}暂时未能读取，请重试`);
    });
    return () => controller.abort();
  }, [revision, kind]);

  const prepare = async () => {
    if (!recap || prepareRequest.current || (kind !== 'today' && recap.total === 0)) return;
    const controller = new AbortController();
    prepareRequest.current = controller;
    setPreparing(true);
    setError('');
    setPrepareError('');
    setProgress(`正在准备${kind === 'today' ? '今日' : '昨日'}资料…`);
    setProgressPercent(6);
    try {
      const result = await prepareDailyRecap({ ...recap, items: visibleItems, preview: visibleItems.slice(0, 3) }, (message) => {
        if (controller.signal.aborted) return;
        setProgress(message);
        const extraction = /(?:完成|已检查)\s*(\d+)\s*\/\s*(\d+)/.exec(message);
        const sourceSync = /同步\s+(\d+)\/(\d+)/.exec(message);
        if (sourceSync) {
          const current = Number(sourceSync[1]);
          const total = Math.max(1, Number(sourceSync[2]));
          setProgressPercent(Math.min(42, Math.max(8, Math.round(((current - 1) / total) * 42) + 8)));
        } else if (extraction) {
          const completed = Number(extraction[1]);
          const total = Math.max(1, Number(extraction[2]));
          setProgressPercent(Math.min(76, 8 + Math.round((completed / total) * 68)));
        } else if (/正在生成|恢复已有 AI/.test(message)) {
          setProgressPercent(82);
        } else if (/已经|完成/.test(message)) {
          setProgressPercent(96);
        } else {
          setProgressPercent((value) => Math.max(value, 12));
        }
      }, controller.signal, userId, kind, kind === 'today' ? {
        beforePrepare: () => syncDailyAnalysisSources({
          userId,
          profileKey,
          allowExisting: visibleItems.length > 0,
          signal: controller.signal,
          onProgress: (message) => {
            if (!controller.signal.aborted) setProgress(message);
          },
        }),
        isVisible: (item) => videoActions.visible(item),
      } : {
        isVisible: (item) => videoActions.visible(item),
      });
      if (!controller.signal.aborted) router.push(result.href);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) {
        setPrepareError(reason instanceof Error ? reason.message : `${kind === 'today' ? '分析' : '解析'}暂未完成，已完成的文稿会保留，请重试`);
      }
    } finally {
      if (!controller.signal.aborted) {
        prepareRequest.current = null;
        setPreparing(false);
        setProgress('');
        setProgressPercent(0);
        setRevision((value) => value + 1);
      }
    }
  };

  useEffect(() => {
    if (kind !== 'today' || launchToken <= 0 || consumedLaunchToken.current >= launchToken || loading || !recap || preparing) return;
    consumedLaunchToken.current = launchToken;
    void prepare();
  }, [kind, launchToken, loading, recap, preparing]);

  const visibleItems = recap?.items.filter((item) => videoActions.visible(item)) || [];
  const items = visibleItems.slice(0, expanded ? 100 : 3);
  const available = visibleItems.length > 0;
  const dateLabel = recap ? dailyRecapDateLabel(recap.date) : '';

  return (
    <section className={styles.recap} aria-labelledby={`${kind}-recap-title`} data-loading={loading} data-kind={kind}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          <CalendarBlank size={21} aria-hidden="true" />
          <h2 id={`${kind}-recap-title`}>{kind === 'today' ? '今日分析' : '昨日回顾'}</h2>
          {dateLabel ? <time dateTime={recap?.date}>{dateLabel}</time> : null}
        </div>
        <p className={styles.description}>{kind === 'today' ? '今天新同步的点赞与收藏，快速提取文稿、交给 AI 梳理。' : '昨天新同步的点赞与收藏，一起提取文稿、交给 AI 梳理。'}</p>
      </div>

      <div className={styles.action}>
        {available ? (
          <button className={styles.primary} type="button" onClick={() => void prepare()} disabled={preparing || loading}>
            {preparing ? <ArrowsClockwise size={18} className={styles.spinning} aria-hidden="true" /> : <Sparkle size={18} aria-hidden="true" />}
            {preparing ? '正在提取解析' : prepareError ? '继续提取解析' : kind === 'today' ? '开始今日分析' : '一键提取解析'}
            {!preparing ? <ArrowRight size={16} aria-hidden="true" /> : null}
          </button>
        ) : !loading && !error ? (
          kind === 'today'
            ? <button className={styles.primary} type="button" onClick={() => void prepare()} disabled={preparing}><ArrowsClockwise size={18} aria-hidden="true" />同步并分析 <ArrowRight size={16} aria-hidden="true" /></button>
            : <Link href="/library?sync=1" className={styles.primary}>同步视频 <ArrowRight size={16} aria-hidden="true" /></Link>
        ) : null}
        {recap && available && !preparing ? (
            <span className={styles.readyCount}>{visibleItems.filter((item) => item.transcript_ready).length} 条文稿已就绪，已有文稿直接复用</span>
        ) : null}
        {recap?.has_more && available ? <span className={styles.scopeLimit}>本次解析当前 {visibleItems.length} 条</span> : null}
      </div>

      {loading || !videoActions.ready ? (
        <div className={styles.loading} role="status"><span className={styles.loadingBar} aria-hidden="true" />正在读取{kind === 'today' ? '今日' : '昨日'}记录…</div>
      ) : available && recap ? (
        <>
          <div className={styles.counts}>
            <strong>{recap.has_more ? '当前 ' : ''}{visibleItems.length.toLocaleString('zh-CN')} 条视频</strong>
            <span><Heart size={15} aria-hidden="true" />喜欢 {visibleItems.filter((item) => item.source_modes.includes('like')).length}</span>
            <span><BookmarkSimple size={15} aria-hidden="true" />收藏 {visibleItems.filter((item) => item.source_modes.includes('collect')).length}</span>
            {visibleItems.length > 3 ? (
              <button type="button" aria-expanded={expanded} aria-controls={`${kind}-recap-items`} onClick={() => setExpanded((value) => !value)}>
                {expanded ? '收起列表' : '查看列表'}<ArrowRight size={14} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <ul id={`${kind}-recap-items`} className={styles.items} data-expanded={expanded}>
            {items.map((item) => (
              <li key={item.id}>
                <HomeVideoActionCard video={item} actions={videoActions} interactions={videoInteractions} variant="recap">
                <Link href={dailyRecapItemHref(item)} draggable={false} className={styles.item} aria-label={`打开视频：${item.title}`}>
                  <span className={styles.cover} aria-hidden="true">
                    <LibraryCoverImage src={item.cover_url} fallbackClassName={styles.coverFallback} retryable={false} iconSize={18} />
                  </span>
                  <span className={styles.itemCopy}>
                    <strong>{item.title || '未命名视频'}</strong>
                    <small>{item.platform === 'douyin' ? '抖音' : 'B站'}{item.author_name ? ` · ${item.author_name}` : ''}</small>
                  </span>
                </Link>
                </HomeVideoActionCard>
              </li>
            ))}
          </ul>
          {expanded && recap.has_more ? <p className={styles.note}>先展示 {visibleItems.length} 条，其余记录可在视频资料中查看。</p> : null}
        </>
      ) : !error ? (
        <p className={styles.empty}>{recap && recap.total > 0 ? `${kind === 'today' ? '今日' : '昨日'}视频已隐藏，不会继续出现在首页和资料列表中。` : kind === 'today' ? '今天还没有新同步记录。先同步点赞与收藏，之后就能在这里分析。' : '昨天没有新同步记录。先同步点赞与收藏，之后就能在这里回顾。'}</p>
      ) : null}

      {preparing ? (
        <div className={styles.progressBlock} role="status" aria-live="polite">
          <div className={styles.progressHeader}><span>{progress}</span><strong>{progressPercent}%</strong></div>
          <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent} aria-valuetext={`${progressPercent}%，${progress}`}>
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <p>完成的文稿会保存，可以继续浏览其他资料。</p>
        </div>
      ) : null}
      {prepareError ? <p className={styles.progress} role="alert">{prepareError}<span>已完成的文稿会保留，点击“继续提取解析”可重试。</span></p> : null}
      {error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setLoading(!recap); setRevision((value) => value + 1); }}>重新读取</button></div> : null}
      {recap ? (
        <p className={styles.note}>按知萃首次同步记录，平台未提供实际点赞、收藏时间。{recap.initial_import_count > 0 ? `其中 ${recap.initial_import_count} 条来自首次导入，可能包含更早的收藏。` : ''}{(recap.initial_import_unknown_count || 0) > 0 ? '部分旧记录无法区分是否为首次历史导入。' : ''}</p>
      ) : null}
    </section>
  );
}
