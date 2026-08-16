'use client';

import { useState } from 'react';
import { CheckCircle2, CircleAlert, LoaderCircle, RotateCcw, X } from 'lucide-react';
import {
  cancelVideoAnalysisRun,
  confirmVideoAnalysisRun,
  getVideoAnalysisCatalog,
  prepareVideoAnalysis,
} from '@/lib/api';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import type {
  VideoAnalysisCatalog,
  VideoAnalysisOffering,
  VideoAnalysisPrepareResult,
  VideoAnalysisRun,
} from '@/lib/types';
import {
  catalogOfferings,
  createVideoAnalysisIdempotencyKey,
  formatPoints,
  isActiveVideoAnalysisStatus,
  recommendedOffering,
  runItemCount,
  videoAnalysisItemStatusLabel,
  videoAnalysisStatusLabel,
  videoAnalysisStageLabel,
} from '@/lib/videoAnalysis';
import VideoAnalysisQuoteSheet from './VideoAnalysisQuoteSheet';
import styles from './VideoAnalysis.module.css';

function runTitle(run: VideoAnalysisRun): string {
  if (run.offering_name) return run.offering_name;
  if (run.use_byok) return '使用我的视觉模型';
  return '详细视频解析';
}

function RunRow({ run }: { run: VideoAnalysisRun }) {
  const { refreshActive, refreshRecent, trackRun } = useVideoAnalysis();
  const [cancelling, setCancelling] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<VideoAnalysisCatalog | null>(null);
  const [prepared, setPrepared] = useState<VideoAnalysisPrepareResult | null>(null);
  const [selectedOffering, setSelectedOffering] = useState<VideoAnalysisOffering | null>(null);
  const [useByok, setUseByok] = useState(Boolean(run.use_byok));
  const [sheetOpen, setSheetOpen] = useState(false);
  const active = isActiveVideoAnalysisStatus(run.status);
  const needsAction = run.status === 'reauthorization_required';
  const completed = run.status === 'succeeded' || run.status === 'partial';
  const count = runItemCount(run);
  const noteIds = run.note_ids?.length
    ? run.note_ids
    : run.items?.map(item => item.note_id).filter(Boolean) || [];
  const settled = run.actual_points ?? run.items?.reduce(
    (total, item) => total + Number(item.actual_points || 0),
    0,
  );

  const returnToAgent = () => {
    const suffix = run.agent_thread_id
      ? `?thread=${encodeURIComponent(run.agent_thread_id)}`
      : '';
    window.location.assign(`/agent${suffix}`);
  };

  const cancel = async () => {
    if (run.trigger === 'agent') {
      returnToAgent();
      return;
    }
    setCancelling(true);
    setError('');
    const response = await cancelVideoAnalysisRun(run.id);
    setCancelling(false);
    if (!response.success) {
      setError(response.error || '暂时无法取消任务');
      return;
    }
    await Promise.all([refreshActive(), refreshRecent()]);
  };

  const prepareQuote = async (
    offeringOverride?: VideoAnalysisOffering,
    byokOverride = useByok,
  ) => {
    if (run.trigger === 'agent') {
      returnToAgent();
      return;
    }
    if (!noteIds.length) {
      setError('任务缺少可重新报价的视频，请回到资料详情重试');
      return;
    }
    setPreparing(true);
    setSheetOpen(true);
    setError('');
    let nextCatalog = catalog;
    if (!nextCatalog) {
      const catalogResponse = await getVideoAnalysisCatalog(
        noteIds,
        run.trigger === 'batch' ? 'batch' : 'manual',
      );
      if (!catalogResponse.success || !catalogResponse.data) {
        setPreparing(false);
        setError(catalogResponse.error || '暂时无法读取可用解析方案');
        return;
      }
      nextCatalog = catalogResponse.data;
      setCatalog(nextCatalog);
    }
    const target = offeringOverride
      || catalogOfferings(nextCatalog).find(item => item.id === run.offering_id)
      || recommendedOffering(nextCatalog);
    if (!nextCatalog.enabled || !target) {
      setPreparing(false);
      setError('当前没有可发布的详细解析方案');
      return;
    }
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
    }
    setSelectedOffering(target);
    setUseByok(byokOverride);
    setPrepared(null);
    const response = await prepareVideoAnalysis({
      note_ids: noteIds,
      offering_id: target.id,
      use_byok: byokOverride,
      trigger: run.trigger === 'batch' ? 'batch' : 'manual',
    });
    setPreparing(false);
    if (!response.success || !response.data) {
      setError(response.error || '重新报价失败，请稍后重试');
      return;
    }
    setPrepared(response.data);
    const nextRun = { ...response.data.run, items: response.data.items };
    if (nextRun.status === 'succeeded' || nextRun.status === 'partial') {
      await cancelVideoAnalysisRun(run.id);
      setSheetOpen(false);
      await Promise.all([refreshActive(), refreshRecent()]);
      return;
    }
    if (!response.data.requires_confirmation && (response.data.can_start ?? response.data.can_auto_start)) {
      await cancelVideoAnalysisRun(run.id);
      setSheetOpen(false);
      trackRun(nextRun);
      await refreshActive();
    }
  };

  const confirmQuote = async () => {
    if (!prepared?.run.id) return;
    setConfirming(true);
    setError('');
    const cancellation = await cancelVideoAnalysisRun(run.id);
    if (!cancellation.success) {
      setConfirming(false);
      setError(cancellation.error || '旧授权暂时无法关闭，请稍后重试');
      return;
    }
    const response = await confirmVideoAnalysisRun(
      prepared.run.id,
      createVideoAnalysisIdempotencyKey(prepared.run.id),
    );
    setConfirming(false);
    if (!response.success || !response.data) {
      setError(response.error || '新报价确认失败，请重新报价');
      return;
    }
    setSheetOpen(false);
    trackRun(response.data);
    await refreshActive();
  };

  const closeQuote = async () => {
    if (confirming) return;
    setSheetOpen(false);
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
      setPrepared(null);
    }
  };

  return (
    <article className={styles.taskRow} data-status={run.status}>
      <span className={styles.taskIcon} aria-hidden="true">
        {active ? (
          <LoaderCircle size={17} className="animate-spin" />
        ) : completed ? (
          <CheckCircle2 size={17} />
        ) : (
          <CircleAlert size={17} />
        )}
      </span>
      <div className={styles.taskCopy}>
        <strong>{runTitle(run)}</strong>
        <span>{videoAnalysisStageLabel(run.current_stage) || videoAnalysisStatusLabel(run.status)} · {count} 条视频</span>
        {completed && (
          <small>
            实际使用 {formatPoints(settled)}
            {Number(run.released_points || 0) > 0 ? ` · 已释放 ${formatPoints(run.released_points)}` : ''}
          </small>
        )}
        {run.error && <small className={styles.taskError}>{run.error}</small>}
        {error && <small className={styles.taskError} role="alert">{error}</small>}
        {run.items && run.items.length > 0 && (
          <details className={styles.taskItems}>
            <summary>查看逐项结果</summary>
            <div>
              {run.items.map(item => (
                <span key={item.id}>
                  <span>
                    <strong>{item.title || `视频 ${item.note_id.slice(0, 8)}`}</strong>
                    <small>{videoAnalysisItemStatusLabel(item.status)}</small>
                  </span>
                  <b>{formatPoints(item.actual_points || 0)}</b>
                </span>
              ))}
            </div>
          </details>
        )}
      </div>
      {(active || needsAction) && (
        <div className={styles.taskActions}>
          {needsAction && (
            <button
              type="button"
              onClick={() => void prepareQuote()}
              disabled={preparing || cancelling}
            >
              {preparing ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}
              {run.trigger === 'agent' ? '返回 Agent' : '重新报价'}
            </button>
          )}
          {run.trigger === 'agent' ? (
            !needsAction && (
              <button type="button" onClick={returnToAgent}>
                返回 Agent
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={cancelling || confirming}
              aria-label={`取消${runTitle(run)}`}
              title="取消任务"
            >
              {cancelling ? <LoaderCircle size={15} className="animate-spin" /> : <X size={15} />}
            </button>
          )}
        </div>
      )}
      <VideoAnalysisQuoteSheet
        open={sheetOpen}
        onClose={() => void closeQuote()}
        catalog={catalog}
        prepared={prepared}
        selectedOffering={selectedOffering}
        useByok={useByok}
        itemCount={count}
        preparing={preparing}
        confirming={confirming}
        error={error}
        onSelect={(offering, withByok) => void prepareQuote(offering, withByok)}
        onConfirm={() => void confirmQuote()}
      />
    </article>
  );
}

export default function VideoAnalysisTaskList() {
  const { activeRuns, attentionRuns, recentRuns, loading, error } = useVideoAnalysis();
  const recent = recentRuns
    .filter(run => (
      !activeRuns.some(active => active.id === run.id)
      && !attentionRuns.some(attention => attention.id === run.id)
    ))
    .slice(0, 8);

  return (
    <div className={styles.taskList} aria-live="polite">
      {loading ? (
        <div className={styles.taskEmpty} role="status">
          <LoaderCircle size={18} className="animate-spin" />
          正在恢复解析任务
        </div>
      ) : error && !activeRuns.length && !attentionRuns.length && !recent.length ? (
        <div className={styles.taskEmpty} role="alert">
          <CircleAlert size={18} />
          {error}
        </div>
      ) : !activeRuns.length && !attentionRuns.length && !recent.length ? (
        <div className={styles.taskEmpty}>
          <CheckCircle2 size={18} />
          当前没有解析任务
        </div>
      ) : (
        <>
          {activeRuns.length > 0 && (
            <section aria-labelledby="active-video-analysis-title">
              <h3 id="active-video-analysis-title">进行中</h3>
              <div>{activeRuns.map(run => <RunRow key={run.id} run={run} />)}</div>
            </section>
          )}
          {attentionRuns.length > 0 && (
            <section aria-labelledby="attention-video-analysis-title">
              <h3 id="attention-video-analysis-title">需要处理</h3>
              <div>{attentionRuns.map(run => <RunRow key={run.id} run={run} />)}</div>
            </section>
          )}
          {recent.length > 0 && (
            <section aria-labelledby="recent-video-analysis-title">
              <h3 id="recent-video-analysis-title">最近完成</h3>
              <div>{recent.map(run => <RunRow key={run.id} run={run} />)}</div>
            </section>
          )}
        </>
      )}
      <p className={styles.taskFootnote}>任务可以离页运行。视频和关键帧只在处理期间临时使用，完成后删除。</p>
    </div>
  );
}
