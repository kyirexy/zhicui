'use client';

import Link from 'next/link';
import { ArrowSquareOut, CheckCircle, Clock, FileText, WarningCircle } from '@phosphor-icons/react';
import { MessageResponse } from '@/components/ai-elements/message';
import type { ResearchRun } from '@/lib/dailyResearchApi';
import { isResearchRunActive, researchCoverageLabel, researchDate, researchDeliveryLabel, researchRunLabel, safeResearchSourceUrl } from '@/lib/dailyResearchUi';
import styles from './dailyResearch.module.css';

export default function ResearchReportView({ run }: { run: ResearchRun }) {
  const active = isResearchRunActive(run);
  const report = run.report;
  const markdown = report?.markdown || run.result_text;
  const statusWarning = ['partial', 'failed', 'waiting_for_user'].includes(run.status);
  const StatusIcon = statusWarning ? WarningCircle : active ? Clock : CheckCircle;
  const stats = run.stats;

  return <article className={styles.panel} aria-labelledby="research-report-title">
    <header className={styles.reportHeader}>
      <div className={styles.reportMeta}><span><FileText size={15} aria-hidden="true" />{run.trigger === 'manual' ? '手动研究' : '定时研究'}</span><time dateTime={run.created_at}>{researchDate(run.created_at)} · 北京时间</time></div>
      <h2 id="research-report-title">{report?.title || '视频研究报告'}</h2>
      <div className={styles.runState} data-warning={statusWarning} role="status"><StatusIcon size={18} aria-hidden="true" /><strong>{researchRunLabel(run)}</strong></div>
      {run.stage_message && <p className={styles.stageMessage}>{run.stage_message}</p>}
      {(run.status === 'waiting_for_desktop' || run.stage === 'waiting_for_desktop') && <p className={styles.notice}>请打开知萃电脑客户端并登录此账号，保持客户端在线。研究任务会等待同步结果。</p>}
      {(run.status === 'waiting_for_user' || run.stage === 'waiting_for_user') && <p className={styles.notice}>请在电脑客户端打开对应平台，完成登录或验证码验证。<Link href="/library?sync=1">前往视频资料查看同步</Link></p>}
    </header>
    <dl className={styles.metrics}>
      {([['已读取', stats?.read], ['已保存', stats?.saved], ['新发现', stats?.created], ['复用', stats?.reused], ['跳过', stats?.skipped], ['失败', stats?.failed]] as const).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{typeof count === 'number' ? count.toLocaleString('zh-CN') : '—'}</dd></div>)}
    </dl>
    <div className={styles.coverage}><strong>{researchCoverageLabel(run.coverage)}</strong><span>近日期筛选依据首次发现时间；互动量是同步时的快照，不代表热度增速。</span></div>
    <div className={styles.delivery} data-warning={['failed', 'not_configured', 'verification_required', 'unknown'].includes(run.delivery_status)}><strong>{researchDeliveryLabel(run.delivery_status)}</strong>{run.delivery_error && <span>{run.delivery_error}</span>}{markdown && run.delivery_status !== 'sent' && <span>站内报告已保留，可在本页阅读。</span>}</div>
    {markdown ? <div className={styles.reportBody}>
      {report?.window_start && report.window_end && <p className={styles.hint}>研究窗口：{researchDate(report.window_start)} 至 {researchDate(report.window_end)}（北京时间）</p>}
      <MessageResponse mode="static" isAnimating={false}>{markdown}</MessageResponse>
    </div> : <div className={styles.emptyReport}><FileText size={28} aria-hidden="true" /><p>{active ? '报告生成后会显示在这里。可以离开本页，稍后回来查看。' : '本次尚未生成研究正文。请查看运行说明，处理后再发起研究。'}</p></div>}
    {Boolean(report?.limitations?.length) && <section className={styles.reportSection} aria-label="研究范围说明"><h3>本次研究的边界</h3><ul>{report!.limitations.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul></section>}
    {Boolean(report?.sync_sources?.length) && <details className={styles.coverageDetails}><summary>查看各来源同步覆盖</summary><div className={styles.sourceCoverage}>{report!.sync_sources!.map((source, index) => <div key={`${source.platform}:${source.source_mode}:${index}`}><strong>{source.platform === 'douyin' ? '抖音' : source.platform === 'bilibili' ? 'B站' : source.platform} · {source.source_mode === 'like' ? '喜欢' : source.source_mode === 'collect' ? '收藏' : source.source_mode}</strong><span>{researchCoverageLabel(source.coverage)} · 读取 {source.read} / 保存 {source.saved} / 失败 {source.failed}</span>{source.error && <span className={styles.error}>{source.error}</span>}</div>)}</div></details>}
    {Boolean(report?.sources?.length) && <section className={styles.reportSection} aria-labelledby="research-sources-title">
      <h3 id="research-sources-title">研究来源 <span>{report!.sources.length} 条</span></h3>
      <p className={styles.hint}>文稿就绪与仅有标题、互动数据的来源分别标记；具体纳入范围见报告说明。制作建议请结合自己的素材与制作条件选择。</p>
      <ol className={styles.sources}>{report!.sources.map((source, index) => {
        const url = safeResearchSourceUrl(source.url);
        const metrics = Object.entries(source.engagement || {}).filter(([, count]) => typeof count === 'number' && Number.isFinite(count));
        const labels: Record<string, string> = { likes: '赞', comments: '评论', shares: '分享', collects: '收藏', views: '播放' };
        return <li key={`${source.video_id}:${index}`}><div className={styles.sourceTitle}><span>{String(index + 1).padStart(2, '0')}</span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{source.title || '未命名视频'}<ArrowSquareOut size={15} aria-hidden="true" /></a> : <strong>{source.title || '未命名视频'}</strong>}</div><div className={styles.sourceMeta}><span>{source.evidence_level === 'transcript' ? '文稿已就绪' : '仅标题与互动数据'}</span>{source.modes?.map((mode) => <span key={mode}>{mode === 'like' ? '喜欢' : '收藏'}</span>)}{metrics.length ? metrics.map(([key, count]) => <span key={key}>{labels[key] || key} {(count as number).toLocaleString('zh-CN')}</span>) : <span>互动数据未获取</span>}</div>{source.recommendation_reason && <p>{source.recommendation_reason}</p>}{source.note_id && <Link className={styles.textLink} href={`/notes?id=${encodeURIComponent(source.note_id)}`}>查看知识卡片</Link>}</li>;
      })}</ol>
    </section>}
    {run.agent_thread_id && <Link className={styles.textLink} href={`/harness?thread=${encodeURIComponent(run.agent_thread_id)}`}>继续追问这份研究<ArrowSquareOut size={15} aria-hidden="true" /></Link>}
  </article>;
}
