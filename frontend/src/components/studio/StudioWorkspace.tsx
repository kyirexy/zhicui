'use client';

import {
  Clapperboard,
  Download,
  Loader2,
  RefreshCw,
  Send,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelVideoCreationJob,
  confirmVideoCreationJob,
  createVideoCreationJob,
  getVideoCreationJob,
  iterateVideoCreationJob,
  listVideoCreationJobs,
  type VideoCreationJobInfo,
} from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import styles from './StudioWorkspace.module.css';

type JobStatus = VideoCreationJobInfo['status'];

const STATUS_TEXT: Record<JobStatus, string> = {
  drafting: 'AI 正在创作脚本…',
  draft: '脚本已就绪,请确认或继续修改',
  queued: '已排队,等待渲染…',
  rendering: '正在渲染成片,大约需要几分钟…',
  completed: '渲染完成,可以观看和下载了',
  failed: '渲染失败',
  cancelled: '已取消',
};

const ACTIVE_STATUSES: JobStatus[] = ['drafting', 'queued', 'rendering'];

function statusStep(status: JobStatus): number {
  if (status === 'drafting' || status === 'draft' || status === 'failed') return 1;
  if (status === 'queued' || status === 'rendering') return 2;
  if (status === 'completed') return 3;
  return 0;
}

const STEPS = [
  { title: '创作脚本', detail: 'AI 把需求写成 SVML' },
  { title: '渲染成片', detail: '确认估价后服务器渲染' },
  { title: '观看成品', detail: '播放或下载 MP4' },
];

function formatPricing(pricing: Record<string, unknown>): string {
  // hypit pricing JSON 的形状由 CLI 决定;尽力提取可读摘要,取不到就展示原始摘要。
  const estimate = pricing.estimate;
  if (typeof estimate === 'number') return `预估生成成本约 $${estimate.toFixed(2)}`;
  if (estimate && typeof estimate === 'object') {
    const record = estimate as Record<string, unknown>;
    const total = record.total ?? record.total_usd ?? record.amount;
    if (typeof total === 'number') return `预估生成成本约 $${total.toFixed(2)}`;
  }
  const text = JSON.stringify(pricing);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export default function StudioWorkspace() {
  const { user, loading: authLoading } = useAuth();
  const [jobs, setJobs] = useState<VideoCreationJobInfo[]>([]);
  const [activeJob, setActiveJob] = useState<VideoCreationJobInfo | null>(null);
  const [requirement, setRequirement] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pollRef = useRef<number | null>(null);

  const refreshJobs = useCallback(async () => {
    const response = await listVideoCreationJobs();
    if (response.success && Array.isArray(response.data)) {
      setJobs(response.data);
    }
  }, []);

  useEffect(() => {
    if (user) void refreshJobs();
  }, [user, refreshJobs]);

  // 活动任务轮询:drafting/queued/rendering 每 2.5 秒跟进一次,终态自动停止。
  useEffect(() => {
    const status = activeJob?.status;
    if (!status || !ACTIVE_STATUSES.includes(status)) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const jobId = activeJob.id;
    pollRef.current = window.setInterval(async () => {
      const response = await getVideoCreationJob(jobId);
      if (response.success && response.data) {
        setActiveJob(response.data);
        if (!ACTIVE_STATUSES.includes(response.data.status)) void refreshJobs();
      }
    }, 2500);
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJob, refreshJobs]);

  const submitRequirement = async () => {
    const text = requirement.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    const response = await createVideoCreationJob(text);
    setBusy(false);
    if (!response.success || !response.data) {
      setError(response.error || '创建失败,请稍后再试');
      return;
    }
    setActiveJob(response.data);
    setRequirement('');
    void refreshJobs();
  };

  const submitIterate = async () => {
    const text = feedback.trim();
    if (!text || busy || !activeJob) return;
    setBusy(true);
    setError('');
    const response = await iterateVideoCreationJob(activeJob.id, text);
    setBusy(false);
    if (!response.success || !response.data) {
      setError(response.error || '修改失败,请稍后再试');
      return;
    }
    setActiveJob(response.data);
    setFeedback('');
    void refreshJobs();
  };

  const confirmRender = async () => {
    if (!activeJob || busy) return;
    setBusy(true);
    setError('');
    const response = await confirmVideoCreationJob(activeJob.id);
    setBusy(false);
    if (!response.success || !response.data) {
      setError(response.error || '确认失败,请稍后再试');
      return;
    }
    setActiveJob(response.data);
    void refreshJobs();
  };

  const cancelActive = async () => {
    if (!activeJob || busy) return;
    setBusy(true);
    setError('');
    const response = await cancelVideoCreationJob(activeJob.id);
    setBusy(false);
    if (!response.success || !response.data) {
      setError(response.error || '取消失败,请稍后再试');
      return;
    }
    setActiveJob(response.data);
    void refreshJobs();
  };

  const selectJob = (job: VideoCreationJobInfo) => {
    if (busy) return;
    setError('');
    setActiveJob(job);
  };

  const step = useMemo(() => (activeJob ? statusStep(activeJob.status) : 0), [activeJob]);
  const canIterate = Boolean(
    activeJob && (activeJob.status === 'draft' || activeJob.status === 'failed') && activeJob.svml_text,
  );
  const canConfirm = Boolean(activeJob && activeJob.status === 'draft' && activeJob.svml_text);
  const canCancel = Boolean(activeJob && ACTIVE_STATUSES.includes(activeJob.status));
  const hasVideo = Boolean(activeJob && activeJob.status === 'completed' && activeJob.output_filename);

  if (!authLoading && !user) {
    return (
      <main className={styles.empty}>
        <Clapperboard size={28} aria-hidden="true" />
        <p>登录后即可使用创作工坊。</p>
      </main>
    );
  }

  return (
    <main className={styles.workspace}>
      <section className={styles.conversation} aria-label="创作对话">
        <header className={styles.header}>
          <h1><Clapperboard size={20} aria-hidden="true" /> 创作工坊</h1>
          <p>跟 AI 说需求,它会写成 hypit 脚本并在服务器渲染成视频;确认估价后才渲染。</p>
        </header>
        {jobs.length > 0 && (
          <nav className={styles.jobList} aria-label="创作历史">
            {jobs.map((job) => (
              <button
                key={job.id}
                type="button"
                className={`${styles.jobChip} ${activeJob?.id === job.id ? styles.jobChipActive : ''}`}
                onClick={() => selectJob(job)}
              >
                {job.requirement_text.slice(0, 24) || '未命名创作'}
                <span className={styles.jobChipStatus}>{STATUS_TEXT[job.status]}</span>
              </button>
            ))}
          </nav>
        )}
        <div className={styles.messages} aria-live="polite">
          {!activeJob && (
            <p className={styles.hint}>描述你想做的视频:主题、时长、风格,越具体越好。</p>
          )}
          {activeJob && (
            <>
              <p className={styles.requirementEcho}>需求:{activeJob.requirement_text}</p>
              <p className={`${styles.statusLine} ${styles[`status_${activeJob.status}`] ?? ''}`}>
                {ACTIVE_STATUSES.includes(activeJob.status)
                  ? <Loader2 size={15} className={styles.spin} aria-hidden="true" />
                  : null}
                {STATUS_TEXT[activeJob.status]}
              </p>
              {activeJob.explanation && (
                <p className={styles.explanation}>{activeJob.explanation}</p>
              )}
              {activeJob.error && <p className={styles.errorLine}>{activeJob.error}</p>}
              {error && <p className={styles.errorLine}>{error}</p>}
            </>
          )}
        </div>
        {activeJob && canIterate && (
          <form
            className={styles.inputForm}
            onSubmit={(event) => { event.preventDefault(); void submitIterate(); }}
          >
            <textarea
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="说说要改哪里:比如开头快一点、换个比喻、加一段数据…"
              rows={2}
              maxLength={2000}
            />
            <button type="submit" disabled={busy || !feedback.trim()} aria-label="提交修改">
              {busy ? <Loader2 size={16} className={styles.spin} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            </button>
          </form>
        )}
        {!activeJob && (
          <form
            className={styles.inputForm}
            onSubmit={(event) => { event.preventDefault(); void submitRequirement(); }}
          >
            <textarea
              value={requirement}
              onChange={(event) => setRequirement(event.target.value)}
              placeholder="例如:做一条 30 秒的咖啡科普,轻快节奏,结尾提醒适量饮用。"
              rows={3}
              maxLength={4000}
            />
            <button type="submit" disabled={busy || !requirement.trim()} aria-label="开始创作">
              {busy ? <Loader2 size={16} className={styles.spin} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
            </button>
          </form>
        )}
      </section>

      <section className={styles.project} aria-label="项目面板">
        {activeJob ? (
          <>
            <ol className={styles.steps} aria-label="创作进度">
              {STEPS.map((item, index) => (
                <li
                  key={item.title}
                  className={`${index < step ? styles.stepDone : ''} ${index + 1 === step ? styles.stepCurrent : ''}`}
                >
                  <span className={styles.stepIndex}>{index + 1}</span>
                  <span className={styles.stepBody}>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                </li>
              ))}
            </ol>

            {activeJob.pricing && Object.keys(activeJob.pricing).length > 0 && (
              <div className={styles.pricingCard}>
                <h2>渲染估价</h2>
                <p>{formatPricing(activeJob.pricing)}</p>
                {canConfirm && (
                  <button type="button" className={styles.confirm} disabled={busy} onClick={() => void confirmRender()}>
                    确认并开始渲染
                  </button>
                )}
              </div>
            )}

            {activeJob.svml_text && (
              <details className={styles.svmlBlock}>
                <summary>查看 SVML 脚本</summary>
                <pre>{activeJob.svml_text}</pre>
              </details>
            )}

            {hasVideo && (
              <div className={styles.result}>
                <video
                  controls
                  preload="metadata"
                  src={`/api/video-creation/jobs/${encodeURIComponent(activeJob.id)}/video`}
                />
                <a
                  className={styles.download}
                  href={`/api/video-creation/jobs/${encodeURIComponent(activeJob.id)}/video`}
                  download={`zhicui-studio-${activeJob.id}.mp4`}
                >
                  <Download size={15} aria-hidden="true" /> 下载 MP4
                </a>
              </div>
            )}

            {canCancel && (
              <button type="button" className={styles.cancel} disabled={busy} onClick={() => void cancelActive()}>
                <Square size={14} aria-hidden="true" /> 取消这个创作
              </button>
            )}
            <button
              type="button"
              className={styles.newJob}
              disabled={busy}
              onClick={() => { setActiveJob(null); setRequirement(''); setFeedback(''); }}
            >
              <RefreshCw size={14} aria-hidden="true" /> 再创作一个
            </button>
          </>
        ) : (
          <div className={styles.projectEmpty}>
            <p>创作开始后,这里会显示进度、脚本、估价和成品。</p>
          </div>
        )}
      </section>
    </main>
  );
}
