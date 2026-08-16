'use client';

import { useEffect, useState } from 'react';
import { CircleDollarSign, LoaderCircle, RefreshCw, WalletCards } from 'lucide-react';
import {
  adjustAdminVideoAnalysisCredits,
  getAdminVideoAnalysisUserAccount,
} from '@/lib/api';
import type { VideoAnalysisAccount } from '@/lib/types';
import { formatPoints, formatPointsWithCny, formatSignedPoints } from '@/lib/videoAnalysis';

type CreditAction = 'grant' | 'deduct' | 'refund';

export default function AdminAnalysisAccountCard({ userId }: { userId: string }) {
  const [account, setAccount] = useState<VideoAnalysisAccount | null>(null);
  const [action, setAction] = useState<CreditAction>('grant');
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    const response = await getAdminVideoAnalysisUserAccount(userId);
    setLoading(false);
    if (response.success && response.data) {
      setAccount(response.data);
      setError('');
    } else {
      setError(response.error || '解析账户读取失败');
    }
  };

  useEffect(() => {
    void load();
    // User identity is the only trigger for account recovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const submit = async () => {
    const cleanPoints = Math.trunc(Number(points));
    if (!Number.isFinite(cleanPoints) || cleanPoints <= 0) {
      setError('请输入大于 0 的整数萃点');
      return;
    }
    if (!reason.trim()) {
      setError('发放、扣减或退款都必须填写原因');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('');
    const signedPoints = action === 'deduct' ? -cleanPoints : cleanPoints;
    const response = await adjustAdminVideoAnalysisCredits(userId, {
      points: signedPoints,
      reason: reason.trim(),
      entry_type: action === 'grant' ? 'grant' : action === 'refund' ? 'refund' : 'adjustment',
      idempotency_key: `admin-credit:${userId}:${crypto.randomUUID()}`,
    });
    setBusy(false);
    if (response.success && response.data) {
      setAccount(response.data);
      setPoints('');
      setReason('');
      setMessage(`${action === 'grant' ? '已发放' : action === 'refund' ? '已退款' : '已扣减'} ${formatPoints(cleanPoints)}`);
    } else {
      setError(response.error || '萃点调整失败');
    }
  };

  return (
    <section className="rounded-xl border border-card-border bg-[var(--admin-surface-1)] p-4" aria-labelledby="analysis-account-title">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-emerald/10 text-accent-emerald">
            <WalletCards size={18} aria-hidden="true" />
          </span>
          <div>
            <h3 id="analysis-account-title" className="text-sm font-semibold text-foreground">解析账户</h3>
            <p className="mt-1 text-xs leading-5 text-foreground-muted">1000 萃点 = ¥1；所有调整进入只追加账本。</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busy}
          aria-label="刷新解析账户"
          className="grid size-10 place-items-center rounded-lg border border-card-border text-foreground-muted disabled:opacity-50"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {loading && !account ? (
        <div className="mt-4 flex min-h-20 items-center justify-center gap-2 text-xs text-foreground-muted">
          <LoaderCircle size={15} className="animate-spin" />正在读取萃点
        </div>
      ) : account ? (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-[var(--admin-surface-2)] p-3">
              <dt className="text-[11px] text-foreground-muted">可用萃点</dt>
              <dd className="mt-1 text-base font-bold tabular-nums text-foreground">{formatPoints(account.available_points)}</dd>
              <small className="mt-1 block text-[10px] text-foreground-muted">{formatPointsWithCny(account.available_points).replace(/^.*（/, '（')}</small>
            </div>
            <div className="rounded-lg bg-[var(--admin-surface-2)] p-3">
              <dt className="text-[11px] text-foreground-muted">任务预留</dt>
              <dd className="mt-1 text-base font-bold tabular-nums text-foreground">{formatPoints(account.reserved_points)}</dd>
              <small className="mt-1 block text-[10px] text-foreground-muted">任务结束自动结算或释放</small>
            </div>
          </dl>

          <div className="mt-4 grid grid-cols-3 gap-1 rounded-lg bg-[var(--admin-surface-2)] p-1" role="radiogroup" aria-label="萃点调整类型">
            {([
              ['grant', '发放'],
              ['deduct', '扣减'],
              ['refund', '退款'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={action === value}
                onClick={() => setAction(value)}
                className={`min-h-10 rounded-md px-2 text-xs font-semibold ${action === value ? 'bg-background text-foreground shadow-sm' : 'text-foreground-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-2">
            <label className="grid gap-1 text-xs text-foreground-muted">
              萃点数量
              <input
                type="number"
                min={1}
                step={1}
                value={points}
                onChange={event => setPoints(event.target.value)}
                placeholder="例如：1000"
                className="min-h-11 rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground outline-none focus:border-accent-emerald/60"
              />
            </label>
            <label className="grid gap-1 text-xs text-foreground-muted">
              原因（必填）
              <textarea
                value={reason}
                onChange={event => setReason(event.target.value)}
                placeholder="例如：内测额度、异常任务退款"
                rows={2}
                className="rounded-lg border border-card-border bg-[var(--admin-surface-2)] px-3 py-2 text-sm text-foreground outline-none focus:border-accent-emerald/60"
              />
            </label>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !points || !reason.trim()}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent-emerald px-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? <LoaderCircle size={15} className="animate-spin" /> : <CircleDollarSign size={15} />}
              {busy ? '正在写入账本' : `确认${action === 'grant' ? '发放' : action === 'refund' ? '退款' : '扣减'}`}
            </button>
          </div>

          {account.recent_ledger?.length ? (
            <div className="mt-4 border-t border-card-border pt-3">
              <h4 className="text-xs font-semibold text-foreground">最近账本</h4>
              <div className="mt-2 space-y-2">
                {account.recent_ledger.slice(0, 5).map(entry => (
                  <div key={entry.id} className="flex items-start justify-between gap-3 text-xs">
                    <span className="min-w-0 text-foreground-muted">
                      <strong className="block truncate font-medium text-foreground">{entry.reason || entry.kind}</strong>
                      <small>{new Date(entry.created_at).toLocaleString('zh-CN')}</small>
                    </span>
                    {(() => {
                      const delta = Number(entry.available_delta ?? entry.reserved_delta ?? entry.points);
                      return <b className={delta < 0 ? 'shrink-0 text-accent-rose' : 'shrink-0 text-accent-emerald'}>{formatSignedPoints(delta)}</b>;
                    })()}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {message && <p className="mt-3 text-xs text-accent-emerald" role="status">{message}</p>}
      {error && <p className="mt-3 text-xs text-accent-rose" role="alert">{error}</p>}
    </section>
  );
}
