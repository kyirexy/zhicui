'use client';

import { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Clock, Tag, Film } from 'lucide-react';
import { getNote } from '@/lib/api';
import type { NoteDetail, CardData } from '@/lib/types';
import { CARD_TYPE_CONFIG } from '@/lib/types';
import CardRenderer from '@/components/CardRenderer';
import TranscriptViewer from '@/components/TranscriptViewer';

function ProcessContent() {
  const searchParams = useSearchParams();
  const noteId = searchParams.get('id');

  if (!noteId) {
    return <MissingId />;
  }
  return <ProcessView id={noteId} />;
}

function MissingId() {
  return (
    <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
      <p className="text-4xl mb-4">🔍</p>
      <p className="text-foreground-secondary mb-4">请指定笔记 ID</p>
      <Link href="/notes" className="text-accent-emerald hover:underline text-sm">
        ← 返回知识库
      </Link>
    </div>
  );
}

function ProcessView({ id }: { id: string }) {
  const [note, setNote] = useState<NoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
        <div className="w-full max-w-3xl space-y-4">
          <div className="skeleton h-8 w-32" />
          <div className="skeleton h-48" />
          <div className="skeleton h-64" />
          <div className="skeleton h-32" />
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

  const config = CARD_TYPE_CONFIG[note.card_type] || CARD_TYPE_CONFIG.general;

  // Build CardData from NoteDetail for the CardRenderer.
  const cardData: CardData = {
    title: note.title,
    card_type: note.card_type || 'general',
    sections: note.sections || [],
    conclusion: note.conclusion || '',
    pitfall_rating: note.pitfall_rating,
    source_url: note.source_url,
    video_url: note.video_url,
    transcript_raw: note.transcript_raw,
    video_title: note.video_title,
    video_id: note.video_id,
  };

  return (
    <div className="pb-16">
      {/* Back navigation */}
      <div className="mb-6">
        <Link
          href={`/notes?id=${id}`}
          className="inline-flex items-center gap-1.5 text-foreground-secondary hover:text-foreground transition-colors text-sm px-2 py-1 rounded-lg hover:bg-white/5"
        >
          <ArrowLeft size={14} />
          返回卡片
        </Link>
      </div>

      {/* Page title — compressed on mobile */}
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-3xl font-bold text-foreground tracking-tight text-balance">
          🔬 详细处理过程
        </h1>
        <p className="text-foreground-muted text-xs md:text-sm mt-1">
          完整视频文案与 AI 提取结果
        </p>
      </div>

      <div className="space-y-10">
        {/* Section 1: Video Metadata */}
        <section>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2 mb-4">
            <Film size={16} className="text-foreground-muted" />
            视频信息
          </h2>
          <div className="rounded-xl bg-card-bg border border-card-border p-5 md:p-6 space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-2xl">{config.emoji}</span>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-foreground leading-snug">
                  {note.video_title || note.title}
                </h3>
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  <span
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                    style={{ background: `${config.accent}15`, color: config.accent }}
                  >
                    <Tag size={10} />
                    {config.label}
                  </span>
                  {note.created_at && (
                    <span className="inline-flex items-center gap-1 text-xs text-foreground-muted">
                      <Clock size={10} />
                      {new Date(note.created_at).toLocaleString('zh-CN')}
                    </span>
                  )}
                </div>
              </div>
            </div>
            {/* 视频播放已移除 — 抖音 CDN 链接存在时效性，B站 iframe 体验也不一致。
                如需观看原视频，请通过原始链接跳转。 */}
          </div>
        </section>

        {/* Section 2: Original Transcript */}
        {note.transcript_raw && (
          <section>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2 mb-4">
              📝 原始转录文本
            </h2>
            <TranscriptViewer transcript={note.transcript_raw} />
          </section>
        )}

        {!note.transcript_raw && (
          <section>
            <h2 className="text-base font-semibold text-foreground flex items-center gap-2 mb-4">
              📝 原始转录文本
            </h2>
            <div className="rounded-xl bg-card-bg border border-card-border p-6 text-center">
              <p className="text-foreground-muted text-sm">该笔记没有保存原始转录文本。</p>
            </div>
          </section>
        )}

        {/* Section 3: AI Extraction Result */}
        <section>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2 mb-4">
            🧠 AI 提取结果
          </h2>
          <CardRenderer
            cardData={cardData}
            showExport={false}
            showToolbar={false}
            noteId={id}
          />
        </section>
      </div>
    </div>
  );
}

export default function ProcessPage() {
  return (
    <Suspense fallback={
      <div className="min-h-[60vh] flex flex-col items-center justify-center">
        <div className="w-full max-w-3xl space-y-4">
          <div className="skeleton h-8 w-32" />
          <div className="skeleton h-48" />
          <div className="skeleton h-64" />
          <div className="skeleton h-32" />
        </div>
      </div>
    }>
      <ProcessContent />
    </Suspense>
  );
}
