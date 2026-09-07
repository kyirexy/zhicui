'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getAdminBusinessOverview, type AdminBusinessOverview } from '@/lib/api';

const statusLabels: Record<string, string> = {
  queued: '排队', pending: '待处理', prepared: '待确认', running: '执行中',
  transcribing: '转文案中', analyzing: '生成摘要中', processing: '处理中', resolving: '解析链接中',
  discovering: '读取清单中', importing: '导入中', done: '成功', succeeded: '成功',
  error: '失败', failed: '失败', partial: '部分完成', cancelled: '已取消',
  reused: '复用', cached: '缓存命中', reauthorization_required: '需要重新授权',
};
const fields: [keyof AdminBusinessOverview['metrics'], string][] = [
  ['new_notes', '新增解析资料'], ['transcripts_ready', '其中已有文案'],
  ['summaries_ready', '其中摘要已就绪'], ['new_users', '新增用户'],
  ['model_calls', '模型调用记录'], ['tokens', '已记录 Token'],
  ['errors', '错误记录'], ['analysis_points', '解析任务已扣积分'],
];
const extraFields: [keyof AdminBusinessOverview['metrics'], string][] = [
  ['new_plans', '新增计划'], ['new_knowledge', '新增知识'], ['new_creators', '新增博主'],
  ['model_users', '模型调用用户'], ['feedback', '新增反馈'],
];
const number = (value: number) => value.toLocaleString('zh-CN');
const control = 'min-h-9 rounded-lg border border-card-border px-3 text-sm disabled:opacity-50';

export default function AdminBusinessOverviewPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const [days, setDays] = useState(7);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<AdminBusinessOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    getAdminBusinessOverview(days, page).then((result) => {
      if (!active) return;
      if (result.success && result.data) setData(result.data);
      else setError(result.error || '业务数据读取失败');
    }).catch(() => { if (active) setError('业务数据读取失败，请重试'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, page, refresh, refreshToken]);
  const metric = ([key, label]: typeof fields[number]) => (
    <div key={key} className="min-w-0 rounded-lg bg-[var(--admin-surface-2)] p-3">
      <dt className="text-xs text-foreground-muted">{label}</dt>
      <dd className="mt-1 break-words text-lg font-semibold tabular-nums">{data ? number(data.metrics[key]) : '—'}</dd>
    </div>
  );
  return (
    <section className="admin-panel space-y-4 p-4 text-foreground" aria-label="业务数据概览" aria-busy={loading}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-balance text-base font-semibold">业务数据</h2>
          <p className="mt-1 text-pretty text-xs text-foreground-muted">只读统计 · 资料按新增时间，批量提取按最后更新时间</p></div>
        <div className="flex items-center gap-2">
          <select aria-label="业务统计时间范围" value={days} className={control} onChange={(event) => { setDays(Number(event.target.value)); setPage(1); }}>
            <option value={1}>近 24 小时</option><option value={7}>近 7 天</option><option value={30}>近 30 天</option>
          </select>
          <button type="button" disabled={loading} className={control} onClick={() => setRefresh((value) => value + 1)}>{loading ? '读取中…' : '刷新'}</button>
        </div>
      </header>
      {error && <p role="alert" className="text-sm text-accent-rose">{error}，可点击刷新重试。{data ? `以下保留上次成功读取的近 ${data.days} 天数据。` : ''}</p>}
      <dl className={`grid grid-cols-2 gap-2 lg:grid-cols-4 ${loading ? 'opacity-50' : ''}`}>{fields.map(metric)}</dl>
      {data && <>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-foreground-muted">
          <span>来源分布</span>{data.platforms.map((item) => <span key={item.name}>{item.name} <strong className="tabular-nums text-foreground">{number(item.count)}</strong></span>)}
          {!data.platforms.length && <span>所选时间内暂无新增资料</span>}
        </div>
        <div className="grid gap-2 lg:grid-cols-3">
          {([['library', '批量提取条目'], ['creator', '博主同步任务'], ['vision', '多模态解析任务']] as const).map(([key, label]) => (
            <div key={key} className="rounded-lg border border-card-border p-3">
              <h3 className="mb-2 text-balance text-sm font-medium">{label}</h3>
              <div className="flex flex-wrap gap-2 text-xs">{data.tasks[key].map((item) => <span key={item.status} className={['failed', 'error', 'reauthorization_required'].includes(item.status) ? 'text-accent-rose' : 'text-foreground-muted'}>{statusLabels[item.status] || item.status} <strong className="tabular-nums">{number(item.count)}</strong></span>)}
                {!data.tasks[key].length && <span className="text-foreground-muted">所选时间内暂无任务</span>}
              </div>
            </div>
          ))}
        </div>
        <details className="rounded-lg border border-card-border p-3">
          <summary className="cursor-pointer text-sm font-medium">最近 5 条批量提取记录</summary>
          <ul className="mt-3 divide-y divide-card-border">{data.recent_tasks.map((task) => <li key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
            <div className="min-w-0 flex-1"><p className="truncate" title={task.title}>{task.title}</p><p className="mt-1 text-foreground-muted">{task.username} · {new Date(task.updated_at).toLocaleString('zh-CN')}</p></div>
            <span className="shrink-0 tabular-nums">{statusLabels[task.status] || task.status} · {number(task.transcript_chars)} 字</span>
          </li>)}</ul>
          {!data.recent_tasks.length && <p className="mt-3 text-xs text-foreground-muted">暂无记录，可扩大统计时间范围。</p>}
        </details>
        <details className="rounded-lg border border-card-border p-3">
          <summary className="cursor-pointer text-sm font-medium">更多统计与模型用量</summary>
          <dl className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-5">{extraFields.map(metric)}</dl>
          <ul className="mt-3 space-y-2 text-sm">{data.models.map((model) => <li key={model.name} className="flex flex-wrap justify-between gap-2"><span className="min-w-0 break-all">{model.name}</span><span className="tabular-nums text-foreground-muted">{number(model.calls)} 次 · {number(model.tokens)} Token</span></li>)}</ul>
          <p className="mt-3 text-pretty text-xs text-foreground-muted">模型展示调用量前 6 项；积分仅统计所选时间内创建的多模态任务已扣积分，不等于充值或净收入。统计不新增数据表，不返回正文、提示词、密钥或媒体地址。</p>
          <Link href="/admin/observability" className="mt-3 inline-block text-sm text-accent-brand">查看用量与日志 →</Link>
        </details>
        <div className="flex items-center justify-between gap-2"><h3 className="text-balance text-sm font-semibold">最近解析资料</h3><Link href="/admin/notes" className="text-sm text-accent-brand">管理资料 →</Link></div>
        <div className="overflow-x-auto rounded-lg border border-card-border">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-[var(--admin-surface-2)] text-foreground-muted"><tr>{['资料 / 所属用户', '来源', '文案', '摘要', '新增时间'].map((label) => <th key={label} scope="col" className="px-3 py-2 font-medium">{label}</th>)}</tr></thead>
            <tbody>{data.recent_notes.map((note) => <tr key={note.id} className="border-t border-card-border">
              <td className="max-w-64 px-3 py-2"><p className="truncate" title={note.title}>{note.title || '未命名资料'}</p><p className="mt-1 truncate text-foreground-muted">{note.username}</p></td>
              <td className="whitespace-nowrap px-3 py-2">{note.platform}</td><td className="whitespace-nowrap px-3 py-2 tabular-nums">{note.transcript_chars ? `${number(note.transcript_chars)} 字` : '未就绪'}</td>
              <td className="whitespace-nowrap px-3 py-2">{note.summary_ready ? '已就绪' : '未生成'}</td><td className="whitespace-nowrap px-3 py-2 tabular-nums">{new Date(note.created_at).toLocaleString('zh-CN', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'})}</td>
            </tr>)}</tbody>
          </table>
          {!data.recent_notes.length && <p className="p-4 text-center text-sm text-foreground-muted">所选时间内没有新增资料，可切换至近 30 天。</p>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-foreground-muted">
          <span>更新于 {new Date(data.as_of).toLocaleTimeString('zh-CN')} · 每页 10 条</span>
          <div className="flex items-center gap-2"><button type="button" className={control} disabled={loading || page === 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span className="tabular-nums">{data.page} / {Math.max(1, Math.ceil(data.metrics.new_notes / 10))}</span><button type="button" className={control} disabled={loading || page * 10 >= data.metrics.new_notes || page >= 10000} onClick={() => setPage((value) => value + 1)}>下一页</button></div>
        </footer>
      </>}
    </section>
  );
}
