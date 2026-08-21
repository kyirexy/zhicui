'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import {
  BadgeDollarSign,
  CheckCircle2,
  CircleAlert,
  Coins,
  DatabaseZap,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ScanSearch,
} from 'lucide-react';
import {
  getAdminVideoAnalysisUsage,
  listAdminVideoAnalysisLedger,
  listAdminVideoAnalysisRuns,
} from '@/lib/api';
import type {
  AdminVideoAnalysisUsageReport,
  VideoAnalysisLedgerEntry,
  VideoAnalysisRun,
} from '@/lib/types';
import { formatPoints, formatSignedPoints, runItemCount, videoAnalysisStatusLabel } from '@/lib/videoAnalysis';

function formatMicros(value: number): string {
  return `¥${(Math.max(0, Number(value) || 0) / 1_000_000).toFixed(4)}`;
}

function formatDate(value?: string): string {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export default function AdminVideoAnalysisUsageView() {
  const [usage, setUsage] = useState<AdminVideoAnalysisUsageReport | null>(null);
  const [runs, setRuns] = useState<VideoAnalysisRun[]>([]);
  const [ledger, setLedger] = useState<VideoAnalysisLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    const [usageResult, runResult, ledgerResult] = await Promise.all([
      getAdminVideoAnalysisUsage(),
      listAdminVideoAnalysisRuns({ limit: 50 }),
      listAdminVideoAnalysisLedger({ limit: 50 }),
    ]);
    setLoading(false);
    if (usageResult.success && usageResult.data) setUsage(usageResult.data);
    if (runResult.success && runResult.data) setRuns(runResult.data.items || []);
    if (ledgerResult.success && ledgerResult.data) setLedger(ledgerResult.data.items || []);
    const failed = [usageResult, runResult, ledgerResult].find(result => !result.success);
    if (failed) setError(failed.error || '视频解析用量读取失败');
  };

  useEffect(() => {
    void load();
  }, []);

  if (loading && !usage) {
    return <div className="admin-panel flex min-h-48 items-center justify-center gap-2 text-sm text-foreground-muted"><LoaderCircle size={16} className="animate-spin" />正在读取视频解析用量</div>;
  }

  const summary = usage?.summary || {
    runs: typeof usage?.runs === 'number' ? usage.runs : 0,
    items: typeof usage?.items === 'number' ? usage.items : 0,
    succeeded: usage?.succeeded_runs || 0,
    partial: usage?.partial_runs || 0,
    failed: usage?.failed_runs || 0,
    cache_hits: usage?.cache_hits || 0,
    points_captured: usage?.captured_points || 0,
    points_refunded: usage?.refunded_points || ledger.filter(entry => entry.kind === 'refund').reduce((sum, entry) => sum + Math.abs(entry.points), 0),
    provider_cost_micros: usage?.platform_cost_micros || 0,
    failure_cost_micros: usage?.failure_cost_micros || 0,
  };
  const cacheRate = summary.items > 0 ? Math.round((summary.cache_hits / summary.items) * 100) : 0;
  const refunds = ledger.filter(entry => entry.kind === 'refund');

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl border border-accent-rose/25 bg-accent-rose/7 px-4 py-3 text-sm text-accent-rose" role="alert">{error}</div>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="解析次数" value={summary.runs.toLocaleString('zh-CN')} helper={`${summary.items} 个视频条目`} icon={ScanSearch} color="var(--accent-brand)" />
        <Metric label="缓存命中" value={summary.cache_hits.toLocaleString('zh-CN')} helper={`命中率 ${cacheRate}% · 0 萃点`} icon={DatabaseZap} color="var(--accent-indigo)" />
        <Metric label="萃点收入" value={formatPoints(summary.points_captured)} helper={`已退款 ${formatPoints(summary.points_refunded)}`} icon={Coins} color="var(--accent-amber)" />
        <Metric label="平台模型成本" value={formatMicros(summary.provider_cost_micros)} helper={`失败成本 ${formatMicros(summary.failure_cost_micros)}`} icon={BadgeDollarSign} color="var(--accent-rose)" />
      </div>

      <section className="admin-panel overflow-hidden">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-card-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">解析运行记录</h2>
            <p className="mt-1 text-xs text-foreground-muted">萃点收入与上游微元成本分别记账，不混为同一金额。</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="刷新视频解析用量" className="grid size-10 place-items-center rounded-lg border border-card-border bg-[var(--admin-surface-2)] text-foreground-muted disabled:opacity-50"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
        </header>
        <div className="overflow-x-auto">
          <table className="admin-table admin-table-wide text-sm">
            <thead><tr className="text-xs text-foreground-muted"><th className="p-3 text-left">时间</th><th className="p-3 text-left">用户</th><th className="p-3 text-left">方案</th><th className="p-3 text-left">状态</th><th className="p-3 text-right">视频</th><th className="p-3 text-right">实扣</th><th className="p-3 text-right">模型成本</th></tr></thead>
            <tbody>
              {runs.map(run => (
                <tr key={run.id} className="border-b border-card-border/50">
                  <td className="whitespace-nowrap p-3 text-xs text-foreground-muted">{formatDate(run.created_at)}</td>
                  <td className="p-3 font-medium text-foreground">{run.username || run.user_id?.slice(0, 8) || '-'}</td>
                  <td className="p-3 text-foreground-muted">{run.offering_name || run.offering_id || (run.use_byok ? '用户 BYOK' : '详细解析')}</td>
                  <td className="p-3"><span className={run.status === 'succeeded' ? 'text-accent-brand' : run.status === 'failed' ? 'text-accent-rose' : 'text-foreground-muted'}>{videoAnalysisStatusLabel(run.status)}</span></td>
                  <td className="p-3 text-right tabular-nums text-foreground-muted">{runItemCount(run)}</td>
                  <td className="p-3 text-right tabular-nums font-semibold text-foreground">{formatPoints(run.actual_points || 0)}</td>
                  <td className="p-3 text-right tabular-nums text-foreground-muted">{formatMicros(run.provider_cost_micros || 0)}</td>
                </tr>
              ))}
              {!runs.length && <tr><td colSpan={7} className="p-8 text-center text-sm text-foreground-muted">还没有详细解析运行记录</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-[1fr_0.7fr]">
        <section className="admin-panel overflow-hidden">
          <header className="border-b border-card-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">最近萃点账本</h2><p className="mt-1 text-xs text-foreground-muted">只追加记录；预留、结算、释放、退款和管理员调整均可追溯。</p></header>
          <div className="divide-y divide-card-border">
            {ledger.slice(0, 20).map(entry => (
              <div key={entry.id} className="flex items-start justify-between gap-4 px-5 py-3 text-xs">
                <span className="min-w-0"><strong className="block truncate font-medium text-foreground">{entry.reason || entry.kind}</strong><small className="mt-1 block text-foreground-muted">{entry.username || entry.user_id?.slice(0, 8) || '用户'} · {formatDate(entry.created_at)}</small></span>
                {(() => {
                  const delta = Number(entry.available_delta ?? entry.reserved_delta ?? entry.points);
                  return <b className={`shrink-0 tabular-nums ${delta < 0 ? 'text-accent-rose' : 'text-accent-brand'}`}>{formatSignedPoints(delta)}</b>;
                })()}
              </div>
            ))}
            {!ledger.length && <div className="p-8 text-center text-sm text-foreground-muted">暂无账本记录</div>}
          </div>
        </section>
        <section className="admin-panel p-5">
          <h2 className="text-sm font-semibold text-foreground">结果与退款</h2>
          <dl className="mt-4 space-y-3 text-xs">
            <ResultRow icon={CheckCircle2} label="成功" value={summary.succeeded} tone="positive" />
            <ResultRow icon={CircleAlert} label="部分完成" value={summary.partial} tone="warning" />
            <ResultRow icon={CircleAlert} label="失败" value={summary.failed} tone="negative" />
            <ResultRow icon={RotateCcw} label="退款记录" value={refunds.length} tone="neutral" />
          </dl>
          <p className="mt-5 rounded-lg bg-[var(--admin-surface-2)] p-3 text-xs leading-5 text-foreground-muted">完全失败且没有可用视觉结果时不扣萃点；部分完成只结算已消耗部分。供应商失败成本仍以微元独立记录。</p>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, helper, icon: Icon, color }: { label: string; value: string; helper: string; icon: typeof ScanSearch; color: string }) {
  return <div className="admin-stat p-4 pl-5" style={{ '--stat-color': color } as CSSProperties}><div className="flex items-center justify-between gap-3"><div className="text-xl font-bold tabular-nums text-foreground sm:text-2xl">{value}</div><Icon size={18} className="text-foreground-muted" /></div><div className="mt-2 text-xs font-medium text-foreground">{label}</div><div className="mt-1 text-[11px] text-foreground-muted">{helper}</div></div>;
}

function ResultRow({ icon: Icon, label, value, tone }: { icon: typeof CheckCircle2; label: string; value: number; tone: 'positive' | 'warning' | 'negative' | 'neutral' }) {
  const color = tone === 'positive' ? 'text-accent-brand' : tone === 'warning' ? 'text-accent-amber' : tone === 'negative' ? 'text-accent-rose' : 'text-foreground-muted';
  return <div className="flex items-center gap-2 rounded-lg bg-[var(--admin-surface-2)] px-3 py-2"><Icon size={15} className={color} /><dt className="flex-1 text-foreground-muted">{label}</dt><dd className="font-bold tabular-nums text-foreground">{value.toLocaleString('zh-CN')}</dd></div>;
}
