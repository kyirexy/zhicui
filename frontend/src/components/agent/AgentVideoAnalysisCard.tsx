'use client';

import { useMemo, useState } from 'react';
import { Check, CheckCircle2, CircleAlert, Eye, KeyRound, LoaderCircle } from 'lucide-react';
import { getVideoAnalysisCatalog } from '@/lib/api';
import type {
  AgentMessage,
  VideoAnalysisCatalog,
  VideoAnalysisItem,
  VideoAnalysisOffering,
  VideoAnalysisQuote,
  VideoAnalysisRun,
} from '@/lib/types';
import { formatPoints, offeringIsFree } from '@/lib/videoAnalysis';
import styles from './AgentVideoAnalysisCard.module.css';

export type AgentVideoAnalysisDecision =
  | 'approve'
  | 'text_only'
  | 'cancel'
  | 'reprepare';

interface StructuredVideoAnalysis {
  run?: VideoAnalysisRun;
  quote?: VideoAnalysisQuote | null;
  items?: VideoAnalysisItem[];
  requires_confirmation?: boolean;
  can_start?: boolean;
}

interface StructuredMessageResult {
  type?: string;
  video_analysis?: StructuredVideoAnalysis;
}

interface AgentVideoAnalysisCardProps {
  message: AgentMessage;
  disabled?: boolean;
  onDecision?: (
    message: AgentMessage,
    action: AgentVideoAnalysisDecision,
    options?: { offeringId?: string; useByok?: boolean },
  ) => void;
}

function quoteNumber(quote: VideoAnalysisQuote | null | undefined, keys: string[]): number {
  const value = quote as unknown as Record<string, unknown> | null | undefined;
  for (const key of keys) {
    if (typeof value?.[key] === 'number') return Math.max(0, value[key] as number);
  }
  return 0;
}

export default function AgentVideoAnalysisCard({
  message,
  disabled = false,
  onDecision,
}: AgentVideoAnalysisCardProps) {
  const result = message.result as StructuredMessageResult | undefined;
  const type = String(result?.type || '');
  const analysis = result?.video_analysis;
  const run = analysis?.run;
  const items = analysis?.items || run?.items || [];
  const approval = type === 'video_analysis_approval_required';
  const started = type === 'video_analysis_analysis_started';
  const terminal = type === 'video_analysis_cancelled' || type === 'video_analysis_resume_failed';
  const completed = Boolean(
    !type
    && run
    && ['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status),
  );
  const needsRequote = approval && run?.status === 'reauthorization_required';
  const [catalog, setCatalog] = useState<VideoAnalysisCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const noteIds = useMemo(
    () => Array.from(new Set(items.map(item => item.note_id).filter(Boolean))),
    [items],
  );

  if (!analysis || (!approval && !started && !terminal && !completed)) return null;

  const quote = analysis.quote || run?.quote;
  const quoteRecord = quote as unknown as Record<string, unknown> | null | undefined;
  const baseOfferingName = run?.offering_name
    || (typeof quoteRecord?.offering_name === 'string' ? quoteRecord.offering_name : '')
    || '推荐解析方案';
  const offeringName = run?.use_byok
    ? `使用我的视觉模型 · ${baseOfferingName}`
    : baseOfferingName;
  const estimated = quoteNumber(quote, ['estimated_points', 'quoted_points'])
    || Number(run?.estimated_points || 0);
  const maximum = quoteNumber(quote, ['max_reserved_points', 'max_points'])
    || Number(run?.max_reserved_points || 0);
  const actual = Number(run?.actual_points ?? items.reduce(
    (total, item) => total + Number(item.actual_points || 0),
    0,
  ));
  const released = Number(run?.released_points ?? items.reduce(
    (total, item) => total + Number(item.released_points || 0),
    0,
  ));
  const estimatedMin = quoteNumber(quote, ['estimated_seconds_min']);
  const estimatedMax = quoteNumber(quote, ['estimated_seconds_max']);
  const estimatedTime = estimatedMin && estimatedMax
    ? `${estimatedMin}–${estimatedMax} 秒`
    : estimatedMax
      ? `不超过 ${estimatedMax} 秒`
      : '后台处理';
  const maxFrames = quoteNumber(quote, ['max_frames']);
  const maxCalls = quoteNumber(quote, ['max_model_calls', 'max_provider_calls']);
  const cachedCount = quoteNumber(quote, ['cached_count'])
    || items.filter(item => item.cached || item.status === 'cached').length;
  const processCount = quoteNumber(quote, ['process_count'])
    || items.filter(item => !item.cached && item.status !== 'cached' && item.status !== 'unsupported').length;

  const loadCatalog = async () => {
    if (catalog || catalogLoading) return;
    setCatalogLoading(true);
    const response = await getVideoAnalysisCatalog(noteIds, 'agent');
    if (response.success && response.data) setCatalog(response.data);
    setCatalogLoading(false);
  };

  const offerings = catalog?.offerings || catalog?.items || [];
  const byokOffering = offerings.find(offering => offering.byok_available === true);

  return (
    <section className={styles.card} aria-label="Agent 详细视频解析" aria-live="polite">
      <header className={styles.header}>
        <span className={styles.icon} aria-hidden="true">
          {started ? (
            <LoaderCircle size={18} className="animate-spin" />
          ) : completed && run?.status === 'succeeded' ? (
            <CheckCircle2 size={18} />
          ) : completed || terminal ? (
            <CircleAlert size={18} />
          ) : (
            <Eye size={18} />
          )}
        </span>
        <div>
          <strong>
            {approval
              ? needsRequote ? '实际用量需要重新报价' : '需要读取视频画面'
              : started
                ? '详细解析正在后台运行'
                : completed
                  ? run?.status === 'partial'
                    ? '详细解析部分完成'
                    : run?.status === 'succeeded'
                      ? '详细解析已完成'
                      : '详细解析未形成可用结果'
                : type === 'video_analysis_cancelled'
                  ? '本次画面解析已取消'
                  : '自动继续回答未完成'}
          </strong>
          <small>
            {approval
              ? needsRequote
                ? '原授权不会超额扣费；先获取新报价，再由你确认是否继续。'
                : `${offeringName}；授权范围只绑定当前视频、方案版本、帧数和萃点上限。`
              : started
                ? '完成后会自动恢复原问题，无需停留在此页面。'
                : completed
                  ? `${offeringName}；结算结果已保存，可随时核对。`
                : '不会产生新的视觉调用。'}
          </small>
        </div>
      </header>

      {(approval || started) && (
        <dl className={styles.metrics}>
          <div><dt>相关视频</dt><dd>{items.length || run?.source_count || 1} 条</dd></div>
          <div><dt>缓存命中</dt><dd>{cachedCount} 条</dd></div>
          <div><dt>实际处理</dt><dd>{processCount} 条</dd></div>
          <div><dt>预计使用</dt><dd>{formatPoints(estimated)}</dd></div>
          <div><dt>最高预留</dt><dd>{formatPoints(maximum)}</dd></div>
          <div><dt>预计时间</dt><dd>{estimatedTime}</dd></div>
          <div><dt>最多画面</dt><dd>{maxFrames ? `${maxFrames} 帧` : '按方案限制'}</dd></div>
          <div><dt>最多调用</dt><dd>{maxCalls ? `${maxCalls} 次` : '无需模型调用'}</dd></div>
          <div><dt>状态</dt><dd>{started ? '后台解析中' : '等待你的选择'}</dd></div>
        </dl>
      )}

      {completed && (
        <dl className={styles.metrics}>
          <div><dt>处理视频</dt><dd>{items.length || run?.source_count || 1} 条</dd></div>
          <div><dt>实际使用</dt><dd>{formatPoints(actual)}</dd></div>
          <div><dt>自动释放</dt><dd>{formatPoints(released)}</dd></div>
          <div><dt>结算状态</dt><dd>{run?.status === 'partial' ? '按已用部分结算' : actual ? '已结算' : '未扣萃点'}</dd></div>
        </dl>
      )}

      {approval && run?.use_byok && (
        <p className={styles.byokNotice} role="note">
          本次将使用你的视觉模型凭证；上游供应商费用由你的账户结算，已产生的供应商费用无法由知萃退款。
        </p>
      )}

      {approval && onDecision && (
        <>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecision(message, needsRequote ? 'reprepare' : 'approve')}
            >
              {needsRequote ? '重新报价' : '解析并继续回答'}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecision(message, 'text_only')}
            >
              只按现有文案回答
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecision(message, 'cancel')}
            >
              取消本次提问
            </button>
          </div>
          <details className={styles.methodPicker} onToggle={event => {
            if (event.currentTarget.open) void loadCatalog();
          }}>
            <summary>更换解析方式</summary>
            {catalogLoading ? (
              <div className={styles.methodState} role="status">正在读取可用方案…</div>
            ) : offerings.length ? (
              <div className={styles.methodList}>
                {offerings.map((offering: VideoAnalysisOffering) => (
                  <button
                    key={offering.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onDecision(message, 'reprepare', { offeringId: offering.id })}
                  >
                    <span>
                      <strong>{offering.name}</strong>
                      <small>{offeringIsFree(offering) ? '0 萃点' : '重新生成服务端报价'}</small>
                    </span>
                    <Check size={15} aria-hidden="true" />
                  </button>
                ))}
                {byokOffering && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onDecision(message, 'reprepare', {
                        offeringId: byokOffering.id,
                        useByok: true,
                      });
                    }}
                  >
                    <span><strong>使用我的视觉模型</strong><small>供应商费用由你的账户结算</small></span>
                    <KeyRound size={15} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.methodState}>当前没有其他可用方案。</div>
            )}
          </details>
        </>
      )}
    </section>
  );
}
