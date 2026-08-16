'use client';

import { Check, CircleAlert, KeyRound, LoaderCircle, Sparkles } from 'lucide-react';
import NativeModal from '@/components/NativeModal';
import type {
  VideoAnalysisCatalog,
  VideoAnalysisOffering,
  VideoAnalysisPrepareResult,
} from '@/lib/types';
import {
  catalogOfferings,
  formatPoints,
  offeringIsFree,
  quoteEstimatedPoints,
  quoteMaxPoints,
} from '@/lib/videoAnalysis';
import styles from './VideoAnalysis.module.css';

interface VideoAnalysisQuoteSheetProps {
  open: boolean;
  onClose: () => void;
  catalog: VideoAnalysisCatalog | null;
  prepared: VideoAnalysisPrepareResult | null;
  selectedOffering: VideoAnalysisOffering | null;
  useByok: boolean;
  itemCount: number;
  selectedCount?: number;
  unsupportedCount?: number;
  preparing: boolean;
  confirming: boolean;
  error?: string;
  onSelect: (offering: VideoAnalysisOffering, useByok: boolean) => void;
  onConfirm: () => void;
}

function estimatedTime(
  offering: VideoAnalysisOffering | null,
  prepared: VideoAnalysisPrepareResult | null,
): string {
  const quote = prepared?.quote;
  const min = quote?.estimated_seconds_min ?? offering?.estimated_seconds_min;
  const max = quote?.estimated_seconds_max ?? offering?.estimated_seconds_max;
  if (min && max) return `预计 ${min}–${max} 秒`;
  if (max) return `预计不超过 ${max} 秒`;
  return '将在后台处理，完成时间取决于视频时长';
}

export default function VideoAnalysisQuoteSheet({
  open,
  onClose,
  catalog,
  prepared,
  selectedOffering,
  useByok,
  itemCount,
  selectedCount = itemCount,
  unsupportedCount = 0,
  preparing,
  confirming,
  error = '',
  onSelect,
  onConfirm,
}: VideoAnalysisQuoteSheetProps) {
  const offerings = catalogOfferings(catalog);
  const quote = prepared?.quote;
  const estimated = quoteEstimatedPoints(quote);
  const maximum = quoteMaxPoints(quote);
  const account = catalog?.account;
  const paidWithPoints = Boolean(
    selectedOffering
    && (maximum > 0 || (!useByok && !offeringIsFree(selectedOffering))),
  );
  const insufficient = Boolean(
    paidWithPoints
    && account
    && account.available_points < maximum,
  );
  const freeOffering = offerings.find(offeringIsFree);
  const byokOffering = offerings.find(item => (
    item.byok_available ?? item.supports_byok ?? item.byok_allowed ?? false
  ));

  return (
    <NativeModal
      open={open}
      onClose={onClose}
      title={itemCount > 1 ? `详细解析 ${itemCount} 条视频` : '确认详细解析'}
      className={styles.quotePanel}
    >
      <div className={styles.quoteBody} aria-busy={preparing || confirming}>
        <section className={styles.quoteHero} aria-live="polite" aria-atomic="true">
          <span className={styles.quoteHeroIcon} aria-hidden="true">
            {useByok ? <KeyRound size={20} /> : <Sparkles size={20} />}
          </span>
          <div>
            <small>{useByok ? '使用我的视觉模型' : '当前解析方式'}</small>
            <h3>{selectedOffering?.name || '正在读取推荐方案'}</h3>
            <p>{selectedOffering?.description || '服务端正在读取视频时长并计算报价。'}</p>
          </div>
        </section>

        {offerings.length > 1 || byokOffering ? (
          <details className={styles.methodPicker}>
            <summary>更换方式</summary>
            <div role="radiogroup" aria-label="详细解析方式">
              {offerings.map(offering => {
                const selected = selectedOffering?.id === offering.id && !useByok;
                return (
                  <button
                    key={offering.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={preparing || confirming}
                    onClick={() => onSelect(offering, false)}
                  >
                    <span>
                      <strong>{offering.name}</strong>
                      <small>{offeringIsFree(offering) ? '0 萃点' : '按服务端实际用量结算'}</small>
                    </span>
                    {selected && <Check size={16} aria-hidden="true" />}
                  </button>
                );
              })}
              {byokOffering && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={useByok}
                  disabled={preparing || confirming}
                  onClick={() => onSelect(byokOffering, true)}
                >
                  <span>
                    <strong>使用我的视觉模型</strong>
                    <small>供应商费用由你的账户结算</small>
                  </span>
                  {useByok && <Check size={16} aria-hidden="true" />}
                </button>
              )}
            </div>
          </details>
        ) : null}

        {preparing ? (
          <div className={styles.quoteLoading} role="status">
            <LoaderCircle size={18} className="animate-spin" />
            正在读取真实时长并生成报价
          </div>
        ) : prepared ? (
          <section className={styles.quoteSummary} aria-label="解析报价">
            <dl>
              {itemCount > 1 && (
                <div>
                  <dt>已选</dt>
                  <dd>{selectedCount} 条</dd>
                </div>
              )}
              {itemCount > 1 && (
                <div>
                  <dt>缓存命中</dt>
                  <dd>{quote?.cached_count ?? prepared.items.filter(item => item.cached).length} 条</dd>
                </div>
              )}
              {itemCount > 1 && (
                <div>
                  <dt>实际处理</dt>
                  <dd>{quote?.process_count ?? prepared.items.filter(item => item.supported !== false && !item.cached).length} 条</dd>
                </div>
              )}
              {itemCount > 1 && (
                <div>
                  <dt>不支持</dt>
                  <dd>{unsupportedCount + (quote?.unsupported_count ?? prepared.items.filter(item => item.supported === false).length)} 条</dd>
                </div>
              )}
              <div>
                <dt>预计使用</dt>
                <dd>{formatPoints(estimated)}</dd>
              </div>
              <div>
                <dt>最高预留</dt>
                <dd>{formatPoints(maximum)}</dd>
              </div>
              {itemCount === 1 && <div>
                <dt>处理范围</dt>
                <dd>{quote?.process_count ?? prepared.items.filter(item => item.supported !== false).length} 条</dd>
              </div>}
              <div>
                <dt>关键画面</dt>
                <dd>最多 {quote?.max_frames ?? selectedOffering?.limits?.max_frames ?? '按时长'} 帧</dd>
              </div>
            </dl>
            <p>{estimatedTime(selectedOffering, prepared)}，任务可离页在后台继续。</p>
            <p>完成后按实际用量结算，多余萃点自动释放；缓存命中不扣额度和萃点。</p>
            {useByok && (
              <p className={styles.byokNotice}>
                知萃不会切换到平台收费密钥。供应商已经产生的模型费用无法由知萃退款。
              </p>
            )}
          </section>
        ) : null}

        {insufficient && (
          <div className={styles.balanceWarning} role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <strong>萃点余额不足</strong>
              <p>当前可用 {formatPoints(account?.available_points)}，本次最多需要 {formatPoints(maximum)}。</p>
              <div>
                {freeOffering && (
                  <button type="button" onClick={() => onSelect(freeOffering, false)}>
                    选择已包含的方式
                  </button>
                )}
                {byokOffering && (
                  <button type="button" onClick={() => onSelect(byokOffering, true)}>
                    使用我的模型
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {error && <p className={styles.inlineError} role="alert">{error}</p>}

        <footer className={styles.quoteActions}>
          <button type="button" onClick={onClose} disabled={confirming}>取消</button>
          <button
            type="button"
            className={styles.primaryAction}
            onClick={onConfirm}
            disabled={!prepared || prepared.quote?.process_count === 0 || preparing || confirming || insufficient}
          >
            {confirming && <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />}
            {confirming ? '正在开始' : '确认并开始'}
          </button>
        </footer>
      </div>
    </NativeModal>
  );
}
