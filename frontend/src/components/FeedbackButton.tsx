'use client';

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import { Capacitor } from '@capacitor/core';
import {
  CheckCircle2,
  Clock3,
  MessageCircle,
  Send,
  X,
} from 'lucide-react';
import { listMyFeedback, submitFeedback } from '@/lib/api';
import { getRuntimeAppInfo } from '@/lib/appUpdate';
import { useAuth } from '@/lib/hooks/AuthContext';
import type {
  FeedbackCategory,
  FeedbackItem,
  FeedbackStatus,
} from '@/lib/types';

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: 'bug', label: '遇到问题' },
  { value: 'suggestion', label: '功能建议' },
  { value: 'content', label: '内容反馈' },
  { value: 'account', label: '账号相关' },
  { value: 'other', label: '其他' },
];

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  closed: '已关闭',
};

function feedbackDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function FeedbackButton() {
  const { user, loading: authLoading } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<'compose' | 'history'>('compose');
  const [category, setCategory] = useState<FeedbackCategory>('suggestion');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [history, setHistory] = useState<FeedbackItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    const openFromNavigation = () => {
      setError('');
      setSuccess('');
      setView('compose');
      dialogRef.current?.showModal();
    };
    window.addEventListener('zhicui:open-feedback', openFromNavigation);
    return () => window.removeEventListener('zhicui:open-feedback', openFromNavigation);
  }, []);

  if (authLoading || !user) return null;

  const openDialog = () => {
    setError('');
    setSuccess('');
    setView('compose');
    dialogRef.current?.showModal();
  };

  const closeDialog = () => dialogRef.current?.close();

  const loadHistory = async () => {
    setView('history');
    setError('');
    setLoadingHistory(true);
    const response = await listMyFeedback(1, 20);
    if (response.success && response.data) {
      setHistory(response.data.items);
      setHistoryTotal(response.data.total);
    } else {
      setError(response.error || '暂时无法加载反馈记录');
    }
    setLoadingHistory(false);
  };

  const handleBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) closeDialog();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanSubject = subject.trim();
    const cleanContent = content.trim();
    if (cleanSubject.length < 2) {
      setError('请填写至少 2 个字符的反馈主题');
      return;
    }
    if (cleanContent.length < 5) {
      setError('请再具体描述一下问题或建议');
      return;
    }

    setError('');
    setSuccess('');
    setSubmitting(true);
    const platform = Capacitor.getPlatform();
    const runtimeInfo = await getRuntimeAppInfo().catch(() => ({
      nativeAndroid: false,
      version: 'Web',
      build: 0,
    }));
    const response = await submitFeedback({
      category,
      subject: cleanSubject,
      content: cleanContent,
      page_path: `${window.location.pathname}${window.location.search}`.slice(0, 512),
      platform: platform === 'android' ? 'android' : Capacitor.isNativePlatform() ? 'capacitor' : 'web',
      user_agent: navigator.userAgent.slice(0, 512),
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      app_version: runtimeInfo.nativeAndroid
        ? `${runtimeInfo.version} (${runtimeInfo.build})`
        : 'Web',
    });
    setSubmitting(false);

    if (!response.success || !response.data) {
      setError(response.error || '提交失败，请稍后再试');
      return;
    }

    setSubject('');
    setContent('');
    setSuccess('反馈已提交，我们会在这里更新处理进度。');
    setHistory((items) => [response.data!, ...items.filter((item) => item.id !== response.data!.id)]);
    setHistoryTotal((total) => Math.max(total + 1, 1));
  };

  return (
    <>
      <button
        type="button"
        className="feedback-launcher"
        onClick={openDialog}
        aria-label="提交反馈"
      >
        <MessageCircle size={19} aria-hidden="true" />
        <span>反馈</span>
      </button>

      <dialog
        ref={dialogRef}
        className="feedback-dialog"
        aria-labelledby="feedback-title"
        onClick={handleBackdrop}
      >
        <div className="flex max-h-[min(82dvh,720px)] min-h-0 flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-card-border px-4 py-4 sm:px-6">
            <div>
              <p className="text-xs font-semibold text-accent-emerald">帮助我们把知萃做得更好</p>
              <h2 id="feedback-title" className="mt-1 text-xl font-bold text-foreground text-balance">
                用户反馈
              </h2>
            </div>
            <button
              type="button"
              onClick={closeDialog}
              className="inline-flex size-10 items-center justify-center rounded-xl text-foreground-muted hover:bg-[var(--admin-surface-2)] hover:text-foreground"
              aria-label="关闭反馈窗口"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className="grid grid-cols-2 gap-1 border-b border-card-border bg-[var(--admin-surface-2)] p-1.5">
            <button
              type="button"
              onClick={() => { setView('compose'); setError(''); }}
              aria-pressed={view === 'compose'}
              className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${
                view === 'compose'
                  ? 'bg-[var(--admin-surface)] text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              提交反馈
            </button>
            <button
              type="button"
              onClick={loadHistory}
              aria-pressed={view === 'history'}
              className={`min-h-10 rounded-lg px-3 text-sm font-semibold ${
                view === 'history'
                  ? 'bg-[var(--admin-surface)] text-foreground shadow-sm'
                  : 'text-foreground-muted hover:text-foreground'
              }`}
            >
              我的反馈{historyTotal > 0 ? ` · ${historyTotal}` : ''}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
            {(error || success) && (
              <div
                role={error ? 'alert' : 'status'}
                className={`mb-4 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                  error
                    ? 'border-accent-rose/20 bg-accent-rose/5 text-accent-rose'
                    : 'border-accent-emerald/20 bg-accent-emerald/5 text-accent-emerald'
                }`}
              >
                {success && <CheckCircle2 className="mt-0.5 shrink-0" size={17} aria-hidden="true" />}
                <span>{error || success}</span>
              </div>
            )}

            {view === 'compose' ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="feedback-category" className="mb-1.5 block text-sm font-semibold text-foreground">
                    反馈类型
                  </label>
                  <select
                    id="feedback-category"
                    value={category}
                    onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
                    className="feedback-field"
                  >
                    {CATEGORIES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="feedback-subject" className="mb-1.5 block text-sm font-semibold text-foreground">
                    一句话概括
                  </label>
                  <input
                    id="feedback-subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    maxLength={160}
                    placeholder="例如：视频详情页的问答输入框被遮挡"
                    className="feedback-field"
                    required
                  />
                  <p className="mt-1 text-right text-xs text-foreground-muted">{subject.length}/160</p>
                </div>

                <div>
                  <label htmlFor="feedback-content" className="mb-1.5 block text-sm font-semibold text-foreground">
                    具体描述
                  </label>
                  <textarea
                    id="feedback-content"
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    maxLength={2000}
                    rows={7}
                    placeholder="发生了什么、你原本希望怎样，以及是否每次都会出现…"
                    className="feedback-field resize-y"
                    required
                  />
                  <p className="mt-1 flex items-center justify-between gap-3 text-xs text-foreground-muted">
                    <span>会附带当前页面、设备类型与屏幕尺寸，不会上传视频、Cookie 或页面正文。</span>
                    <span className="shrink-0">{content.length}/2000</span>
                  </p>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent-emerald px-4 text-sm font-bold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Send size={17} aria-hidden="true" />
                  {submitting ? '正在提交…' : '提交反馈'}
                </button>
              </form>
            ) : (
              <section aria-label="我的反馈记录">
                {loadingHistory ? (
                  <div className="py-12 text-center text-sm text-foreground-muted">正在加载…</div>
                ) : history.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-card-border px-5 py-10 text-center">
                    <MessageCircle className="mx-auto text-foreground-muted" size={28} aria-hidden="true" />
                    <p className="mt-3 font-semibold text-foreground">还没有反馈记录</p>
                    <p className="mt-1 text-sm text-foreground-muted">遇到问题或有新想法，都可以直接告诉我们。</p>
                    <button
                      type="button"
                      onClick={() => setView('compose')}
                      className="mt-4 min-h-10 rounded-xl bg-accent-emerald px-4 text-sm font-bold text-white"
                    >
                      提交第一条反馈
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {history.map((item) => (
                      <article key={item.id} className="rounded-2xl border border-card-border bg-[var(--admin-surface)] p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-foreground text-pretty">{item.subject}</p>
                            <p className="mt-1 text-xs text-foreground-muted">
                              {CATEGORIES.find((categoryItem) => categoryItem.value === item.category)?.label}
                              {' · '}
                              {feedbackDate(item.created_at)}
                            </p>
                          </div>
                          <span className={`feedback-status feedback-status--${item.status}`}>
                            {STATUS_LABELS[item.status]}
                          </span>
                        </div>
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground-secondary">{item.content}</p>
                        {item.admin_reply && (
                          <div className="mt-3 rounded-xl border-l-2 border-accent-emerald bg-accent-emerald/5 px-3 py-2.5">
                            <p className="text-xs font-semibold text-accent-emerald">知萃回复</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground">{item.admin_reply}</p>
                          </div>
                        )}
                        {!item.admin_reply && (
                          <p className="mt-3 flex items-center gap-1.5 text-xs text-foreground-muted">
                            <Clock3 size={14} aria-hidden="true" />
                            处理状态更新后会显示在这里
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}
