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

export interface DailyRecapStatus { busy: boolean; message: string }

/** 首页操作区的日常回顾：继承现有主题，清楚标明首次同步时间，桌面与移动端共用。 */
export default function DailyRecap({ videoActions, videoInteractions, kind = 'yesterday', launchToken = 0, onStatusChange }: { videoActions: HomeVideoActions; videoInteractions: HomeVideoInteractions; kind?: DailyRecapKind; launchToken?: number; onStatusChange?: (status: DailyRecapStatus) => void }) {
  const { user } = useAuth();
  // 更换账号时整个回顾状态重建，旧账号的数据不会短暂显示给新账号。
  return user?.id ? <DailyRecapContent key={`${user.id}:${kind}`} userId={user.id} profileKey={user.agent_profile_key || 'guest'} kind={kind} launchToken={launchToken} onStatusChange={onStatusChange} videoActions={videoActions} videoInteractions={videoInteractions} /> : null;
}

function DailyRecapContent({ userId, profileKey, kind, launchToken, onStatusChange, videoActions, videoInteractions }: { userId: string; profileKey: string; kind: DailyRecapKind; launchToken: number; onStatusChange?: (status: DailyRecapStatus) => void; videoActions: HomeVideoActions; videoInteractions: HomeVideoInteractions }) {
  const router = useRouter();
  const [recap, setRecap] = useState<DailyRecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prepareError, setPrepareError] = useState('');
  const [revision, setRevision] = useState(0);
  const [preparing, setPreparing] = useState(false);
  useWebBuildActivity(`home-recap-${kind}`, preparing);
  const [progress, setProgress] = useState('');
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const prepareRequest = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const consumedLaunchToken = useRef(0);
  const latestActions = useRef(videoActions);
  latestActions.current = videoActions;

  useEffect(() => {
    onStatusChange?.({ busy: preparing, message: progress || prepareError || error });
  }, [preparing, progress, prepareError, error, onStatusChange]);

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
    if (!videoActions.ready || prepareRequest.current) return;
    const controller = new AbortController();
    prepareRequest.current = controller;
    setPreparing(true);
    setError('');
    setPrepareError('');
    setProgress(`正在准备${kind === 'today' ? '今日' : '昨日'}资料…`);
    setProgressPercent(null);
    const reportProgress = (message: string) => {
      if (controller.signal.aborted) return;
      setProgress(message);
      const extraction = /(?:完成|已检查|已导入)\s*(\d+)\s*\/\s*(\d+)/.exec(message);
      setProgressPercent(extraction
        ? Math.min(100, Math.round(Number(extraction[1]) / Math.max(1, Number(extraction[2])) * 100))
        : null);
    };
    try {
      // 初次读取失败后，顶部入口也能重新读取并继续，无需先点卡片里的重试。
      const currentRecap = recap || await (kind === 'today' ? getDailyAnalysis : getDailyRecap)(dailyRecapTimezone(), controller.signal);
      if (controller.signal.aborted) return;
      const selectedItems = currentRecap.items.filter((item) => latestActions.current.visible(item));
      if (kind === 'yesterday' && !selectedItems.length) {
        throw new Error(currentRecap.total > 0
          ? '昨日资料已隐藏，暂无可用于回顾的内容。'
          : '昨天没有新同步的喜欢或收藏，暂无可生成回顾的资料。');
      }
      const result = await prepareDailyRecap({ ...currentRecap, items: selectedItems, preview: selectedItems.slice(0, 3) },
        reportProgress, controller.signal, userId, kind, {
          ...(kind === 'today' ? { beforePrepare: () => syncDailyAnalysisSources({
            userId, profileKey,
            signal: controller.signal, onProgress: reportProgress,
          }) } : {}),
          isVisible: (item) => latestActions.current.visible(item),
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
        setProgressPercent(null);
        setRevision((value) => value + 1);
      }
    }
  };

  useEffect(() => {
    if (launchToken <= 0 || consumedLaunchToken.current >= launchToken) return;
    // 运行中的重复点击直接消费，失败后不能自动排队再同步一轮。
    if (preparing || prepareRequest.current) { consumedLaunchToken.current = launchToken; return; }
    if (loading || !videoActions.ready) return;
    consumedLaunchToken.current = launchToken;
    void prepare();
  }, [kind, launchToken, loading, recap, preparing, videoActions.ready]);

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
        <p className={styles.description}>{kind === 'today' ? '自动同步已连接账号的喜欢与收藏，生成总结后进入知萃 AI 继续追问。' : '自动补齐昨天新同步的喜欢与收藏文稿，生成总结后进入知萃 AI 继续追问。'}</p>
      </div>

      <div className={styles.action}>
        {available || (kind === 'today' && !loading && !error) ? (
          <button className={styles.primary} type="button" onClick={() => void prepare()} disabled={preparing || loading || !videoActions.ready}>
            {preparing ? <ArrowsClockwise size={18} className={styles.spinning} aria-hidden="true" /> : <Sparkle size={18} aria-hidden="true" />}
            {preparing ? (kind === 'today' ? '正在同步并分析' : '正在整理昨日回顾') : prepareError ? '重试分析' : kind === 'today' ? '同步并分析今天' : '分析昨天并进入 AI'}
            {!preparing ? <ArrowRight size={16} aria-hidden="true" /> : null}
          </button>
        ) : !loading && !error ? (
          <Link href="/library?sync=1" className={styles.primary}>同步视频 <ArrowRight size={16} aria-hidden="true" /></Link>
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
        <p className={styles.empty}>{recap && recap.total > 0 ? `${kind === 'today' ? '今日' : '昨日'}视频已隐藏，不会继续出现在首页和资料列表中。` : kind === 'today' ? '今天还没有新同步记录。点击“同步并分析今天”即可开始。' : '昨天没有新同步记录。先同步点赞与收藏，之后就能在这里回顾。'}</p>
      ) : null}

      {preparing ? (
        <div className={styles.progressBlock} role="status" aria-live="polite">
          <div className={styles.progressHeader}><span>{progress}</span><strong>{progressPercent === null ? '处理中' : `本阶段 ${progressPercent}%`}</strong></div>
          <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progressPercent ?? undefined} aria-valuetext={progress}>
            <span data-indeterminate={progressPercent === null} style={{ width: progressPercent === null ? '35%' : `${progressPercent}%` }} />
          </div>
          <p>完成后自动进入知萃 AI 查看总结并继续追问，请保持本页打开。</p>
        </div>
      ) : null}
      {prepareError ? <p className={styles.progress} role="alert">{prepareError}<span>已完成的文稿会保留，点击“重试分析”可重试。<Link href="/library?sync=1">管理平台连接</Link></span></p> : null}
      {error ? <div className={styles.error} role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setLoading(!recap); setRevision((value) => value + 1); }}>重新读取</button></div> : null}
      {recap ? (
        <p className={styles.note}>按知萃首次同步记录，平台未提供实际点赞、收藏时间。{recap.initial_import_count > 0 ? `其中 ${recap.initial_import_count} 条来自首次导入，可能包含更早的收藏。` : ''}{(recap.initial_import_unknown_count || 0) > 0 ? '部分旧记录无法区分是否为首次历史导入。' : ''}</p>
      ) : null}
    </section>
  );
}
