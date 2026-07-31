'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  ListBullets,
  MagnifyingGlass,
  Plus,
  Robot,
  SquaresFour,
  Stack,
  X,
} from '@phosphor-icons/react';
import { listNotes, getNote } from '@/lib/api';
import { CARD_TYPE_CONFIG, type CardType, type Note, type NoteDetail } from '@/lib/types';
import CardRenderer from '@/components/CardRenderer';
import LibraryNoteCard, { type KnowledgeViewMode } from '@/components/LibraryNoteCard';
import NotesHero from '@/components/NotesHero';

const KNOWLEDGE_VIEW_STORAGE_KEY = 'zhicui_knowledge_view';

function NotesContent() {
  const searchParams = useSearchParams();
  const noteId = searchParams.get('id');

  if (noteId) {
    return <NoteDetailView id={noteId} />;
  }
  return <NotesList />;
}

function NoteDetailView({ id }: { id: string }) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const res = await getNote(id);
      if (res.success && res.data) {
        setNote(res.data);
      } else {
        setError(res.error || '加载失败');
      }
      setLoading(false);
    };
    load();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center">
        <div className="w-full max-w-2xl space-y-4">
          <div className="skeleton h-32" />
          <div className="skeleton h-48" />
          <div className="skeleton h-24" />
        </div>
      </div>
    );
  }

  if (error || !note) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
        <p className="text-4xl mb-4">😕</p>
        <p className="text-foreground-secondary mb-4">{error || '笔记不存在'}</p>
        <Link href="/notes" className="text-accent-emerald hover:underline text-sm">
          ← 返回知识库
        </Link>
      </div>
    );
  }

  const cardData = {
    id: note.id,
    title: note.title,
    video_title: note.video_title || note.title,
    sections: note.sections || [],
    conclusion: note.conclusion || '',
    pitfall_rating: note.pitfall_rating,
    card_type: note.card_type || 'general',
    source_url: note.source_url,
    created_at: note.created_at,
    seo_meta: note.seo_meta,
    transcript_raw: note.transcript_raw,
    video_id: note.video_id,
    tone: note.tone,
    density: note.density,
    hero_quote: note.hero_quote,
    key_insight: note.key_insight,
    stats: note.stats,
  };

  return (
    <div className="knowledge-workspace-detail desktop-core-page desktop-notes-detail pb-16 max-w-6xl mx-auto">
      {/* Back link — subtle, top-left, outside the hero */}
      <Link
        href="/notes"
        className="inline-flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground transition-colors px-2 py-2 mb-4 rounded-lg hover:bg-white/5 min-h-[44px]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        返回知识库
      </Link>

      {/* Hero cover card */}
      <NotesHero note={note} transcriptRef={transcriptRef} />

      {/* Complete content, AI card and grounded assistant share one workspace. */}
      <div ref={transcriptRef} className="space-y-6">
        <CardRenderer cardData={cardData} showExport noteId={note.id} showToolbar />
      </div>
    </div>
  );
}

function NotesList() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<CardType | 'all'>('all');
  const [viewMode, setViewMode] = useState<KnowledgeViewMode>('list');
  const requestIdRef = useRef(0);

  const loadNotes = useCallback(async (p: number) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError('');
    const res = await listNotes(
      p,
      12,
      query || undefined,
      activeType === 'all' ? undefined : activeType,
    );
    if (requestId !== requestIdRef.current) return;
    if (res.success && res.data) {
      setNotes(res.data.items || []);
      setTotalPages(res.data.total_pages || 1);
      setTotal(res.data.total || 0);
    } else {
      setNotes([]);
      setTotal(0);
      setError(res.error || '知识库加载失败，请稍后重试');
    }
    setLoading(false);
  }, [activeType, query]);

  useEffect(() => {
    loadNotes(page);
  }, [page, loadNotes]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(searchInput.trim());
    }, 320);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const savedView = window.sessionStorage.getItem(KNOWLEDGE_VIEW_STORAGE_KEY);
    if (savedView === 'list' || savedView === 'grid') {
      setViewMode(savedView);
    }
  }, []);

  const hasFilters = Boolean(query || activeType !== 'all');
  const resetFilters = () => {
    setSearchInput('');
    setQuery('');
    setActiveType('all');
    setPage(1);
  };

  const chooseType = (type: CardType | 'all') => {
    setActiveType(type);
    setPage(1);
  };

  const chooseView = (mode: KnowledgeViewMode) => {
    setViewMode(mode);
    window.sessionStorage.setItem(KNOWLEDGE_VIEW_STORAGE_KEY, mode);
  };

  const filters: { key: CardType | 'all'; label: string }[] = [
    { key: 'all', label: '全部' },
    ...(Object.entries(CARD_TYPE_CONFIG) as [CardType, (typeof CARD_TYPE_CONFIG)[CardType]][])
      .map(([key, meta]) => ({ key, label: meta.label })),
  ];
  const activeFilterLabel = filters.find((filter) => filter.key === activeType)?.label || '全部';

  return (
    <div className="knowledge-workspace-page desktop-core-page desktop-notes-page">
      <header className="knowledge-workspace-header">
        <div className="knowledge-workspace-header__identity">
          <span className="knowledge-workspace-header__mark" aria-hidden="true">
            <Stack size={22} weight="duotone" />
          </span>
          <div>
            <div className="knowledge-workspace-header__title-row">
              <h1>知识库</h1>
              <span className="knowledge-workspace-header__count" aria-live="polite">
                {loading ? '正在读取' : `${total.toLocaleString('zh-CN')} 条`}
              </span>
            </div>
            <p>查找已经提炼的内容，打开卡片、原文案或继续向资料提问。</p>
          </div>
        </div>
        <Link
          href="/agent"
          className="knowledge-workspace-agent-link knowledge-workspace-touch-target min-h-[44px]"
        >
          <Robot size={19} weight="duotone" aria-hidden="true" />
          向资料提问
          <ArrowRight size={16} weight="bold" aria-hidden="true" />
        </Link>
      </header>

      <section className="knowledge-workspace-toolbar" aria-label="知识库工具">
        <label className="knowledge-workspace-search">
          <MagnifyingGlass size={19} weight="duotone" aria-hidden />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value.slice(0, 80))}
            placeholder="搜索标题、摘要或知识卡内容"
            aria-label="搜索知识卡片"
          />
          {searchInput && (
            <button
              type="button"
              className="knowledge-workspace-touch-target min-h-[44px] min-w-[44px]"
              onClick={() => setSearchInput('')}
              aria-label="清空搜索"
            >
              <X size={16} weight="bold" aria-hidden />
            </button>
          )}
        </label>

        <div
          className="knowledge-workspace-view-switch"
          role="group"
          aria-label="知识库展示方式"
        >
          <button
            type="button"
            className={`knowledge-workspace-touch-target min-h-[44px] ${viewMode === 'list' ? 'is-active' : ''}`}
            onClick={() => chooseView('list')}
            aria-pressed={viewMode === 'list'}
          >
            <ListBullets size={18} weight="duotone" aria-hidden="true" />
            列表
          </button>
          <button
            type="button"
            className={`knowledge-workspace-touch-target min-h-[44px] ${viewMode === 'grid' ? 'is-active' : ''}`}
            onClick={() => chooseView('grid')}
            aria-pressed={viewMode === 'grid'}
          >
            <SquaresFour size={18} weight="duotone" aria-hidden="true" />
            卡片
          </button>
        </div>
      </section>

      <nav
        className="knowledge-workspace-filter-strip"
        aria-label="按知识类型筛选"
      >
        <div className="knowledge-workspace-filter-scroll">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`knowledge-workspace-filter knowledge-workspace-touch-target min-h-[44px] ${
                activeType === filter.key ? 'is-active' : ''
              }`}
              onClick={() => chooseType(filter.key)}
              aria-pressed={activeType === filter.key}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </nav>

      <div className="knowledge-workspace-results-meta" aria-live="polite">
        <span>
          {hasFilters
            ? `${activeFilterLabel}${query ? ` · “${query}”` : ''}，${loading ? '正在搜索' : `${total} 条结果`}`
            : '最近整理'}
        </span>
        {hasFilters && (
          <button
            type="button"
            className="knowledge-workspace-clear-filter knowledge-workspace-touch-target min-h-[44px]"
            onClick={resetFilters}
          >
            清除筛选
          </button>
        )}
      </div>

      {loading ? (
        <div
          className={`knowledge-workspace-results knowledge-workspace-results--${viewMode}`}
          aria-label="正在加载知识卡片"
          aria-busy="true"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="knowledge-workspace-skeleton">
              <div className="skeleton knowledge-workspace-skeleton__cover" />
              <div className="knowledge-workspace-skeleton__body">
                <div className="skeleton-line w-20 h-3" />
                <div className="skeleton-line w-4/5 h-5" />
                <div className="skeleton-line w-full h-3" />
                <div className="skeleton-line w-2/3 h-3" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <section className="knowledge-workspace-state knowledge-workspace-state--error" role="alert">
          <span className="knowledge-workspace-state__mark"><X size={24} weight="duotone" aria-hidden /></span>
          <h2>暂时无法读取知识库</h2>
          <p>{error}</p>
          <button
            type="button"
            className="knowledge-workspace-touch-target min-h-[44px]"
            onClick={() => loadNotes(page)}
          >
            重新加载
          </button>
        </section>
      ) : notes.length === 0 ? (
        <section className="knowledge-workspace-state knowledge-workspace-state--empty">
          <span className="knowledge-workspace-state__mark">
            {hasFilters
              ? <MagnifyingGlass size={27} weight="duotone" aria-hidden="true" />
              : <Stack size={27} weight="duotone" aria-hidden="true" />}
          </span>
          <h2>{hasFilters ? '没有找到匹配的卡片' : '知识库还没有内容'}</h2>
          <p>
            {hasFilters
              ? '换一个关键词或内容类型，看看其他已经萃取的笔记。'
              : '先从视频库选择资料并生成知识卡片，这里会按最近整理顺序展示。'}
          </p>
          {hasFilters ? (
            <button
              type="button"
              className="knowledge-workspace-touch-target min-h-[44px]"
              onClick={resetFilters}
            >
              查看全部卡片
            </button>
          ) : (
            <Link
              href="/library"
              className="knowledge-workspace-touch-target min-h-[44px]"
            >
              <Plus size={16} weight="bold" aria-hidden />
              去视频库整理资料
            </Link>
          )}
        </section>
      ) : (
        <>
          <section
            className={`knowledge-workspace-results knowledge-workspace-results--${viewMode}`}
            data-view={viewMode}
            aria-label={`${activeFilterLabel}知识卡片`}
          >
            {notes.map((note) => (
              <LibraryNoteCard
                key={note.id}
                note={note}
                viewMode={viewMode}
              />
            ))}
          </section>

          {totalPages > 1 && (
            <nav className="knowledge-workspace-pagination" aria-label="知识库分页">
              <button
                type="button"
                className="knowledge-workspace-touch-target min-h-[44px]"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
              >
                <ArrowLeft size={16} weight="bold" aria-hidden />
                上一页
              </button>
              <span><strong>{page}</strong> / {totalPages}</span>
              <button
                type="button"
                className="knowledge-workspace-touch-target min-h-[44px]"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page === totalPages}
              >
                下一页
                <ArrowRight size={16} weight="bold" aria-hidden />
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[60vh] flex flex-col items-center justify-center">
        <div className="w-full max-w-2xl space-y-4">
          <div className="skeleton h-32" />
          <div className="skeleton h-48" />
          <div className="skeleton h-24" />
        </div>
      </div>
    }>
      <NotesContent />
    </Suspense>
  );
}
