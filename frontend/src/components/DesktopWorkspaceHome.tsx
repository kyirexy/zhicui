'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpenText,
  CalendarCheck,
  CheckCircle,
  FileText,
  FolderSimple,
  ListChecks,
  Play,
  Sparkle,
  VideoCamera,
  WarningCircle,
  ArrowsClockwise,
} from '@phosphor-icons/react';
import {
  getPlanStats,
  listDouyinLibraryItems,
  listNotes,
  listPlans,
} from '@/lib/api';
import { useAuth } from '@/lib/hooks/AuthContext';
import {
  getPlanProgress,
  type DouyinLibraryItem,
  type Note,
  type PlanData,
  type PlanStats,
} from '@/lib/types';

interface WorkspaceData {
  videos: DouyinLibraryItem[];
  videoTotal: number;
  notes: Note[];
  noteTotal: number;
  plans: PlanData[];
  planStats: PlanStats;
}

const EMPTY_STATS: PlanStats = {
  active_plans: 0,
  open_tasks: 0,
  due_today: 0,
  overdue_tasks: 0,
};

function formatDate(value?: string): string {
  if (!value) return '最近整理';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(date);
}

function WorkspaceSkeleton() {
  return (
    <div className="desktop-workspace-skeleton" aria-label="正在加载工作台">
      <div className="desktop-skeleton-block desktop-skeleton-block--hero" />
      <div className="desktop-skeleton-grid">
        <div className="desktop-skeleton-block" />
        <div className="desktop-skeleton-block" />
      </div>
      <div className="desktop-skeleton-block desktop-skeleton-block--list" />
    </div>
  );
}

export default function DesktopWorkspaceHome() {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadWorkspace = async () => {
    setLoading(true);
    setError('');

    const [videosResult, notesResult, plansResult, statsResult] = await Promise.allSettled([
      listDouyinLibraryItems(6, undefined, 'collection'),
      listNotes(1, 5),
      listPlans(1, 4),
      getPlanStats(),
    ]);

    const videos = videosResult.status === 'fulfilled' && videosResult.value.success
      ? videosResult.value.data
      : null;
    const notes = notesResult.status === 'fulfilled' && notesResult.value.success
      ? notesResult.value.data
      : null;
    const plans = plansResult.status === 'fulfilled' && plansResult.value.success
      ? plansResult.value.data
      : null;
    const stats = statsResult.status === 'fulfilled' && statsResult.value.success
      ? statsResult.value.data
      : null;

    if (!videos && !notes && !plans && !stats) {
      setError('暂时无法读取工作台数据，请检查网络后重试。');
      setLoading(false);
      return;
    }

    const unavailableSections = [videos, notes, plans, stats]
      .filter((section) => !section)
      .length;

    setData({
      videos: videos?.items ?? [],
      videoTotal: videos?.total ?? 0,
      notes: notes?.items ?? [],
      noteTotal: notes?.total ?? 0,
      plans: plans?.items ?? [],
      planStats: stats ?? EMPTY_STATS,
    });
    setError(
      unavailableSections > 0
        ? '部分数据暂时没有更新，其他工作区仍可正常使用。'
        : '',
    );
    setLoading(false);
  };

  useEffect(() => {
    if (authLoading || !user) return;
    void loadWorkspace();
  }, [authLoading, user?.id]);

  const todayLabel = useMemo(() => (
    new Intl.DateTimeFormat('zh-CN', {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date())
  ), []);
  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 11) return '早上好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }, []);

  if ((authLoading || loading) && !data) return <WorkspaceSkeleton />;

  if (error && !data) {
    return (
      <section className="desktop-workspace-error" role="alert">
        <WarningCircle size={30} weight="light" aria-hidden="true" />
        <h1>工作台暂时没有加载出来</h1>
        <p>{error}</p>
        <button type="button" onClick={() => void loadWorkspace()}>
          <ArrowsClockwise size={18} weight="light" aria-hidden="true" />
          重新加载
        </button>
      </section>
    );
  }

  const workspace = data ?? {
    videos: [],
    videoTotal: 0,
    notes: [],
    noteTotal: 0,
    plans: [],
    planStats: EMPTY_STATS,
  };

  return (
    <div className="desktop-workspace">
      {error && (
        <div className="desktop-workspace__partial-warning" role="status">
          <WarningCircle size={17} weight="light" aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => void loadWorkspace()}>
            重新读取
          </button>
        </div>
      )}
      <header className="desktop-workspace__welcome">
        <div>
          <p className="desktop-workspace__date">{todayLabel}</p>
          <h1>
            {greeting}{user?.username ? `，${user.username}` : ''}
          </h1>
          <p className="desktop-workspace__lead">
            今天把一条收藏变成真正能用的知识，或者继续昨天没做完的计划。
          </p>
        </div>
        <div className="desktop-workspace__primary-actions">
          <Link href="/library" className="desktop-button desktop-button--primary">
            <VideoCamera size={19} weight="light" aria-hidden="true" />
            同步视频
          </Link>
          <Link href="/plans" className="desktop-button desktop-button--secondary">
            <CalendarCheck size={19} weight="light" aria-hidden="true" />
            今日计划
          </Link>
        </div>
      </header>

      <section className="desktop-workspace__activity-strip" aria-label="工作空间概览">
        <div className="desktop-workspace__activity-title">
          <span>工作概览</span>
          <small>最近一次云端数据</small>
        </div>
        <article>
          <div>
            <strong className="tabular-nums">{workspace.videoTotal}</strong>
            <span>库内视频</span>
          </div>
        </article>
        <article>
          <div>
            <strong className="tabular-nums">{workspace.noteTotal}</strong>
            <span>知识卡片</span>
          </div>
        </article>
        <article>
          <div>
            <strong className="tabular-nums">{workspace.planStats.due_today}</strong>
            <span>今日任务</span>
          </div>
        </article>
        <article>
          <div>
            <strong className="tabular-nums">{workspace.planStats.open_tasks}</strong>
            <span>待办事项</span>
          </div>
        </article>
      </section>

      <div className="desktop-workspace__main-grid">
        <section className="desktop-library-board">
          <header className="desktop-board-heading">
            <div>
              <h2>继续整理</h2>
              <p>最近收藏的视频</p>
            </div>
            <Link href="/library">
              查看全部
              <ArrowRight size={16} weight="light" aria-hidden="true" />
            </Link>
          </header>

          {workspace.videos.length > 0 ? (
            <div className="desktop-video-feed">
              <Link
                key={workspace.videos[0].aweme_id}
                href={`/library/detail?id=${encodeURIComponent(workspace.videos[0].aweme_id)}`}
                className="desktop-video-feature"
              >
                <span className="desktop-video-feature__cover">
                  {workspace.videos[0].cover_url ? (
                    <img src={workspace.videos[0].cover_url} alt="" />
                  ) : (
                    <span className="desktop-video-feature__fallback" aria-hidden="true">
                      <Play size={34} weight="fill" />
                    </span>
                  )}
                  <span className="desktop-video-feature__play" aria-hidden="true">
                    <Play size={18} weight="fill" />
                  </span>
                </span>
                <span className="desktop-video-feature__copy">
                  <span className="desktop-video-feature__label">最近收藏</span>
                  <strong>{workspace.videos[0].title || '未命名视频'}</strong>
                  <span>
                    {workspace.videos[0].author_name || '未知作者'}
                    <i aria-hidden="true">·</i>
                    {workspace.videos[0].extracted
                      ? `${workspace.videos[0].transcript_chars || 0} 字文案`
                      : '文案提取中'}
                  </span>
                  <b>
                    打开并提问
                    <ArrowUpRight size={15} weight="light" aria-hidden="true" />
                  </b>
                </span>
              </Link>

              <div className="desktop-video-queue">
                {workspace.videos.slice(1).map((video) => (
                <Link
                  key={video.aweme_id}
                  href={`/library/detail?id=${encodeURIComponent(video.aweme_id)}`}
                  className="desktop-video-queue__item"
                >
                  <span className="desktop-video-queue__cover">
                    {video.cover_url ? (
                      <img src={video.cover_url} alt="" loading="lazy" />
                    ) : (
                      <span className="desktop-video-queue__fallback" aria-hidden="true">
                        <Play size={18} weight="fill" />
                      </span>
                    )}
                  </span>
                  <span className="desktop-video-queue__copy">
                    <strong>{video.title || '未命名视频'}</strong>
                    <span>
                      {video.author_name || '未知作者'}
                      <i aria-hidden="true">·</i>
                      {video.extracted
                        ? '文案已就绪'
                        : '文案提取中'}
                    </span>
                  </span>
                  <ArrowUpRight size={16} weight="light" aria-hidden="true" />
                </Link>
              ))}
              </div>
            </div>
          ) : (
            <div className="desktop-library-empty">
              <span><FolderSimple size={32} weight="light" aria-hidden="true" /></span>
              <div>
                <h3>这里会出现最近收藏的视频</h3>
                <p>连接抖音后，选择收藏、喜欢或自己的作品。每提取好一条文案，就会立即显示。</p>
              </div>
              <Link href="/library">
                添加第一批视频
                <ArrowRight size={16} weight="light" aria-hidden="true" />
              </Link>
            </div>
          )}
        </section>

        <section className="desktop-focus-board">
          <header className="desktop-board-heading">
            <div>
              <h2>今天要做</h2>
              <p>{workspace.planStats.open_tasks} 项待办，{workspace.planStats.due_today} 项今天到期</p>
            </div>
            <Link href="/plans">
              计划中心
              <ArrowRight size={16} weight="light" aria-hidden="true" />
            </Link>
          </header>

          {workspace.plans.length > 0 ? (
            <div className="desktop-focus-list">
              {workspace.plans.slice(0, 4).map((plan) => {
                const progress = getPlanProgress(plan);
                return (
                  <Link
                    href={`/plans?id=${encodeURIComponent(plan.id)}`}
                    key={plan.id}
                    className="desktop-focus-item"
                  >
                    <span className="desktop-focus-item__status" aria-hidden="true">
                      {plan.status === 'done'
                        ? <CheckCircle size={22} weight="fill" />
                        : <ListChecks size={22} weight="light" />}
                    </span>
                    <span className="desktop-focus-item__copy">
                      <strong>{plan.title}</strong>
                      <span>{progress.done}/{progress.total} 项已完成</span>
                    </span>
                    <span className="desktop-focus-item__progress" aria-label={`完成 ${progress.pct}%`}>
                      <i style={{ width: `${progress.pct}%` }} />
                    </span>
                    <b className="tabular-nums">{progress.pct}%</b>
                  </Link>
                );
              })}
            </div>
          ) : (
            <div className="desktop-focus-empty">
              <span><Sparkle size={28} weight="light" aria-hidden="true" /></span>
              <h3>还没有正在执行的计划</h3>
              <p>打开一条视频，告诉 AI 你的目标，它会帮你拆成可打卡的步骤。</p>
              <Link href="/library">从视频开始</Link>
            </div>
          )}

          <footer className="desktop-focus-summary">
            <span>
              <strong className="tabular-nums">{workspace.planStats.active_plans}</strong>
              个进行中计划
            </span>
            <span>
              <strong className="tabular-nums">{workspace.planStats.overdue_tasks}</strong>
              项已逾期
            </span>
          </footer>
        </section>
      </div>

      <section className="desktop-knowledge-board">
        <header className="desktop-board-heading">
          <div>
            <h2>最近整理的知识</h2>
            <p>从完整文案中沉淀下来的卡片</p>
          </div>
          <Link href="/notes">
            进入知识库
            <ArrowRight size={16} weight="light" aria-hidden="true" />
          </Link>
        </header>

        {workspace.notes.length > 0 ? (
          <div className="desktop-knowledge-list">
            {workspace.notes.slice(0, 5).map((note) => (
              <Link
                href={`/notes?id=${encodeURIComponent(note.id)}`}
                key={note.id}
                className="desktop-knowledge-row"
              >
                <span className="desktop-knowledge-row__icon" aria-hidden="true">
                  <BookOpenText size={20} weight="light" />
                </span>
                <span className="desktop-knowledge-row__copy">
                  <strong>{note.title}</strong>
                  <span>{note.excerpt || note.conclusion || '打开查看这张知识卡片'}</span>
                </span>
                <time>{formatDate(note.created_at)}</time>
                <ArrowUpRight size={16} weight="light" aria-hidden="true" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="desktop-knowledge-empty">
            <span><FileText size={24} weight="light" aria-hidden="true" /></span>
            <div>
              <h3>知识库还是空的</h3>
              <p>完整文案准备好后，再按需要生成知识卡片。</p>
            </div>
            <Link href="/library">浏览视频</Link>
          </div>
        )}
      </section>
    </div>
  );
}
