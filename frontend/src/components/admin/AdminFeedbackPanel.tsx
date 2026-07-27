'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Inbox, Search } from 'lucide-react';
import {
  listAdminFeedback,
  updateAdminFeedback,
  type AdminFeedbackItem,
  type AdminFeedbackPage,
} from '@/lib/api';
import type {
  FeedbackCategory,
  FeedbackStatus,
} from '@/lib/types';

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: '遇到问题',
  suggestion: '功能建议',
  content: '内容反馈',
  account: '账号相关',
  other: '其他',
};

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

const EMPTY_COUNTS: AdminFeedbackPage['counts'] = {
  total: 0,
  pending: 0,
  processing: 0,
  resolved: 0,
  closed: 0,
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AdminFeedbackPanel() {
  const [items, setItems] = useState<AdminFeedbackItem[]>([]);
  const [counts, setCounts] = useState<AdminFeedbackPage['counts']>(EMPTY_COUNTS);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<FeedbackStatus | ''>('');
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AdminFeedbackItem | null>(null);
  const [draftStatus, setDraftStatus] = useState<FeedbackStatus>('pending');
  const [draftReply, setDraftReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void loadFeedback(1);
    // This panel is mounted only while the feedback tab is active.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadFeedback(
    nextPage = page,
    nextQuery = query,
    nextStatus = status,
    nextCategory = category,
  ) {
    setLoading(true);
    setError('');
    const response = await listAdminFeedback({
      page: nextPage,
      perPage: 20,
      q: nextQuery,
      status: nextStatus,
      category: nextCategory,
    });
    if (response.success && response.data) {
      setItems(response.data.items);
      setCounts(response.data.counts);
      setTotal(response.data.total);
      setPage(response.data.page);
      if (selected) {
        const fresh = response.data.items.find((item) => item.id === selected.id) || null;
        setSelected(fresh);
        if (fresh) {
          setDraftStatus(fresh.status);
          setDraftReply(fresh.admin_reply || '');
        }
      }
    } else {
      setError(response.error || '反馈列表加载失败');
    }
    setLoading(false);
  }

  function chooseFeedback(item: AdminFeedbackItem) {
    setSelected(item);
    setDraftStatus(item.status);
    setDraftReply(item.admin_reply || '');
    setMessage('');
    setError('');
  }

  async function saveFeedback() {
    if (!selected) return;
    setSaving(true);
    setError('');
    setMessage('');
    const response = await updateAdminFeedback(selected.id, {
      status: draftStatus,
      admin_reply: draftReply,
    });
    setSaving(false);
    if (!response.success || !response.data) {
      setError(response.error || '保存失败');
      return;
    }
    const updated = response.data;
    setSelected(updated);
    setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
    setMessage('处理结果已保存，用户现在可以在“我的反馈”中看到回复。');
    await loadFeedback(page);
  }

  const runSearch = () => {
    const nextQuery = searchInput.trim();
    setQuery(nextQuery);
    void loadFeedback(1, nextQuery);
  };

  const clearFilters = () => {
    setSearchInput('');
    setQuery('');
    setStatus('');
    setCategory('');
    setSelected(null);
    void loadFeedback(1, '', '', '');
  };

  return (
    <section className="space-y-4" aria-labelledby="admin-feedback-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="admin-feedback-title" className="text-2xl font-bold text-foreground text-balance">
            用户反馈
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            查看用户遇到的问题、功能建议和客户端环境，并把处理结果直接回复给用户。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadFeedback(page)}
          className="min-h-10 rounded-xl border border-card-border bg-[var(--admin-surface)] px-4 text-sm font-semibold text-foreground hover:brightness-95"
        >
          刷新
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {([
          ['全部', counts.total],
          ['待处理', counts.pending],
          ['处理中', counts.processing],
          ['已解决', counts.resolved],
          ['已关闭', counts.closed],
        ] as const).map(([label, value]) => (
          <div key={label} className="admin-panel px-4 py-3">
            <p className="text-xs text-foreground-muted">{label}</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-foreground">{value}</p>
          </div>
        ))}
      </div>

      <div className="admin-panel flex flex-wrap gap-2 p-3">
        <label className="sr-only" htmlFor="feedback-admin-search">搜索反馈</label>
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-xl border border-card-border bg-[var(--admin-surface-2)] px-3">
          <Search size={16} className="text-foreground-muted" aria-hidden="true" />
          <input
            id="feedback-admin-search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') runSearch(); }}
            placeholder="搜索主题、正文、用户名或邮箱"
            className="min-h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground-muted"
          />
        </div>
        <select
          value={status}
          onChange={(event) => {
            const next = event.target.value as FeedbackStatus | '';
            setStatus(next);
            void loadFeedback(1, query, next, category);
          }}
          aria-label="按处理状态筛选"
          className="min-h-10 rounded-xl border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground"
        >
          <option value="">全部状态</option>
          {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map((value) => (
            <option key={value} value={value}>{STATUS_LABELS[value]}</option>
          ))}
        </select>
        <select
          value={category}
          onChange={(event) => {
            const next = event.target.value as FeedbackCategory | '';
            setCategory(next);
            void loadFeedback(1, query, status, next);
          }}
          aria-label="按反馈类型筛选"
          className="min-h-10 rounded-xl border border-card-border bg-[var(--admin-surface-2)] px-3 text-sm text-foreground"
        >
          <option value="">全部类型</option>
          {(Object.keys(CATEGORY_LABELS) as FeedbackCategory[]).map((value) => (
            <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={runSearch}
          className="min-h-10 rounded-xl bg-accent-emerald px-4 text-sm font-bold text-white hover:brightness-95"
        >
          搜索
        </button>
      </div>

      {(error || message) && (
        <p
          role={error ? 'alert' : 'status'}
          className={`rounded-xl border px-3 py-2.5 text-sm ${
            error
              ? 'border-accent-rose/20 bg-accent-rose/5 text-accent-rose'
              : 'border-accent-emerald/20 bg-accent-emerald/5 text-accent-emerald'
          }`}
        >
          {error || message}
        </p>
      )}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
        <div className="admin-panel min-w-0 overflow-hidden">
          {loading ? (
            <div className="py-16 text-center text-sm text-foreground-muted">正在加载用户反馈…</div>
          ) : items.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <Inbox className="mx-auto text-foreground-muted" size={30} aria-hidden="true" />
              <p className="mt-3 font-semibold text-foreground">当前筛选下没有反馈</p>
              <p className="mt-1 text-sm text-foreground-muted">可以清除筛选条件查看全部记录。</p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-4 min-h-10 rounded-xl bg-[var(--admin-surface-2)] px-4 text-sm font-semibold text-foreground"
              >
                清除筛选
              </button>
            </div>
          ) : (
            <div className="divide-y divide-card-border/60">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => chooseFeedback(item)}
                  aria-pressed={selected?.id === item.id}
                  className={`block w-full px-4 py-4 text-left hover:bg-[var(--admin-surface-2)] ${
                    selected?.id === item.id ? 'bg-accent-emerald/5' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-foreground">{item.subject}</p>
                      <p className="mt-1 truncate text-xs text-foreground-muted">
                        {item.user.username || item.user.email} · {CATEGORY_LABELS[item.category]}
                      </p>
                    </div>
                    <span className={`feedback-status feedback-status--${item.status}`}>
                      {STATUS_LABELS[item.status]}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-foreground-secondary">{item.content}</p>
                  <p className="mt-2 text-xs text-foreground-muted">{formatDate(item.created_at)}</p>
                </button>
              ))}
            </div>
          )}

          {total > 20 && (
            <div className="flex items-center justify-center gap-3 border-t border-card-border p-3">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => void loadFeedback(page - 1)}
                className="min-h-9 rounded-lg bg-[var(--admin-surface-2)] px-3 text-xs font-semibold text-foreground disabled:opacity-40"
              >
                上一页
              </button>
              <span className="text-xs text-foreground-muted">
                第 {page} / {Math.ceil(total / 20)} 页
              </span>
              <button
                type="button"
                disabled={page * 20 >= total || loading}
                onClick={() => void loadFeedback(page + 1)}
                className="min-h-9 rounded-lg bg-[var(--admin-surface-2)] px-3 text-xs font-semibold text-foreground disabled:opacity-40"
              >
                下一页
              </button>
            </div>
          )}
        </div>

        <aside className="admin-panel min-w-0 p-4 sm:p-5" aria-label="反馈详情与处理">
          {!selected ? (
            <div className="flex min-h-72 flex-col items-center justify-center text-center">
              <Inbox className="text-foreground-muted" size={30} aria-hidden="true" />
              <p className="mt-3 font-semibold text-foreground">选择一条反馈查看详情</p>
              <p className="mt-1 max-w-xs text-sm text-foreground-muted">这里会显示完整描述、用户信息、页面和客户端环境。</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                  <span>{CATEGORY_LABELS[selected.category]}</span>
                  <span>·</span>
                  <span>{formatDate(selected.created_at)}</span>
                </div>
                <h2 className="mt-2 text-xl font-bold text-foreground text-balance">{selected.subject}</h2>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-foreground-secondary">{selected.content}</p>
              </div>

              <dl className="grid gap-2 rounded-xl bg-[var(--admin-surface-2)] p-3 text-xs">
                <div className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-muted">用户</dt><dd className="min-w-0 break-all text-foreground">{selected.user.username || '-'} · {selected.user.email}</dd></div>
                <div className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-muted">页面</dt><dd className="min-w-0 break-all text-foreground">{selected.page_path || '-'}</dd></div>
                <div className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-muted">客户端</dt><dd className="min-w-0 break-all text-foreground">{selected.client_context.platform || '-'} · {selected.client_context.viewport || '-'}</dd></div>
                <div className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-muted">版本</dt><dd className="min-w-0 break-all text-foreground">{selected.client_context.app_version || '-'}</dd></div>
                <div className="flex gap-3"><dt className="w-20 shrink-0 text-foreground-muted">User Agent</dt><dd className="min-w-0 break-all text-foreground">{selected.client_context.user_agent || '-'}</dd></div>
              </dl>

              <div>
                <label htmlFor="admin-feedback-status" className="mb-1.5 block text-sm font-semibold text-foreground">处理状态</label>
                <select
                  id="admin-feedback-status"
                  value={draftStatus}
                  onChange={(event) => setDraftStatus(event.target.value as FeedbackStatus)}
                  className="feedback-field"
                >
                  {(Object.keys(STATUS_LABELS) as FeedbackStatus[]).map((value) => (
                    <option key={value} value={value}>{STATUS_LABELS[value]}</option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="admin-feedback-reply" className="mb-1.5 block text-sm font-semibold text-foreground">回复用户</label>
                <textarea
                  id="admin-feedback-reply"
                  value={draftReply}
                  onChange={(event) => setDraftReply(event.target.value)}
                  maxLength={2000}
                  rows={7}
                  placeholder="说明处理进度、解决办法或后续计划。保存后用户可见。"
                  className="feedback-field resize-y"
                />
                <p className="mt-1 text-right text-xs text-foreground-muted">{draftReply.length}/2000</p>
              </div>

              <button
                type="button"
                onClick={saveFeedback}
                disabled={saving}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-bold text-white hover:brightness-95 disabled:opacity-60"
              >
                <CheckCircle2 size={17} aria-hidden="true" />
                {saving ? '正在保存…' : '保存处理结果'}
              </button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
