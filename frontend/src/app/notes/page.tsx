'use client';

import { useState, useEffect, useCallback, Suspense, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { listNotes, getNote } from '@/lib/api';
import type { Note, NoteDetail } from '@/lib/types';
import CardRenderer from '@/components/CardRenderer';
import ExportButton from '@/components/ExportButton';

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
  const cardRef = useRef<HTMLDivElement>(null);

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
    transcript_raw: note.transcript_raw,
    video_id: note.video_id,
  };

  return (
    <div className="pb-16 max-w-2xl mx-auto">
      <div className="mb-6 flex items-center justify-between gap-3 flex-wrap">
        <Link
          href="/notes"
          className="text-foreground-secondary hover:text-foreground transition-colors text-sm flex items-center gap-1.5 px-3 py-2.5 rounded-lg hover:bg-white/5 min-h-[44px] min-w-[44px]"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          返回知识库
        </Link>
        <div className="flex items-center gap-2">
          {note.card_type === 'plan' && note.plan_id && (
            <Link
              href={`/plans?id=${note.plan_id}`}
              className="inline-flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-xs font-medium
                bg-accent-indigo/10 border border-accent-indigo/20 text-accent-indigo
                hover:bg-accent-indigo/15 transition-colors min-h-[44px]"
            >
              📋 查看计划
            </Link>
          )}
          <ExportButton targetRef={cardRef} />
        </div>
      </div>
      {/* Transcript section */}
      {note.transcript_raw && (
        <details className="mb-6">
          <summary className="text-sm font-medium text-foreground-muted cursor-pointer hover:text-foreground transition-colors py-2">
            查看原视频文案 ▾
          </summary>
          <div className="mt-2 p-4 rounded-xl bg-card-bg border border-card-border max-h-[400px] overflow-y-auto">
            <pre className="text-xs text-foreground-muted whitespace-pre-wrap font-sans leading-relaxed">
              {note.transcript_raw}
            </pre>
          </div>
        </details>
      )}

      <div ref={cardRef}>
        <CardRenderer cardData={cardData} showExport={false} noteId={note.id} showToolbar={true} />
      </div>
      <p className="mt-6 text-center text-foreground-muted text-xs">
        {note.created_at ? new Date(note.created_at).toLocaleString('zh-CN') : ''}
      </p>
    </div>
  );
}

function NotesList() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);

  const loadNotes = useCallback(async (p: number) => {
    setLoading(true);
    const res = await listNotes(p, 12);
    if (res.success && res.data) {
      setNotes(res.data.items || []);
      setTotalPages(res.data.total_pages || 1);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadNotes(page);
  }, [page, loadNotes]);

  if (loading) {
    return (
      <div>
        <div className="mb-8">
          <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight text-balance">
            📚 知识库
          </h1>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton p-5">
              <div className="skeleton-line w-16 h-4 mb-3" />
              <div className="skeleton-line w-3/4 h-5 mb-2" />
              <div className="skeleton-line w-full h-3 mb-1" />
              <div className="skeleton-line w-2/3 h-3" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl md:text-3xl font-bold text-foreground tracking-tight text-balance">
          📚 知识库
        </h1>
        <p className="text-foreground-muted text-sm mt-1">
          所有提取的知识卡片
        </p>
      </div>

      {notes.length === 0 ? (
        <div className="min-h-[40vh] flex flex-col items-center justify-center text-center px-4">
          <div className="w-16 h-16 rounded-xl bg-accent-emerald/10 flex items-center justify-center mb-4">
            <span className="text-3xl">🫒</span>
          </div>
          <p className="text-foreground-secondary text-base font-medium mb-1.5">还没有知识卡片</p>
          <p className="text-foreground-muted text-sm text-pretty max-w-xs">
            在首页粘贴视频链接，开始提取第一张卡片
          </p>
          <Link
            href="/"
            className="mt-5 text-accent-emerald hover:underline text-sm font-medium"
          >
            去首页 →
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
            {notes.map((note, index) => (
              <Link
                key={note.id}
                href={`/notes?id=${note.id}`}
                className={`glass-card p-5 group hover:scale-[1.02] transition-all duration-200 cursor-pointer block text-foreground no-underline ${
                  index === 0 && page === 1 ? 'sm:col-span-2 lg:col-span-2' : ''
                }`}
              >
                <div className="flex items-start justify-between mb-2">
                  <span
                    className="text-xs font-medium px-2 py-0.5 rounded-full"
                    style={{
                      background: `var(--accent-${
                        note.card_type === 'recipe' ? 'orange' :
                        note.card_type === 'insight' ? 'emerald' :
                        note.card_type === 'history' ? 'amber' :
                        note.card_type === 'product' ? 'rose' : note.card_type === 'plan' ? 'indigo' : 'slate'
                      })/0.12`,
                      color: `var(--accent-${
                        note.card_type === 'recipe' ? 'orange' :
                        note.card_type === 'insight' ? 'emerald' :
                        note.card_type === 'history' ? 'amber' :
                        note.card_type === 'product' ? 'rose' : note.card_type === 'plan' ? 'indigo' : 'slate'
                      })`,
                    }}
                  >
                    {note.card_type === 'recipe' ? '🍳 食谱' :
                     note.card_type === 'insight' ? '💡 洞察' :
                     note.card_type === 'history' ? '📚 历史' :
                     note.card_type === 'product' ? '🛍️ 评测' : note.card_type === 'plan' ? '📋 计划' : '📝 笔记'}
                  </span>
                  {note.pitfall_rating && (
                    <span className="text-xs text-foreground-muted">
                      {'★'.repeat(note.pitfall_rating)}{'☆'.repeat(5 - note.pitfall_rating)}
                    </span>
                  )}
                </div>
                <h3 className="text-sm font-semibold text-foreground mb-1.5 line-clamp-2 text-balance">
                  {note.title}
                </h3>
                {note.excerpt && (
                  <p className="text-xs text-foreground-muted line-clamp-2 leading-relaxed mb-3">
                    {note.excerpt}
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-foreground-muted/60">
                    {note.created_at ? new Date(note.created_at).toLocaleDateString('zh-CN') : ''}
                  </span>
                  <span className="text-xs text-accent-emerald opacity-0 group-hover:opacity-100 transition-opacity">
                    查看详情 →
                  </span>
                </div>
              </Link>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-8">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="glass-input px-4 py-2 text-sm disabled:opacity-30 cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                上一页
              </button>
              <span className="text-sm text-foreground-muted px-3">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="glass-input px-4 py-2 text-sm disabled:opacity-30 cursor-pointer min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                下一页
              </button>
            </div>
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
