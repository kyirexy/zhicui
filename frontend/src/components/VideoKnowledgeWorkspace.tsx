'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CalendarCheck2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  DatabaseZap,
  FileText,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import ContentChat from '@/components/ContentChat';
import TranscriptViewer from '@/components/TranscriptViewer';
import {
  extractDouyinLibraryItem,
  getDouyinLibraryItem,
  runNotePlanAgent,
} from '@/lib/api';
import {
  CARD_TYPE_CONFIG,
  getPlanProgress,
  type DouyinVideoWorkspace,
} from '@/lib/types';

type WorkspaceTab = 'chat' | 'transcript' | 'plan';

const TABS: Array<{
  id: WorkspaceTab;
  label: string;
  Icon: typeof Bot;
}> = [
  { id: 'chat', label: 'AI 问答', Icon: Bot },
  { id: 'transcript', label: '完整文案', Icon: FileText },
  { id: 'plan', label: '行动计划', Icon: CalendarCheck2 },
];

const CREATE_PROMPTS = [
  { label: '7 天入门', value: '把视频方法整理成 7 天入门计划，每天只安排最关键的行动。' },
  { label: '每天 30 分钟', value: '按每天 30 分钟安排，写清楚每天具体做什么。' },
  { label: '只留关键步骤', value: '只保留最重要的步骤，按优先级排成可执行计划。' },
];

const REVISE_PROMPTS = [
  { label: '更轻松', value: '保留已完成任务，把剩余任务调整为每天不超过 30 分钟。' },
  { label: '改成 7 天', value: '保留已完成任务，把剩余内容重新安排到接下来 7 天。' },
  { label: '拆得更细', value: '把剩余任务拆得更具体，并标出最优先的三件事。' },
];

function OnDemandVideoPlayer({
  mediaUrl,
  coverUrl,
  title,
  sourceUrl,
}: {
  mediaUrl: string;
  coverUrl: string;
  title: string;
  sourceUrl: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [requested, setRequested] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState(false);

  const startPlayback = () => {
    if (requested) return;
    setRequested(true);
    setFailed(false);
    const playback = videoRef.current?.play();
    if (playback) {
      void playback.catch(() => {
        // 网络错误交给 video 的 onError 统一展示；浏览器策略拒绝时仍可用原生控件重试。
      });
    }
  };

  return (
    <div className="video-knowledge-player">
      <video
        ref={videoRef}
        src={mediaUrl}
        poster={coverUrl || undefined}
        controls={started}
        playsInline
        preload="none"
        onPlaying={() => {
          setStarted(true);
          setFailed(false);
        }}
        onError={() => setFailed(true)}
        aria-label={`播放视频：${title}`}
      />

      {!started && !failed && (
        <button
          type="button"
          className={`video-knowledge-play-cover ${requested ? 'is-requested' : ''}`}
          onClick={startPlayback}
          disabled={requested}
          aria-label={requested ? '正在准备视频播放' : `播放视频：${title}`}
        >
          {coverUrl ? <img src={coverUrl} alt="" aria-hidden="true" /> : null}
          <span className="video-knowledge-play-shade" aria-hidden="true" />
          <span className="video-knowledge-play-action">
            {!requested && (
              <span className="video-knowledge-play-icon" aria-hidden="true">
                <Play size={28} fill="currentColor" />
              </span>
            )}
            <strong>{requested ? '正在准备视频…' : '播放视频'}</strong>
            <small>按需读取，不保存视频文件</small>
          </span>
        </button>
      )}

      {failed && (
        <div className="video-knowledge-play-failure" role="alert">
          {coverUrl ? <img src={coverUrl} alt="" aria-hidden="true" /> : null}
          <span>
            <CircleAlert size={20} />
            <strong>视频暂时无法读取</strong>
            <small>视频文件不会保存在知萃，可前往抖音继续观看。</small>
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              打开原视频
              <ArrowUpRight size={14} />
            </a>
          </span>
        </div>
      )}
    </div>
  );
}

function formatDate(value: string): string {
  if (!value) return '已同步';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsed);
}

export default function VideoKnowledgeWorkspace() {
  const searchParams = useSearchParams();
  const awemeId = searchParams.get('id')?.trim() || '';
  const [workspace, setWorkspace] = useState<DouyinVideoWorkspace | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [initializingAi, setInitializingAi] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [agentNotice, setAgentNotice] = useState('');
  const [error, setError] = useState('');

  const loadWorkspace = useCallback(async () => {
    if (!awemeId) {
      setError('缺少视频标识，请从视频资料库重新打开。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const response = await getDouyinLibraryItem(awemeId);
    if (response.success && response.data) {
      setWorkspace(response.data);
    } else {
      setWorkspace(null);
      setError(response.error || '这个视频暂时无法打开');
    }
    setLoading(false);
  }, [awemeId]);

  useEffect(() => {
    window.scrollTo(0, 0);
    void loadWorkspace();
  }, [loadWorkspace]);

  const note = workspace?.note ?? null;
  const plan = workspace?.plan ?? null;
  const prompts = plan ? REVISE_PROMPTS : CREATE_PROMPTS;
  const progress = useMemo(
    () => plan ? getPlanProgress(plan) : null,
    [plan],
  );
  const nextPlanTasks = useMemo(() => {
    if (!plan) return [];
    const tasks = plan.days?.length
      ? plan.days.flatMap(day => day.tasks)
      : plan.tasks ?? [];
    return tasks.filter(task => !task.done).slice(0, 3);
  }, [plan]);

  const prepareVideo = async () => {
    if (!workspace || extracting) return;
    setExtracting(true);
    setError('');
    const response = await extractDouyinLibraryItem(
      workspace.item.aweme_id,
      'transcript',
    );
    setExtracting(false);
    if (!response.success) {
      setError(response.error || '完整文案提取失败，请稍后重试');
      return;
    }
    await loadWorkspace();
  };

  const initializeAi = async () => {
    if (!workspace || !note || note.ai_initialized || initializingAi) return;
    setInitializingAi(true);
    setError('');
    const response = await extractDouyinLibraryItem(
      workspace.item.aweme_id,
      'ai',
    );
    setInitializingAi(false);
    if (!response.success) {
      setError(response.error || 'AI 总结与知识卡生成失败，请稍后重试');
      return;
    }
    await loadWorkspace();
  };

  const submitPlanInstruction = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const cleanInstruction = instruction.trim();
    if (!note || !cleanInstruction || agentRunning) return;
    setAgentRunning(true);
    setAgentNotice('');
    setError('');
    const response = await runNotePlanAgent(note.id, cleanInstruction);
    setAgentRunning(false);
    if (!response.success || !response.data) {
      setError(response.error || '计划 Agent 暂时没有完成这次调整');
      return;
    }
    setWorkspace((current) => (
      current
        ? { ...current, plan: response.data!.plan }
        : current
    ));
    setInstruction('');
    setAgentNotice(response.data.change_summary);
  };

  if (loading) {
    return (
      <div className="video-knowledge-loading" role="status">
        <span className="video-knowledge-loading-mark" aria-hidden />
        <strong>正在打开视频知识工作区</strong>
        <span>读取视频、完整文案与行动计划</span>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <section className="video-knowledge-failure">
        <CircleAlert size={30} />
        <h1>没有找到这个视频</h1>
        <p>{error}</p>
        <div>
          <Link href="/library">
            <ArrowLeft size={16} />
            返回视频资料库
          </Link>
          <button type="button" onClick={() => void loadWorkspace()}>
            <RotateCcw size={15} />
            重新读取
          </button>
        </div>
      </section>
    );
  }

  if (!workspace) return null;

  const { item } = workspace;
  const cardConfig = CARD_TYPE_CONFIG[note?.card_type || 'general'];

  return (
    <div className="video-knowledge-page">
      <header className="video-knowledge-topbar">
        <Link href="/library" className="video-knowledge-back">
          <ArrowLeft size={16} />
          视频资料库
        </Link>
        <div className="video-knowledge-storage">
          <DatabaseZap size={14} />
          视频按需临时读取，服务器与数据库均不保存视频文件
        </div>
      </header>

      <section className="video-knowledge-shell">
        <div className="video-knowledge-media">
          <div className="video-knowledge-stage">
            {item.media_url ? (
              <OnDemandVideoPlayer
                key={item.media_url}
                mediaUrl={item.media_url}
                coverUrl={item.cover_url}
                title={item.title}
                sourceUrl={item.source_url}
              />
            ) : item.cover_url ? (
              <div className="video-knowledge-no-media">
                <img src={item.cover_url} alt={`${item.title} 视频封面`} />
                <span><CircleAlert size={16} />下载器中没有可播放文件</span>
              </div>
            ) : (
              <div className="video-knowledge-no-media">
                <Play size={44} />
                <span>下载器中没有可播放文件</span>
              </div>
            )}
            <span className="video-knowledge-source-pill">
              抖音 · {item.source_mode === 'collect' ? '收藏' : item.source_mode === 'like' ? '喜欢' : '我的作品'}
            </span>
          </div>

          <div className="video-knowledge-meta">
            <div className="video-knowledge-author">
              <span>{item.author_name?.slice(0, 1) || '视'}</span>
              <div>
                <strong>{item.author_name || '未知作者'}</strong>
                <small>{formatDate(item.date || item.recorded_at)}</small>
              </div>
            </div>
            <a href={item.source_url} target="_blank" rel="noreferrer">
              查看原视频
              <ArrowUpRight size={14} />
            </a>
          </div>

          <div className="video-knowledge-title">
            <h1>{item.title}</h1>
            {item.caption && item.caption !== item.title && (
              <p>{item.caption}</p>
            )}
          </div>

          <div className="video-knowledge-facts">
            <span>
              <FileText size={14} />
              {note
                ? `${(note.transcript_raw?.length || 0).toLocaleString('zh-CN')} 字完整文案`
                : '等待生成完整文案'}
            </span>
            {note?.ai_initialized ? (
              <span>
                <Sparkles size={14} />
                {cardConfig.label} · 已完成 AI 理解
              </span>
            ) : note ? (
              <span>
                <Sparkles size={14} />
                文案已就绪 · 可直接问 AI
              </span>
            ) : null}
            {plan && progress && (
              <span>
                <CalendarCheck2 size={14} />
                计划进度 {progress.done}/{progress.total}
              </span>
            )}
            {note && !note.ai_initialized && (
              <button
                type="button"
                className="video-knowledge-ai-init"
                onClick={() => void initializeAi()}
                disabled={initializingAi}
              >
                {initializingAi ? (
                  <LoaderCircle size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {initializingAi ? 'AI 正在整理' : '生成 AI 总结与知识卡'}
              </button>
            )}
          </div>
        </div>

        <aside className="video-knowledge-panel">
          <nav className="video-knowledge-tabs" aria-label="视频知识功能">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={activeTab === id ? 'is-active' : ''}
                onClick={() => setActiveTab(id)}
                aria-selected={activeTab === id}
                role="tab"
              >
                <Icon size={16} />
                {label}
                {id === 'transcript' && note && (
                  <small>{(note.transcript_raw?.length || 0).toLocaleString('zh-CN')}</small>
                )}
                {id === 'plan' && plan && (
                  <small>{progress?.total || 0}</small>
                )}
              </button>
            ))}
          </nav>

          <div className="video-knowledge-tabpanel" role="tabpanel">
            {!note ? (
              <div className="video-knowledge-prepare">
                <span className="video-knowledge-prepare-mark" aria-hidden>
                  <WandSparkles size={28} />
                </span>
                <small>先补齐这条视频的完整文案</small>
                <h2>文案就绪后，就能直接提问和创建计划</h2>
                <p>
                  系统会临时读取视频完成云端语音识别，处理结束立即清理，只保存完整文案；AI 总结与知识卡由你之后按需生成。
                </p>
                <button
                  type="button"
                  onClick={() => void prepareVideo()}
                  disabled={extracting || !item.can_extract}
                >
                  {extracting ? (
                    <LoaderCircle size={17} className="animate-spin" />
                  ) : (
                    <Sparkles size={17} />
                  )}
                  {extracting ? '正在提取完整文案' : '补提文案并开启工作区'}
                </button>
                {!item.can_extract && <span>请先在视频资料库重新同步这条视频</span>}
              </div>
            ) : activeTab === 'chat' ? (
              <ContentChat
                noteId={note.id}
                cardType={note.card_type}
                title={note.title}
              />
            ) : activeTab === 'transcript' ? (
              <section className="video-knowledge-transcript">
                <header>
                  <div>
                    <small>完整来源</small>
                    <h2>视频文案</h2>
                  </div>
                  <span>{(note.transcript_raw?.length || 0).toLocaleString('zh-CN')} 字</span>
                </header>
                {note.transcript_raw ? (
                  <TranscriptViewer
                    transcript={note.transcript_raw}
                    className="video-knowledge-transcript-viewer"
                  />
                ) : (
                  <p className="video-knowledge-empty-copy">这条内容目前没有可用文案。</p>
                )}
              </section>
            ) : (
              <section className="video-plan-agent">
                <header className="video-plan-agent-header">
                  <span className="video-plan-agent-mark" aria-hidden>
                    <Bot size={20} />
                  </span>
                  <div>
                    <small>{plan ? '调整计划' : '行动计划'}</small>
                    <h2>{plan ? '一句话调整节奏' : 'AI 帮你排好下一步'}</h2>
                    <p>说清周期或每天投入多少时间就可以</p>
                  </div>
                  {plan && (
                    <Link href={`/plans?id=${plan.id}`}>
                      计划工作台
                      <ChevronRight size={14} />
                    </Link>
                  )}
                </header>

                <form onSubmit={(event) => void submitPlanInstruction(event)} className="video-plan-agent-composer">
                  <textarea
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value.slice(0, 500))}
                    maxLength={500}
                    rows={2}
                    placeholder={plan
                      ? '例如：保留已完成内容，剩余任务改成每天 30 分钟'
                      : '例如：从明天开始，做 7 天，每天 30 分钟'}
                    aria-label="输入对计划 Agent 的要求"
                    disabled={agentRunning}
                  />
                  <div>
                    <span>{instruction.length}/500</span>
                    <button type="submit" disabled={!instruction.trim() || agentRunning}>
                      {agentRunning ? (
                        <LoaderCircle size={16} className="animate-spin" />
                      ) : (
                        <WandSparkles size={16} />
                      )}
                      {agentRunning ? '正在规划' : plan ? '更新计划' : '生成计划'}
                    </button>
                  </div>
                </form>

                <div className="video-plan-agent-prompts" aria-label="快捷计划模板">
                  {prompts.map((prompt) => (
                    <button
                      key={prompt.label}
                      type="button"
                      onClick={() => setInstruction(prompt.value)}
                      disabled={agentRunning}
                    >
                      {prompt.label}
                    </button>
                  ))}
                </div>

                {agentNotice && (
                  <div className="video-plan-agent-notice" role="status">
                    <CheckCircle2 size={16} />
                    {agentNotice}
                  </div>
                )}

                {plan ? (
                  <div className="video-plan-preview">
                    <div className="video-plan-summary">
                      <div>
                        <small>当前计划</small>
                        <h3>{plan.title}</h3>
                      </div>
                      {progress && (
                        <span>{progress.pct}%</span>
                      )}
                    </div>
                    {progress && (
                      <div className="video-plan-progress" aria-label={`计划完成 ${progress.pct}%`}>
                        <span style={{ width: `${progress.pct}%` }} />
                      </div>
                    )}
                    {nextPlanTasks.length > 0 ? (
                      <ol className="video-plan-next-tasks">
                        {nextPlanTasks.map((task, index) => (
                          <li key={task.id}>
                            <span>{index + 1}</span>
                            <p>{task.title}</p>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="video-plan-all-done">当前任务都已完成</p>
                    )}
                    <Link href={`/plans?id=${plan.id}`} className="video-plan-open-workspace">
                      查看并打卡
                      <ChevronRight size={15} />
                    </Link>
                  </div>
                ) : (
                  <div className="video-plan-empty">
                    <Clock3 size={22} />
                    <strong>写一句要求就能开始</strong>
                    <p>AI 会结合视频内容，自动安排周期、时间和任务。</p>
                  </div>
                )}
              </section>
            )}
          </div>

          {error && (
            <div className="video-knowledge-inline-error" role="alert">
              <CircleAlert size={15} />
              <span>{error}</span>
              <button type="button" onClick={() => setError('')}>关闭</button>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
}
