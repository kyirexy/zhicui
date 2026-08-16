'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Eye, LoaderCircle, RotateCcw } from 'lucide-react';
import {
  cancelVideoAnalysisRun,
  confirmVideoAnalysisRun,
  getVideoAnalysisCatalog,
  getVideoAnalysisAccount,
  getVideoAnalysisRun,
  prepareVideoAnalysis,
} from '@/lib/api';
import { useVideoAnalysis } from '@/lib/hooks/VideoAnalysisContext';
import type {
  DetailedVideoAnalysisSummary,
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
  offeringIsFree,
  recommendedOffering,
  videoAnalysisStatusLabel,
  videoAnalysisStageLabel,
} from '@/lib/videoAnalysis';
import VideoAnalysisQuoteSheet from './VideoAnalysisQuoteSheet';
import styles from './VideoAnalysis.module.css';

interface VideoAnalysisEntryProps {
  noteId: string;
  hasSummary: boolean;
  existing?: DetailedVideoAnalysisSummary | null;
  onCompleted?: () => void | Promise<void>;
}

function formatUpdatedAt(value?: string): string {
  if (!value) return '最近更新';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(parsed);
}

export default function VideoAnalysisEntry({
  noteId,
  hasSummary,
  existing,
  onCompleted,
}: VideoAnalysisEntryProps) {
  const { activeRuns, attentionRuns, trackRun, refreshActive } = useVideoAnalysis();
  const [catalog, setCatalog] = useState<VideoAnalysisCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedOffering, setSelectedOffering] = useState<VideoAnalysisOffering | null>(null);
  const [useByok, setUseByok] = useState(false);
  const [prepared, setPrepared] = useState<VideoAnalysisPrepareResult | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [run, setRun] = useState<VideoAnalysisRun | null>(null);
  const [error, setError] = useState('');
  const completedRunRef = useRef<string | null>(null);
  const reauthorizationRunRef = useRef<VideoAnalysisRun | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    const [response, accountResponse] = await Promise.all([
      getVideoAnalysisCatalog([noteId]),
      getVideoAnalysisAccount(),
    ]);
    if (response.success && response.data) {
      const nextCatalog = {
        ...response.data,
        account: response.data.account || (accountResponse.success ? accountResponse.data : null),
      };
      setCatalog(nextCatalog);
      setSelectedOffering(current => current || recommendedOffering(nextCatalog));
    }
    setLoadingCatalog(false);
  }, [noteId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    const active = [...activeRuns, ...attentionRuns].find(candidate => (
      candidate.note_ids?.includes(noteId)
      || candidate.items?.some(item => item.note_id === noteId)
    ));
    if (active) {
      setRun(active);
      if (active.status === 'reauthorization_required') {
        reauthorizationRunRef.current = active;
      }
    }
  }, [activeRuns, attentionRuns, noteId]);

  useEffect(() => {
    if (!run?.id || !isActiveVideoAnalysisStatus(run.status)) return;
    let cancelled = false;
    const inspect = async () => {
      const response = await getVideoAnalysisRun(run.id);
      if (cancelled || !response.success || !response.data) return;
      const next = { ...response.data.run, items: response.data.items };
      setRun(next);
      if (isActiveVideoAnalysisStatus(next.status)) {
        trackRun(response.data);
        return;
      }
      await refreshActive();
      if ((next.status === 'succeeded' || next.status === 'partial') && completedRunRef.current !== next.id) {
        completedRunRef.current = next.id;
        await onCompleted?.();
      }
    };
    const interval = window.setInterval(() => void inspect(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [onCompleted, refreshActive, run?.id, run?.status, trackRun]);

  const recommended = useMemo(() => recommendedOffering(catalog), [catalog]);
  const available = Boolean(catalog?.enabled && recommended);

  const closePreviousAuthorization = async (): Promise<boolean> => {
    const previous = reauthorizationRunRef.current;
    if (!previous) return true;
    const cancellation = await cancelVideoAnalysisRun(previous.id);
    if (!cancellation.success) {
      setError(cancellation.error || '旧授权暂时无法关闭，请稍后重试');
      return false;
    }
    reauthorizationRunRef.current = null;
    return true;
  };

  const prepare = async (
    offering: VideoAnalysisOffering,
    withByok: boolean,
    showSheet: boolean,
  ) => {
    if (run?.id && run.status === 'reauthorization_required') {
      reauthorizationRunRef.current = run;
    }
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
    }
    setSelectedOffering(offering);
    setUseByok(withByok);
    setPrepared(null);
    setError('');
    if (showSheet) setSheetOpen(true);
    setPreparing(true);
    const response = await prepareVideoAnalysis({
      note_ids: [noteId],
      offering_id: offering.id,
      use_byok: withByok,
      trigger: 'manual',
    });
    setPreparing(false);
    if (!response.success || !response.data) {
      setError(response.error || '暂时无法准备详细解析');
      return;
    }
    setPrepared(response.data);
    const nextRun = { ...response.data.run, items: response.data.items };
    setRun(nextRun);
    if (nextRun.status === 'succeeded' || nextRun.status === 'partial') {
      await closePreviousAuthorization();
      setSheetOpen(false);
      completedRunRef.current = nextRun.id;
      await onCompleted?.();
      return;
    }
    if (
      !response.data.requires_confirmation
      && (response.data.can_start ?? response.data.can_auto_start)
    ) {
      await closePreviousAuthorization();
      setSheetOpen(false);
      trackRun({ run: response.data.run, items: response.data.items });
    } else {
      setSheetOpen(true);
    }
  };

  const requote = async () => {
    const replacement = catalogOfferings(catalog).find(item => item.id === run?.offering_id)
      || recommended;
    if (!replacement) {
      setError('原解析方案已不可用，请联系管理员发布可用方案');
      return;
    }
    setExpanded(true);
    await prepare(replacement, Boolean(run?.use_byok), true);
  };

  const confirm = async () => {
    if (!prepared?.run.id || confirming) return;
    setConfirming(true);
    setError('');
    if (!await closePreviousAuthorization()) {
      setConfirming(false);
      return;
    }
    const response = await confirmVideoAnalysisRun(
      prepared.run.id,
      createVideoAnalysisIdempotencyKey(prepared.run.id),
    );
    setConfirming(false);
    if (!response.success || !response.data) {
      setError(response.error || '解析任务启动失败，请重新报价');
      return;
    }
    setSheetOpen(false);
    const nextRun = { ...response.data.run, items: response.data.items };
    setRun(nextRun);
    if (nextRun.status === 'succeeded' || nextRun.status === 'partial') {
      completedRunRef.current = nextRun.id;
      await onCompleted?.();
    }
    trackRun(response.data);
  };

  const closeSheet = async () => {
    if (confirming) return;
    setSheetOpen(false);
    if (prepared?.run.id && prepared.run.status === 'prepared') {
      await cancelVideoAnalysisRun(prepared.run.id);
      setPrepared(null);
      setRun(current => (
        current?.id === prepared.run.id ? reauthorizationRunRef.current : current
      ));
    }
  };

  if (loadingCatalog && !existing && !run) return null;
  if (!available && !existing && !run) return null;

  const running = Boolean(run && isActiveVideoAnalysisStatus(run.status));
  const requiresAuthorization = run?.status === 'reauthorization_required';
  const succeeded = run?.status === 'succeeded' || run?.status === 'partial';
  const failed = run?.status === 'failed' || run?.status === 'cancelled';

  return (
    <div className={styles.entry}>
      {running ? (
        <div className={styles.runInline} role="status" aria-live="polite">
          <LoaderCircle size={17} className="animate-spin" aria-hidden="true" />
          <span>
            <strong>{videoAnalysisStageLabel(run?.current_stage) || videoAnalysisStatusLabel(run!.status)}</strong>
            <small>可离开此页面，解析会在后台继续</small>
          </span>
        </div>
      ) : requiresAuthorization ? (
        <div className={styles.attentionInline} role="status" aria-live="polite">
          <CircleAlert size={18} aria-hidden="true" />
          <span>
            <strong>需要重新报价与确认</strong>
            <small>{run?.error || '原授权上限已失效，确认新报价后才会继续，不会超额扣费。'}</small>
          </span>
          <button type="button" disabled={preparing} onClick={() => void requote()}>
            {preparing ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            重新报价
          </button>
          {error && <p className={styles.inlineError} role="alert">{error}</p>}
        </div>
      ) : existing || succeeded ? (
        <div className={styles.completedInline} role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          <span>
            <strong>
              {(existing?.status === 'partial' || run?.status === 'partial') ? '部分完成 · ' : ''}
              已结合 {existing?.scene_count ?? run?.items?.[0]?.scene_count ?? 0} 个关键场景
            </strong>
            <small>更新于 {formatUpdatedAt(existing?.updated_at || run?.finished_at || run?.updated_at)}</small>
          </span>
          {available && (
            <button type="button" onClick={() => setExpanded(true)}>重新解析</button>
          )}
        </div>
      ) : failed ? (
        <div className={styles.failedInline} role="status">
          <CircleAlert size={18} aria-hidden="true" />
          <span>
            <strong>{run?.status === 'cancelled' ? '解析已取消' : '详细解析未完成'}</strong>
            <small>{run?.error || '未扣除未使用的萃点，可以重新尝试'}</small>
          </span>
          <button type="button" onClick={() => setExpanded(true)}><RotateCcw size={14} />重试</button>
        </div>
      ) : !expanded ? (
        <button
          type="button"
          className={styles.entryTrigger}
          onClick={() => setExpanded(true)}
        >
          <Eye size={17} aria-hidden="true" />
          {hasSummary ? '补充详细解析' : '视频有演示或画面信息？使用详细解析'}
        </button>
      ) : null}

      {expanded && !running && available && recommended && (
        <div className={styles.recommendation}>
          <div>
            <small>推荐</small>
            <strong>{recommended.name} · {offeringIsFree(recommended) ? '0 萃点' : '按实际用量结算'}</strong>
            <p>{recommended.description || '提取镜头结构，并按方案补充画面理解。'}</p>
          </div>
          <div>
            <button
              type="button"
              className={styles.primaryTextAction}
              disabled={preparing}
              onClick={() => void prepare(recommended, false, !offeringIsFree(recommended))}
            >
              {preparing && !sheetOpen ? <LoaderCircle size={15} className="animate-spin" /> : null}
              {offeringIsFree(recommended) ? '开始解析' : '查看报价'}
            </button>
            <button
              type="button"
              disabled={preparing}
              onClick={() => void prepare(recommended, false, true)}
            >
              更换方式
            </button>
          </div>
          {error && !sheetOpen && <p className={styles.inlineError} role="alert">{error}</p>}
        </div>
      )}

      <VideoAnalysisQuoteSheet
        open={sheetOpen}
        onClose={() => void closeSheet()}
        catalog={catalog}
        prepared={prepared}
        selectedOffering={selectedOffering}
        useByok={useByok}
        itemCount={1}
        preparing={preparing}
        confirming={confirming}
        error={error}
        onSelect={(offering, withByok) => void prepare(offering, withByok, true)}
        onConfirm={() => void confirm()}
      />
    </div>
  );
}
