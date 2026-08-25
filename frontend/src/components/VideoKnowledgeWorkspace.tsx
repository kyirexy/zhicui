'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpenText,
  CalendarCheck2,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import ContentChat from '@/components/ContentChat';
import DesktopMediaVideoPlayer from '@/components/DesktopMediaVideoPlayer';
import { buildBilibiliEmbedUrl } from '@/lib/singleLinkImport';
import DouyinGalleryViewer from '@/components/DouyinGalleryViewer';
import TranscriptViewer from '@/components/TranscriptViewer';
import VideoAnalysisEntry from '@/components/VideoAnalysisEntry';
import VideoAgentWorkspace from '@/components/agent/VideoAgentWorkspace';
import {
  extractDouyinLibraryItem,
  getDouyinLibraryItem,
  getPlatformLibraryItem,
  initializePlatformLibraryItem,
  runNotePlanAgent,
} from '@/lib/api';
import {
  getPlanProgress,
  type DouyinLibraryItem,
  type DouyinVideoWorkspace,
} from '@/lib/types';

type WorkspaceTab = 'assistant' | 'transcript' | 'summary' | 'plan';

const TABS: Array<{
  id: WorkspaceTab;
  label: string;
  Icon: typeof Sparkles;
}> = [
  { id: 'assistant', label: 'AI 问答', Icon: Sparkles },
  { id: 'transcript', label: '完整文案', Icon: FileText },
  { id: 'summary', label: '摘要笔记', Icon: BookOpenText },
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

function formatSourceIdentity(item: DouyinLibraryItem): string {
  if (item.platform === 'bilibili') return 'B站 · 导入资料';
  if (item.platform === 'xiaohongshu') return '小红书 · 导入资料';
  const source = item.source_mode === 'collect'
    ? '收藏'
    : item.source_mode === 'like'
      ? '喜欢'
      : item.source_mode === 'post'
        ? '我的作品'
        : '导入资料';
  return `抖音 · ${source}`;
}

export default function VideoKnowledgeWorkspace() {
  const searchParams = useSearchParams();
  const awemeId = searchParams.get('id')?.trim() || '';
  const importedNoteId = searchParams.get('note')?.trim() || '';
  const routeAgentThreadId = searchParams.get('agent_thread')?.trim() || null;
  const agentThreadUrlRef = useRef<string | null>(routeAgentThreadId);
  const workspaceRequestRef = useRef(0);
  const [agentBootstrap, setAgentBootstrap] = useState({
    threadId: routeAgentThreadId,
    revision: 0,
  });
  const [workspace, setWorkspace] = useState<DouyinVideoWorkspace | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('assistant');
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [initializingAi, setInitializingAi] = useState(false);
  const [agentRunning, setAgentRunning] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [agentNotice, setAgentNotice] = useState('');
  const [error, setError] = useState('');

  const syncAgentThreadToUrl = useCallback((threadId: string | null) => {
    agentThreadUrlRef.current = threadId;
    setAgentBootstrap((current) => (
      current.threadId === threadId
        ? current
        : { ...current, threadId }
    ));
    const url = new URL(window.location.href);
    if (threadId) {
      url.searchParams.set('agent_thread', threadId);
    } else {
      url.searchParams.delete('agent_thread');
    }
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  useEffect(() => {
    if (routeAgentThreadId === agentThreadUrlRef.current) return;
    agentThreadUrlRef.current = routeAgentThreadId;
    setAgentBootstrap((current) => ({
      threadId: routeAgentThreadId,
      revision: current.revision + 1,
    }));
  }, [routeAgentThreadId]);

  const loadWorkspace = useCallback(async (refreshMedia = false) => {
    const requestId = workspaceRequestRef.current + 1;
    workspaceRequestRef.current = requestId;
    if (!awemeId && !importedNoteId) {
      if (requestId !== workspaceRequestRef.current) return;
      setError('缺少视频标识，请从视频资料重新打开。');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    const response = importedNoteId
      ? await getPlatformLibraryItem(importedNoteId, refreshMedia)
      : await getDouyinLibraryItem(awemeId);
    if (requestId !== workspaceRequestRef.current) return;
    if (response.success && response.data) {
      setWorkspace(response.data);
    } else {
      setWorkspace(null);
      setError(response.error || '这个视频暂时无法打开');
    }
    setLoading(false);
  }, [awemeId, importedNoteId]);

  useEffect(() => {
    window.scrollTo(0, 0);
    void loadWorkspace();
    return () => {
      workspaceRequestRef.current += 1;
    };
  }, [loadWorkspace]);

  const note = workspace?.note ?? null;
  const plan = workspace?.plan ?? null;
  const hasTranscript = Boolean(note?.transcript_raw?.trim());
  const bilibiliEmbedUrl = workspace?.item.platform === 'bilibili'
    ? buildBilibiliEmbedUrl(workspace.item.aweme_id)
    : null;
  const visualSource = workspace && (
    workspace.item.media_type === 'gallery'
      ? (workspace.item.gallery_images?.length || 0) > 0
      : Boolean(workspace.item.media_url)
  ) ? {
    itemId: workspace.item.aweme_id,
    mediaType: workspace.item.media_type === 'gallery' ? 'gallery' as const : 'video' as const,
    imageCount: workspace.item.media_type === 'gallery'
      ? workspace.item.gallery_images?.length || 0
      : undefined,
  } : null;
  const summaryGenerationFailed = Boolean(
    note && (
      note.generation_status === 'fallback'
      || note.key_insight?.includes('AI 暂时无法生成结构化卡片')
      || note.conclusion?.includes('AI 处理暂时不可用')
    ),
  );
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
    if (!workspace || extracting || importedNoteId) return;
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
    if (
      !workspace
      || !note
      || (note.ai_initialized && !summaryGenerationFailed)
      || initializingAi
    ) return;
    setInitializingAi(true);
    setError('');
    const response = importedNoteId
      ? await initializePlatformLibraryItem(importedNoteId)
      : await extractDouyinLibraryItem(workspace.item.aweme_id, 'ai');
    setInitializingAi(false);
    if (!response.success) {
      setError(response.error || '摘要笔记生成失败，请稍后重试');
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
      setError(response.error || '暂时无法完成计划调整');
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
        <strong>正在打开视频资料</strong>
      </div>
    );
  }

  if (error && !workspace) {
    return (
      <section className="video-knowledge-failure">
        <CircleAlert size={30} />
        <h1>无法打开这个视频</h1>
        <p>{error}</p>
        <div>
          <Link href="/library">
            <ArrowLeft size={16} />
            返回视频资料
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
  const isGallery = item.media_type === 'gallery' || item.media_type === 'image';
  const emptyTab = activeTab === 'transcript'
    ? { title: '暂无完整文案', copy: isGallery ? '图文作品可直接使用图片问答。' : '提取后即可查看和搜索文案。', Icon: FileText }
    : activeTab === 'summary'
      ? { title: '暂无摘要笔记', copy: isGallery ? '先从图片问答开始。' : '生成文案后可整理摘要。', Icon: BookOpenText }
      : activeTab === 'plan'
        ? { title: '暂无行动计划', copy: isGallery ? '先从图片问答开始。' : '生成文案后可创建计划。', Icon: CalendarCheck2 }
        : { title: '暂无可用内容', copy: '请返回视频资料重新同步。', Icon: Sparkles };
  const EmptyTabIcon = emptyTab.Icon;
  const emptyTabContent = (
    <section className="video-knowledge-empty-tab">
      <span aria-hidden><EmptyTabIcon size={22} /></span>
      <h2>{emptyTab.title}</h2>
      <p>{emptyTab.copy}</p>
      {isGallery ? (
        <button type="button" onClick={() => setActiveTab('assistant')}>
          返回图片问答
        </button>
      ) : item.can_extract ? (
        <button
          type="button"
          onClick={() => void prepareVideo()}
          disabled={extracting}
        >
          {extracting && <LoaderCircle size={16} className="animate-spin" />}
          {extracting ? '正在提取' : '提取完整文案'}
        </button>
      ) : (
        <Link href="/library">返回视频资料</Link>
      )}
    </section>
  );

  return (
    <div className="video-knowledge-page">
      <header className="video-knowledge-topbar">
        <Link href="/library" className="video-knowledge-back">
          <ArrowLeft size={16} />
          视频资料
        </Link>
      </header>

      <section className="video-knowledge-shell">
        <div className="video-knowledge-media">
          <div className={`video-knowledge-stage ${bilibiliEmbedUrl ? 'is-bilibili' : ''}`}>
            {bilibiliEmbedUrl ? (
              <iframe
                className="video-knowledge-bilibili-player"
                src={bilibiliEmbedUrl}
                title={`播放视频：${item.title}`}
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
              />
            ) : item.media_type === 'gallery' ? (
              <DouyinGalleryViewer
                images={item.gallery_images || []}
                fallbackImage={item.cover_proxy_url || item.cover_url}
                title={item.title}
              />
            ) : item.media_url ? (
              <DesktopMediaVideoPlayer
                key={item.media_url}
                awemeId={item.aweme_id}
                mediaUrl={item.media_url}
                coverUrl={item.cover_proxy_url || item.cover_url}
                title={item.title}
                sourceUrl={item.source_url}
                onRefreshMedia={() => loadWorkspace(true)}
              />
            ) : item.cover_proxy_url || item.cover_url ? (
              <div className="video-knowledge-no-media">
                <img
                  src={item.cover_proxy_url || item.cover_url}
                  alt={`${item.title} 视频封面`}
                  referrerPolicy="no-referrer"
                />
                <span><CircleAlert size={16} />这个作品的媒体暂时无法读取</span>
              </div>
            ) : (
              <div className="video-knowledge-no-media">
                <Play size={44} />
                <span>这个作品的媒体暂时无法读取</span>
              </div>
            )}
            <span className="video-knowledge-source-pill">
              {formatSourceIdentity(item)}
            </span>
          </div>

          <div className="video-knowledge-title">
            <h1>{item.title}</h1>
            {item.caption && item.caption !== item.title && (
              <p>{item.caption}</p>
            )}
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

          <div className="video-knowledge-facts">
            <span>
              <FileText size={14} />
              {note
                ? `${(note.transcript_raw?.length || 0).toLocaleString('zh-CN')} 字完整文案`
                : item.media_type === 'gallery'
                  ? `${item.gallery_images?.length || 0} 张图片`
                : '等待生成完整文案'}
            </span>
            {note?.ai_initialized && !summaryGenerationFailed ? (
              <span>
                <Sparkles size={14} />
                摘要笔记已就绪
              </span>
            ) : note ? (
              <span>
                <Sparkles size={14} />
                文案已就绪
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
                {initializingAi ? '整理中' : '生成摘要笔记'}
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
            {note && hasTranscript && (
              <section
                className="video-knowledge-assistant video-knowledge-assistant--harness"
                hidden={activeTab !== 'assistant'}
                inert={activeTab !== 'assistant'}
                aria-label={`基于《${note.title}》的知萃 AI 对话`}
              >
                <VideoAgentWorkspace
                  key={`${note.id}:${agentBootstrap.revision}`}
                  active={activeTab === 'assistant'}
                  embedded
                  initialSourceIds={[note.id]}
                  initialThreadId={agentBootstrap.threadId}
                  onThreadChange={syncAgentThreadToUrl}
                />
              </section>
            )}

            {activeTab === 'assistant' ? (
              note && hasTranscript ? null : visualSource ? (
                <section className="video-knowledge-assistant">
                  <header>
                    <div>
                      <strong>
                        {visualSource.mediaType === 'gallery'
                          ? `${visualSource.imageCount} 张图片`
                          : '视频画面'}
                      </strong>
                    </div>
                  </header>
                  <ContentChat
                    title={item.title}
                    visualSource={visualSource}
                  />
                </section>
              ) : emptyTabContent
            ) : !note ? emptyTabContent : activeTab === 'transcript' ? (
              <section className="video-knowledge-transcript">
                <header>
                  <h2>完整文案</h2>
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
            ) : activeTab === 'summary' ? (
              <section className="video-knowledge-summary">
                <header>
                  <h2>摘要笔记</h2>
                  {note.ai_initialized && !summaryGenerationFailed && (
                    <Link href={`/notes?id=${encodeURIComponent(note.id)}`}>
                      打开笔记
                      <ArrowUpRight size={14} />
                    </Link>
                  )}
                </header>

                {note.ai_initialized && !summaryGenerationFailed ? (
                  <article>
                    {(note.key_insight || note.conclusion) && (
                      <div className="video-knowledge-summary-lead">
                        <p>{note.key_insight || note.conclusion}</p>
                      </div>
                    )}
                    {note.sections?.map((section, index) => (
                      <section key={`${section.title}-${index}`}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <div>
                          <h3>{section.title}</h3>
                          <p>{section.content}</p>
                        </div>
                      </section>
                    ))}
                    {note.conclusion && note.conclusion !== note.key_insight && (
                      <footer>
                        <small>结论</small>
                        <p>{note.conclusion}</p>
                      </footer>
                    )}
                  </article>
                ) : summaryGenerationFailed ? (
                  <div className="video-knowledge-summary-failure" role="status">
                    <span aria-hidden="true"><RotateCcw size={20} /></span>
                    <div>
                      <h3>摘要生成失败</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => void initializeAi()}
                      disabled={initializingAi}
                    >
                      {initializingAi
                        ? <LoaderCircle size={16} className="animate-spin" />
                        : <RotateCcw size={16} />}
                      {initializingAi ? '正在重新整理' : '重新生成摘要'}
                    </button>
                  </div>
                ) : (
                  <div className="video-knowledge-summary-empty">
                    <BookOpenText size={28} />
                    <h3>还没有摘要</h3>
                    <button
                      type="button"
                      onClick={() => void initializeAi()}
                      disabled={initializingAi}
                    >
                      {initializingAi
                        ? <LoaderCircle size={16} className="animate-spin" />
                        : <Sparkles size={16} />}
                      {initializingAi ? '正在整理' : '生成摘要笔记'}
                    </button>
                  </div>
                )}

                {item.media_type !== 'gallery'
                  && item.media_type !== 'image'
                  && (
                    <VideoAnalysisEntry
                      noteId={note.id}
                      hasSummary={note.ai_initialized && !summaryGenerationFailed}
                      existing={note.detailed_video_analysis}
                      onCompleted={loadWorkspace}
                    />
                  )}
              </section>
            ) : (
              <section className="video-plan-agent">
                <header className="video-plan-agent-header">
                  <h2>{plan ? '调整计划' : '创建行动计划'}</h2>
                  {plan && (
                    <Link href={`/plans?id=${plan.id}`}>
                      打开行动计划
                      <ChevronRight size={14} />
                    </Link>
                  )}
                </header>

                <form onSubmit={(event) => void submitPlanInstruction(event)} className="video-plan-agent-composer">
                  <label htmlFor="video-plan-instruction">
                    <span>{plan ? '你想怎么调整？' : '你想怎么执行？'}</span>
                  </label>
                  <textarea
                    id="video-plan-instruction"
                    value={instruction}
                    onChange={(event) => setInstruction(event.target.value.slice(0, 500))}
                    maxLength={500}
                    rows={2}
                    placeholder={plan
                      ? '例如：保留已完成内容，剩余任务改成每天 30 分钟'
                      : '例如：从明天开始，做 7 天，每天 30 分钟'}
                    aria-label="输入计划调整要求"
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
                ) : null}
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
