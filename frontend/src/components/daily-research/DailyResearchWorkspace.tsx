'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowsClockwise, CalendarCheck, Desktop, EnvelopeSimple, FileText, Pause, PencilSimple, Play, Plus, Trash, X } from '@phosphor-icons/react';
import { deleteResearchSubscription, getResearchRun, getResearchStatus, listResearchRuns, listResearchSubscriptions, patchResearchSubscription, startResearchRun, type ResearchRun, type ResearchSubscription } from '@/lib/dailyResearchApi';
import { isResearchRunActive, researchDate, researchDeliveryLabel, researchRunLabel } from '@/lib/dailyResearchUi';
import ResearchSubscriptionForm from './ResearchSubscriptionForm';
import ResearchReportView from './ResearchReportView';
import styles from './dailyResearch.module.css';

/** 每个资源串行轮询；切换订阅、切换账号和离开页面都会取消旧请求。 */
function useResearchPolling<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, revision: number, interval: number) {
  const loader = useRef(load);
  loader.current = load;
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string; loading: boolean }>({ key: null, data: null, error: '', loading: true });
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState((previous) => ({ key, data: previous.key === key ? previous.data : null, error: '', loading: true }));
    async function refresh() {
      try {
        const data = await loader.current(controller.signal);
        if (!controller.signal.aborted) setState({ key, data, error: '', loading: false });
      } catch (reason) {
        if (!controller.signal.aborted) setState((previous) => ({ key, data: previous.key === key ? previous.data : null, error: reason instanceof Error ? reason.message : '读取失败，请重试', loading: false }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => { if (document.visibilityState === 'hidden') timer = setTimeout(refresh, interval); else void refresh(); }, interval);
      }
    }
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [key, revision, interval]);
  return state.key === key ? state : { key, data: null, error: '', loading: Boolean(key) };
}

export default function DailyResearchWorkspace({ accountEmail }: { accountEmail: string }) {
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ key: number; subscription?: ResearchSubscription } | null>(null);
  const [deletePending, setDeletePending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const selection = useRef<string | null>(null);
  const openedDeepLink = useRef(false);
  const status = useResearchPolling('status', getResearchStatus, revision, 15000);
  const subscriptions = useResearchPolling('subscriptions', listResearchSubscriptions, revision, 15000);
  const items = subscriptions.data?.items || [];
  const current = items.find((item) => item.id === selectedId) || (selectedId ? null : items[0]) || null;
  selection.current = current?.id || null;
  const history = useResearchPolling(current?.id || null, (signal) => listResearchRuns(current!.id, signal), revision, 6000);
  const runId = selectedRunId || history.data?.items[0]?.id || null;
  const detail = useResearchPolling(runId, (signal) => getResearchRun(runId!, signal), revision, 5000);
  const activeRun = history.data?.items.find(isResearchRunActive);
  const maxSubscriptions = status.data?.limits.max_subscriptions || 5;

  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (openedDeepLink.current) return;
    openedDeepLink.current = true;
    const run = new URLSearchParams(window.location.search).get('run');
    if (run && /^[a-zA-Z0-9_-]{1,100}$/.test(run)) setSelectedRunId(run);
  }, []);
  useEffect(() => {
    if (detail.data && selectedRunId && detail.data.subscription_id !== selection.current && !selectedId) setSelectedId(detail.data.subscription_id);
  }, [detail.data, selectedId, selectedRunId]);

  function refresh() { setRevision((value) => value + 1); }
  function selectSubscription(item: ResearchSubscription) {
    setSelectedId(item.id); setSelectedRunId(null); setEditor(null); setDeletePending(null); setError(''); setNotice('');
  }

  async function action(kind: 'run' | 'toggle' | 'delete') {
    if (!current || request.current) return;
    const id = current.id;
    const controller = new AbortController();
    request.current = controller; setBusy(kind); setError(''); setNotice('');
    try {
      if (kind === 'run') {
        const run: ResearchRun = await startResearchRun(id, controller.signal);
        if (!controller.signal.aborted && selection.current === id) { setSelectedRunId(run.id); setNotice('研究任务已提交，可在此查看进度与报告。'); }
      } else if (kind === 'toggle') {
        const updated = await patchResearchSubscription(id, { enabled: !current.enabled }, controller.signal);
        if (!controller.signal.aborted && selection.current === id) setNotice(updated.enabled ? '订阅已启用，请保持电脑客户端在线。' : '订阅已暂停。');
      } else {
        await deleteResearchSubscription(id, controller.signal);
        if (!controller.signal.aborted && selection.current === id) { setSelectedId(null); setSelectedRunId(null); setDeletePending(null); setNotice('订阅已删除。'); }
      }
      if (!controller.signal.aborted) refresh();
    } catch (reason) {
      if (!controller.signal.aborted && selection.current === id) setError(reason instanceof Error ? reason.message : '操作未完成，请重试');
    } finally {
      if (request.current === controller) { request.current = null; setBusy(null); }
    }
  }

  return <main className={styles.workspace}>
    <header className={styles.pageHeading}><div><span className={styles.eyebrow}><CalendarCheck size={18} aria-hidden="true" />视频研究</span><h1>每日研究</h1><p>同步你的喜欢与收藏，整理热度线索、选题和制作建议。</p></div><div className={styles.headerActions}><button className={styles.iconButton} type="button" onClick={refresh} aria-label="刷新每日研究" disabled={status.loading || subscriptions.loading}><ArrowsClockwise size={19} aria-hidden="true" /></button><button type="button" className={styles.primaryButton} disabled={Boolean(busy) || items.length >= maxSubscriptions || Boolean(editor)} onClick={() => setEditor({ key: Date.now() })}><Plus size={17} aria-hidden="true" />新建订阅</button></div></header>

    <div className={styles.serviceStrip} aria-label="服务状态">
      <span><Desktop size={17} aria-hidden="true" />{status.data ? status.data.desktop.online ? '电脑客户端在线' : '等待电脑客户端在线' : '正在读取客户端状态'}{status.data?.desktop.last_seen_at && <small>最近在线 {researchDate(status.data.desktop.last_seen_at)}</small>}</span>
      <span><CalendarCheck size={17} aria-hidden="true" />{status.data ? status.data.scheduler.enabled && status.data.scheduler.running ? '定时服务运行中' : '定时服务未运行' : '正在读取定时服务'}</span>
      <span><EnvelopeSimple size={17} aria-hidden="true" />{status.data ? status.data.email.configured ? '邮件服务可用' : '邮件服务未配置 · 支持站内报告' : '正在读取邮件状态'}</span>
    </div>
    {status.error && <p className={styles.error} role="alert">服务状态读取失败：{status.error} <button type="button" className={styles.textButton} onClick={refresh}>重试</button></p>}
    {status.data && (!status.data.scheduler.enabled || !status.data.scheduler.running) && <p className={styles.notice}>当前定时服务未运行，保存订阅后暂时不会按时自动执行。请联系管理员检查服务；已提交的任务会等待服务恢复。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}

    <div className={styles.layout}>
      <aside className={styles.sidebar} aria-label="研究订阅与历史">
        <section className={styles.sideSection}><div className={styles.sideHeading}><h2>我的订阅</h2><span>{items.length} / {maxSubscriptions}</span></div>
          {subscriptions.loading && !subscriptions.data ? <p className={styles.placeholder} role="status">正在读取订阅…</p> : subscriptions.error && !subscriptions.data ? <div className={styles.placeholder}><p role="alert">{subscriptions.error}</p><button type="button" className={styles.secondaryButton} onClick={refresh}>重试</button></div> : !items.length ? <p className={styles.placeholder}>还没有订阅。设置一次执行时间和研究方向，即可在这里查看每次结果。</p> : <div className={styles.subscriptionList}>{items.map((item) => <button className={styles.subscription} type="button" data-selected={current?.id === item.id} aria-pressed={current?.id === item.id} key={item.id} onClick={() => selectSubscription(item)} disabled={Boolean(busy)}><strong>{item.name}</strong><span>{item.enabled ? `每天 ${item.schedule_time}` : '已暂停'} · 近 {item.window_days} 日</span><small>{item.platforms.map((platform) => platform === 'douyin' ? '抖音' : 'B站').join(' / ')} · {item.source_modes.map((mode) => mode === 'like' ? '喜欢' : '收藏').join('、')}</small></button>)}</div>}
          {subscriptions.error && subscriptions.data && <p className={styles.error} role="alert">更新失败，正在显示上次读取的订阅。</p>}
        </section>
        {current && <section className={styles.sideSection}><div className={styles.sideHeading}><h2>研究历史</h2><span>{history.data?.total ?? '—'} 次</span></div>{history.loading && !history.data ? <p className={styles.placeholder} role="status">正在读取历史…</p> : history.error ? <div className={styles.placeholder}><p role="alert">{history.error}</p><button type="button" className={styles.textButton} onClick={refresh}>重试</button></div> : !history.data?.items.length ? <p className={styles.placeholder}>首次研究完成后，报告会保存在这里。也可以先手动运行一次。</p> : <div className={styles.history}>{history.data.items.map((run) => <button type="button" key={run.id} aria-pressed={run.id === runId} data-selected={run.id === runId} onClick={() => setSelectedRunId(run.id)}><time dateTime={run.created_at}>{researchDate(run.created_at)}</time><strong>{researchRunLabel(run)}</strong><small>{researchDeliveryLabel(run.delivery_status)}</small></button>)}</div>}</section>}
      </aside>

      <div className={styles.content}>
        {editor ? <ResearchSubscriptionForm key={editor.key} subscription={editor.subscription} accountEmail={status.data?.account_email || accountEmail} status={status.data} onCancel={() => setEditor(null)} onVerified={refresh} onSaved={(saved) => { setSelectedId(saved.id); setSelectedRunId(null); setEditor(null); setNotice('订阅已保存。每次研究的进度和完整报告都可以在这里查看。'); refresh(); }} /> : current ? <section className={styles.subscriptionSummary} aria-labelledby="subscription-title"><div><h2 id="subscription-title">{current.name}</h2><p>{current.enabled ? `每天 ${current.schedule_time}` : '自动研究已暂停'} · {current.timezone} · 昨天零点至本次同步完成</p><p className={styles.hint}>下次执行（北京时间）：{current.enabled && status.data?.scheduler.enabled && status.data.scheduler.running ? researchDate(current.next_run_at) : '等待启用定时服务或订阅'}</p><p className={styles.hint}>{current.recipient_email ? `收件邮箱：${current.recipient_email}` : '仅保存站内报告'}{current.focus_topics.length > 0 ? ` · 关注：${current.focus_topics.join('、')}` : ''}</p></div><div className={styles.summaryActions}><button type="button" className={styles.primaryButton} disabled={Boolean(busy) || Boolean(activeRun)} onClick={() => void action('run')}><Play size={16} aria-hidden="true" />{busy === 'run' ? '提交中…' : activeRun ? '研究进行中' : '立即研究'}</button><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => setEditor({ key: Date.now(), subscription: current })}><PencilSimple size={16} aria-hidden="true" />编辑</button><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => void action('toggle')}>{current.enabled ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}{busy === 'toggle' ? '保存中…' : current.enabled ? '暂停' : '启用'}</button><button type="button" className={styles.iconButton} aria-label="删除订阅" disabled={Boolean(busy)} onClick={() => setDeletePending(current.id)}><Trash size={17} aria-hidden="true" /></button></div>{deletePending === current.id && <div className={styles.deleteConfirm} role="group" aria-label="确认删除订阅"><p>删除「{current.name}」并停止后续自动研究？历史报告仍会保留。</p><button type="button" className={styles.secondaryButton} disabled={Boolean(busy)} onClick={() => setDeletePending(null)}><X size={15} />取消</button><button type="button" className={styles.dangerButton} disabled={Boolean(busy)} onClick={() => void action('delete')}>{busy === 'delete' ? '删除中…' : '确认删除'}</button></div>}</section> : !subscriptions.loading && !subscriptions.error && !selectedRunId ? <section className={`${styles.panel} ${styles.onboarding}`}><CalendarCheck size={35} aria-hidden="true" /><h2>让收藏成为下一次创作的起点</h2><p>默认每天北京时间 15:00，同步抖音喜欢与收藏，研究昨天零点至本次同步完成期间首次发现的视频。</p><ol><li>同步已授权平台的喜欢和收藏</li><li>参考互动数据与可用文稿，整理选题和制作建议</li><li>保存完整站内报告，按邮箱配置尝试投递</li></ol><button type="button" className={styles.primaryButton} onClick={() => setEditor({ key: Date.now() })}><Plus size={17} />创建第一份研究订阅</button><p className={styles.hint}>同步时需要知萃电脑客户端在线；平台验证和数据不完整都会明确提示。</p></section> : null}

        {!editor && runId && (detail.data ? <ResearchReportView run={detail.data} /> : detail.loading ? <section className={`${styles.panel} ${styles.loadingPanel}`} role="status"><FileText size={26} aria-hidden="true" /><p>正在读取研究报告…</p></section> : <section className={styles.panel}><p className={styles.error} role="alert">{detail.error || '暂时无法读取报告'}</p><button type="button" className={styles.secondaryButton} onClick={refresh}>重试</button></section>)}
        {!editor && detail.data && detail.error && <p className={styles.error} role="alert">报告更新失败，当前显示上次读取的内容。<button type="button" className={styles.textButton} onClick={refresh}>重试</button></p>}
        {!editor && current && !runId && !history.loading && !history.error && <section className={`${styles.panel} ${styles.emptyReport}`}><FileText size={30} aria-hidden="true" /><h3>还没有研究报告</h3><p>点击「立即研究」，或等待下一次定时执行。报告会保留来源链接、研究依据和覆盖范围。</p><Link href="/library?sync=1" className={styles.textLink}>查看平台同步设置</Link></section>}
      </div>
    </div>
  </main>;
}
