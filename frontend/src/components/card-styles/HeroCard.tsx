'use client';

import { useId } from 'react';
import {
  BookmarkSimple,
  LinkSimple,
  Quotes,
  Sparkle,
} from '@phosphor-icons/react';
import {
  CARD_TYPE_CONFIG,
  type ContentDensity,
  type ContentTone,
  type StyleCardProps,
} from '@/lib/types';
import SectionIcon from '../SectionIcon';
import TranscriptViewer from '../TranscriptViewer';

function formatBody(content: string): React.ReactNode {
  const lines = content.split('\n');
  const out: React.ReactNode[] = [];
  let buffer: string[] = [];
  let listKind: 'ul' | 'ol' | null = null;

  const inline = (text: string): React.ReactNode => {
    const parts = text.split(/(\*\*[^*]+\*\*)/g);
    return parts.map((part, index) =>
      part.startsWith('**') && part.endsWith('**')
        ? <strong key={index}>{part.slice(2, -2)}</strong>
        : part,
    );
  };

  const flushList = () => {
    if (buffer.length === 0) return;
    const List = listKind === 'ol' ? 'ol' : 'ul';
    out.push(
      <List key={`list-${out.length}`}>
        {buffer.map((item, index) => <li key={index}>{inline(item)}</li>)}
      </List>,
    );
    buffer = [];
    listKind = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const numbered = line.match(/^(?:[1-9]️⃣\s*|(\d+)[.)]\s*)(.+)/);
    if (numbered) {
      if (listKind !== 'ol') {
        flushList();
        listKind = 'ol';
      }
      buffer.push(numbered[2] || line.replace(/^[1-9]️⃣\s*/, ''));
      continue;
    }

    const bullet = line.match(/^[•\-*]\s+(.+)/);
    if (bullet) {
      if (listKind !== 'ul') {
        flushList();
        listKind = 'ul';
      }
      buffer.push(bullet[1]);
      continue;
    }

    flushList();
    out.push(<p key={`paragraph-${out.length}`}>{inline(line)}</p>);
  }

  flushList();
  return <>{out}</>;
}

function pitfallLabel(rating: number, cardType: string): {
  label: string;
  pct: number;
  hint: string;
  metricLabel: string;
} {
  const clamped = Math.max(1, Math.min(5, Math.round(rating)));
  const pct = (clamped / 5) * 100;

  if (cardType === 'recipe') {
    const labels = ['新手友好', '简单', '中等', '偏难', '难度极高'];
    return {
      label: labels[clamped - 1],
      pct,
      metricLabel: '实操难度',
      hint: '按原内容执行时需要留意的复杂程度',
    };
  }
  if (cardType === 'product') {
    const labels = ['闭眼入手', '可放心', '需谨慎', '需多比较', '高概率踩雷'];
    return {
      label: labels[clamped - 1],
      pct,
      metricLabel: '入手谨慎度',
      hint: '直接采用原内容推荐前需要补充核实的程度',
    };
  }

  const labels = ['信息扎实', '基本可信', '需自行判断', '建议存疑', '观点偏激进'];
  return {
    label: labels[clamped - 1],
    pct,
    metricLabel: '内容判断',
    hint: '原内容更接近可直接参考的信息，还是需要交叉验证的观点',
  };
}

function buildStats(cardData: StyleCardProps['cardData']): { label: string; value: string }[] {
  const stats = [
    { label: '核心要点', value: `${cardData.sections?.length ?? 0} 节` },
  ];
  const characterCount = cardData.transcript_raw?.length ?? 0;

  if (characterCount > 0) {
    stats.push(
      {
        label: '预计阅读',
        value: `${Math.max(1, Math.round(characterCount / 450))} 分钟`,
      },
      {
        label: '文稿体量',
        value: `${characterCount.toLocaleString('zh-CN')} 字`,
      },
    );
  }
  return stats;
}

function resolveProfile(
  cardData: StyleCardProps['cardData'],
  density: ContentDensity,
): { tone: ContentTone; density: ContentDensity; label: string } {
  const tone: ContentTone = cardData.tone ?? (
    cardData.card_type === 'recipe' || cardData.card_type === 'product'
      ? 'informational'
      : 'hybrid'
  );
  const toneLabel = tone === 'emotional'
    ? '情绪共鸣'
    : tone === 'informational'
      ? '干货笔记'
      : '观点与干货';

  return {
    tone,
    density: cardData.density ?? density ?? 'medium',
    label: toneLabel,
  };
}

export default function HeroCard({ cardData, density, cardRef }: StyleCardProps) {
  const sectionsTitleId = useId();
  const takeawayTitleId = useId();
  const config = CARD_TYPE_CONFIG[cardData.card_type] || CARD_TYPE_CONFIG.general;
  const profile = resolveProfile(cardData, density);
  const stats = buildStats(cardData);
  const meter = pitfallLabel(cardData.pitfall_rating, cardData.card_type);
  const showStats = profile.density !== 'low' && stats.length > 0;
  const showSections = profile.density !== 'low' && cardData.sections.length > 0;
  const showInsight = Boolean(cardData.key_insight) && profile.tone !== 'emotional';
  const showMeter = profile.density !== 'low' && (
    cardData.card_type === 'recipe'
    || cardData.card_type === 'product'
    || cardData.pitfall_rating !== 3
  );

  return (
    <article className={`hero-card tone-${cardData.card_type}`}>
      <div
        ref={cardRef as React.RefObject<HTMLDivElement>}
        className="hero-shell"
        data-tone={profile.tone}
        data-density={profile.density}
      >
        <div className="hero-body">
          <header className="hero-header">
            <div className="hero-kicker-row">
              <span className="hero-eyebrow">
                <Sparkle size={14} weight="fill" aria-hidden />
                {config.label}
              </span>
              <span className="hero-profile">{profile.label}</span>
            </div>
            <h2 className="hero-title">{cardData.title}</h2>
          </header>

          {cardData.hero_quote && (
            <figure className="hero-lead">
              <Quotes size={24} weight="fill" aria-hidden />
              <blockquote>{cardData.hero_quote}</blockquote>
            </figure>
          )}

          {showStats && (
            <dl className="hero-stats" data-count={Math.min(stats.length, 3)}>
              {stats.slice(0, 3).map((stat) => (
                <div className="hero-stat" key={stat.label}>
                  <dt>{stat.label}</dt>
                  <dd>{stat.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {showInsight && (
            <aside className="hero-insight">
              <span className="hero-insight-label">
                <Sparkle size={13} weight="fill" aria-hidden />
                核心洞察
              </span>
              <p>{cardData.key_insight}</p>
            </aside>
          )}

          {showSections && (
            <section className="hero-sections" aria-labelledby={sectionsTitleId}>
              <div className="hero-sections__heading">
                <h3 id={sectionsTitleId}>内容拆解</h3>
                <span>{cardData.sections.length} 个要点</span>
              </div>
              <ol>
                {cardData.sections.map((section, index) => (
                  <li className="hero-section" key={`${section.title}-${index}`}>
                    <span className="hero-section-marker" aria-hidden>
                      <SectionIcon
                        iconKey={section.icon}
                        title={section.title}
                        emoji={section.emoji}
                        size={17}
                        strokeWidth={2}
                        className="hero-section-icon"
                      />
                      <span className="num">{index + 1}</span>
                    </span>
                    <div className="hero-section-copy">
                      <h4 className="hero-section-title">{section.title}</h4>
                      <div className="hero-section-body">{formatBody(section.content)}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {cardData.conclusion && (
            <section className="hero-takeaway" aria-labelledby={takeawayTitleId}>
              <span className="hero-takeaway-marker" aria-hidden>
                <BookmarkSimple size={17} weight="fill" />
              </span>
              <div>
                <h3 id={takeawayTitleId}>带走这几句</h3>
                <ol className="hero-takeaway-list">
                  {cardData.conclusion
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .slice(0, 3)
                    .map((line, index) => (
                      <li className="hero-takeaway-item" key={`${line}-${index}`}>
                        <span className="num">{String(index + 1).padStart(2, '0')}</span>
                        <span>{line}</span>
                      </li>
                    ))}
                </ol>
              </div>
            </section>
          )}

          {showMeter && (
            <section className="hero-meter-wrap" aria-label={meter.metricLabel}>
              <div className="hero-meter">
                <span className="hero-meter-label">{meter.metricLabel}</span>
                <span className="hero-meter-value">
                  {cardData.pitfall_rating}/5 · {meter.label}
                </span>
                <span className="hero-meter-track" aria-hidden>
                  <span className="hero-meter-fill" style={{ width: `${meter.pct}%` }} />
                </span>
              </div>
              <p className="hero-meter-hint">{meter.hint}</p>
            </section>
          )}

          {cardData.source_url && (
            <footer className="hero-source">
              <span>
                <LinkSimple size={14} weight="bold" aria-hidden />
                来源：原视频或原文
              </span>
              {cardData.video_id && <code>#{cardData.video_id.slice(-8)}</code>}
            </footer>
          )}
        </div>
      </div>

      {density === 'high' && cardData.transcript_raw && (
        <div className="mt-6">
          <TranscriptViewer transcript={cardData.transcript_raw} />
        </div>
      )}
    </article>
  );
}
