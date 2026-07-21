import { useId } from 'react';
import {
  ArrowSquareOut,
  Article,
  Brain,
  FileText,
  Sparkle,
} from '@phosphor-icons/react';
import type { CardData } from '@/lib/types';
import TranscriptViewer from './TranscriptViewer';

interface ContentSourcePanelProps {
  cardData: CardData;
  onShowCard: () => void;
}

interface SourceProfile {
  label: string;
  documentLabel: string;
}

function safeSourceUrl(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceProfile(cardData: CardData): SourceProfile {
  const source = `${cardData.source_url ?? ''} ${cardData.video_url ?? ''}`.toLowerCase();

  if (source.includes('bilibili.com') || source.includes('b23.tv') || cardData.video_id?.startsWith('BV')) {
    return { label: 'B站视频', documentLabel: '完整视频文案' };
  }
  if (source.includes('douyin.com') || source.includes('iesdouyin.com') || source.includes('aweme')) {
    return { label: '抖音视频', documentLabel: '完整视频文案' };
  }
  if (source.includes('mp.weixin.qq.com')) {
    return { label: '公众号文章', documentLabel: '完整文章正文' };
  }
  if (source.includes('xiaohongshu.com') || source.includes('xhslink.com')) {
    return { label: '小红书笔记', documentLabel: '完整笔记正文' };
  }
  if (cardData.video_id) {
    return { label: '视频内容', documentLabel: '完整视频文案' };
  }
  return { label: '网络内容', documentLabel: '完整内容原文' };
}

function formatDate(value?: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

export default function ContentSourcePanel({ cardData, onShowCard }: ContentSourcePanelProps) {
  const headingId = useId();
  const summaryId = useId();
  const documentId = useId();
  const transcript = cardData.transcript_raw ?? '';
  const hasTranscript = Boolean(transcript.trim());
  const profile = sourceProfile(cardData);
  const title = cardData.video_title?.trim() || cardData.title;
  const summary = cardData.key_insight?.trim()
    || cardData.conclusion?.trim()
    || cardData.seo_meta?.trim()
    || 'AI 已完成内容理解，可继续查看知识卡片或在右侧向完整文稿提问。';
  const sourceUrl = safeSourceUrl(cardData.source_url || cardData.video_url);
  const createdLabel = formatDate(cardData.created_at);

  return (
    <article className="content-source" aria-labelledby={headingId}>
      <header className="content-source__header">
        <div className="content-source__heading">
          <span className="content-source__mark" aria-hidden>
            <Article size={22} weight="duotone" />
          </span>
          <div className="min-w-0">
            <p className="content-source__eyebrow">
              <Sparkle size={12} weight="fill" aria-hidden />
              内容全览
            </p>
            <h2 id={headingId} className="content-source__title text-balance">
              {title}
            </h2>
          </div>
        </div>

        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="content-source__link"
          >
            <ArrowSquareOut size={16} weight="bold" aria-hidden />
            打开内容来源
          </a>
        )}
      </header>

      <dl className="content-source__meta" aria-label="内容提取信息">
        <div>
          <dt>来源</dt>
          <dd>{profile.label}</dd>
        </div>
        <div>
          <dt>原文字数</dt>
          <dd className="tabular-nums">{transcript.length.toLocaleString('zh-CN')} 字</dd>
        </div>
        <div>
          <dt>AI 章节</dt>
          <dd className="tabular-nums">{cardData.sections.length} 个</dd>
        </div>
        {createdLabel && (
          <div>
            <dt>萃取日期</dt>
            <dd>{createdLabel}</dd>
          </div>
        )}
      </dl>

      <section className="content-source__summary" aria-labelledby={summaryId}>
        <span className="content-source__summary-icon" aria-hidden>
          <Brain size={18} weight="duotone" />
        </span>
        <div>
          <h3 id={summaryId} className="text-balance">AI 内容简介</h3>
          <p className="text-pretty">{summary}</p>
        </div>
      </section>

      <section className="content-source__document" aria-labelledby={documentId}>
        <div className="content-source__document-heading">
          <div>
            <span aria-hidden><FileText size={18} weight="duotone" /></span>
            <div>
              <h3 id={documentId} className="text-balance">{profile.documentLabel}</h3>
              <p className="text-pretty">可直接搜索和复制；右侧 AI 问答会扫描这份全文并结合知识卡片回答。</p>
            </div>
          </div>
          {hasTranscript && (
            <strong className="tabular-nums">{transcript.length.toLocaleString('zh-CN')} 字</strong>
          )}
        </div>

        {hasTranscript ? (
          <TranscriptViewer transcript={transcript} className="content-source__transcript-viewer" />
        ) : (
          <div className="content-source__empty">
            <p className="text-pretty">这条内容没有可用的原始文稿，但 AI 已提炼的知识卡片仍然可以查看。</p>
            <button type="button" onClick={onShowCard}>继续查看知识卡片</button>
          </div>
        )}
      </section>
    </article>
  );
}
