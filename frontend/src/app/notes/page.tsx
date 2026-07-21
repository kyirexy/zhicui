'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  MagnifyingGlass,
  Plus,
  Sparkle,
  Stack,
  X,
} from '@phosphor-icons/react';
import { listNotes, getNote } from '@/lib/api';
import { CARD_TYPE_CONFIG, type CardType, type Note, type NoteDetail } from '@/lib/types';
import CardRenderer from '@/components/CardRenderer';
import LibraryNoteCard from '@/components/LibraryNoteCard';
import NotesHero from '@/components/NotesHero';
import { useSettings } from '@/lib/hooks/SettingsContext';

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
    <div className="pb-16 max-w-6xl mx-auto">
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
  const { settings } = useSettings();
  const [notes, setNotes] = useState<Note[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [activeType, setActiveType] = useState<CardType | 'all'>('all');
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

  const filters: { key: CardType | 'all'; label: string }[] = [
    { key: 'all', label: '全部' },
    ...(Object.entries(CARD_TYPE_CONFIG) as [CardType, (typeof CARD_TYPE_CONFIG)[CardType]][])
      .map(([key, meta]) => ({ key, label: meta.label })),
  ];

  return (
    <div className="library-page">
      <header className="library-hero">
        <div className="library-hero__copy">
          <span className="library-hero__mark"><Stack size={22} weight="duotone" aria-hidden /></span>
          <div>
            <p><Sparkle size={13} weight="fill" aria-hidden /> 你的内容资产</p>
            <h1>知识库</h1>
            <span>搜索标题与卡片内容，按类型快速回到需要的信息。</span>
          </div>
        </div>
        <div className="library-hero__count" aria-live="polite">
          <strong>{loading ? '—' : total}</strong>
          <span>{hasFilters ? '条匹配结果' : '张知识卡片'}</span>
        </div>
      </header>

      <section className="library-controls" aria-label="知识库搜索与筛选">
        <label className="library-search">
          <MagnifyingGlass size={19} weight="duotone" aria-hidden />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value.slice(0, 80))}
            placeholder="搜索标题、结论或卡片内容"
            aria-label="搜索知识卡片"
          />
          {searchInput && (
            <button type="button" onClick={() => setSearchInput('')} aria-label="清空搜索">
              <X size={16} weight="bold" aria-hidden />
            </button>
          )}
        </label>

        <div className="library-filters" role="group" aria-label="按卡片类型筛选">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={activeType === filter.key ? 'is-active' : ''}
              onClick={() => chooseType(filter.key)}
              aria-pressed={activeType === filter.key}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </section>

      <div className="library-results-meta">
        <span>{hasFilters ? `正在查看 ${query ? `“${query}”` : '全部关键词'}的筛选结果` : '最近萃取'}</span>
        {hasFilters && <button type="button" onClick={resetFilters}>清除筛选</button>}
      </div>

      {loading ? (
        <div className="library-grid" aria-label="正在加载知识卡片">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className={`library-note-skeleton ${index === 0 ? 'is-featured' : ''}`}>
              <div className="skeleton library-note-skeleton__visual" />
              <div className="library-note-skeleton__copy">
                <div className="skeleton-line w-20 h-3" />
                <div className="skeleton-line w-4/5 h-5" />
                <div className="skeleton-line w-full h-3" />
                <div className="skeleton-line w-2/3 h-3" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="library-empty is-error" role="alert">
          <span><X size={24} weight="duotone" aria-hidden /></span>
          <h2>暂时无法读取知识库</h2>
          <p>{error}</p>
          <button type="button" onClick={() => loadNotes(page)}>重新加载</button>
        </div>
      ) : notes.length === 0 ? (
        <div className="library-empty">
          <span>{hasFilters ? <MagnifyingGlass size={27} weight="duotone" /> : <Stack size={27} weight="duotone" />}</span>
          <h2>{hasFilters ? '没有找到匹配的卡片' : '知识库还没有内容'}</h2>
          <p>
            {hasFilters
              ? '换一个关键词或内容类型，看看其他已经萃取的笔记。'
              : '从一条视频、公众号文章或小红书笔记开始，生成第一张知识卡片。'}
          </p>
          {hasFilters ? (
            <button type="button" onClick={resetFilters}>查看全部卡片</button>
          ) : (
            <Link href="/"><Plus size={16} weight="bold" aria-hidden /> 开始萃取</Link>
          )}
        </div>
      ) : (
        <>
          <div className="library-grid">
            {notes.map((note, index) => (
              <LibraryNoteCard
                key={note.id}
                note={note}
                style={settings.cardStyle}
                featured={index === 0 && page === 1}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <nav className="library-pagination" aria-label="知识库分页">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page === 1}
              >
                <ArrowLeft size={16} weight="bold" aria-hidden />
                上一页
              </button>
              <span><strong>{page}</strong> / {totalPages}</span>
              <button
                type="button"
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
