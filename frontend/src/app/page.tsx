'use client';

import { useState, useCallback, useEffect } from 'react';
import Link from 'next/link';
import InputBar from '@/components/InputBar';
import SampleLinks from '@/components/SampleLinks';
import CardRenderer from '@/components/CardRenderer';
import PipelineProgress from '@/components/PipelineProgress';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { getPlanStats } from '@/lib/api';
import MobileDownloadButton from '@/components/MobileDownloadButton';
import { HOME_CATEGORIES, type HomeCategory } from '@/lib/homeCategories';
import { X, CheckSquare, Code2, Brain, BookOpen, Target, Lightbulb, TrendingUp, LineChart, Star, FileText } from 'lucide-react';

const CATEGORY_ICON_MAP: Record<string, typeof Code2> = {
  'Code2': Code2, 'Brain': Brain, 'BookOpen': BookOpen,
  'Target': Target, 'Lightbulb': Lightbulb, 'TrendingUp': TrendingUp,
  'LineChart': LineChart, 'Star': Star, 'FileText': FileText,
};

export default function HomePage() {
  const { isLoading, error, cardData, progressSteps, startExtraction, clearCard, dismissError } = useExtraction();
  const [fillUrl, setFillUrl] = useState<string | null>(null);
  const [planReminder, setPlanReminder] = useState(false);
  const [planReminderDue, setPlanReminderDue] = useState(0);

  // Restore cardData on full page reload (context survives tab switches already).
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem('vc-home-card');
      if (cached && !cardData) {
        startExtraction(''); // no-op, just checking — the real restore is handled by context re-init
      }
    } catch {}
  }, []);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const lastDismiss = localStorage.getItem('vc-plan-reminder-dismissed');
    if (lastDismiss === today) return;
    getPlanStats().then((res) => {
      if (res.success && res.data && res.data.due_today > 0) {
        setPlanReminder(true);
        setPlanReminderDue(res.data.due_today);
      }
    });
  }, []);

  const dismissReminder = () => {
    const today = new Date().toISOString().slice(0, 10);
    localStorage.setItem('vc-plan-reminder-dismissed', today);
    setPlanReminder(false);
  };

  const handleSubmit = useCallback((url: string) => {
    startExtraction(url);
  }, [startExtraction]);

  return (
    <div className="flex flex-col items-center pb-24 md:pb-32">
      {/* Ambient glow orbs */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0" aria-hidden="true">
        <div className="emerald-orb w-[500px] h-[500px] -top-40 -left-40 opacity-60" />
        <div className="emerald-orb w-[400px] h-[400px] top-1/3 -right-32 opacity-40" style={{ animationDelay: '-4s' }} />
        <div className="emerald-orb w-[350px] h-[350px] bottom-20 left-1/4 opacity-30" style={{ animationDelay: '-8s' }} />
      </div>

      {/* PU7: Plan reminder banner */}
      {planReminder && (
        <div className="relative z-20 w-full max-w-2xl mx-auto px-2 md:px-0 mb-4 animate-slide-up">
          <div className="flex items-start gap-3 p-3 md:p-4 rounded-2xl bg-accent-emerald/10 border border-accent-emerald/20">
            <CheckSquare size={18} className="text-accent-emerald flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground">你今天有 {planReminderDue} 项计划任务到期</p>
              <p className="text-xs text-foreground-muted mt-0.5">打开计划页面查看详情</p>
            </div>
            <Link href="/plans" className="flex-shrink-0 text-xs font-medium text-accent-emerald hover:underline px-2 py-1">查看</Link>
            <button type="button" onClick={dismissReminder} className="flex-shrink-0 p-1 rounded-lg text-foreground-muted/40 hover:text-foreground-muted" aria-label="关闭提醒">
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Mobile download button — desktop-only */}
      <div className="relative z-10 w-full hidden md:block">
        <MobileDownloadButton />
      </div>

      {/* Hero section */}
      <section className={`relative z-10 text-center px-4 transition-all duration-500 ${
        isLoading ? 'pt-2 pb-1 md:pt-8 md:pb-6' : 'pt-4 pb-2 md:pt-24 md:pb-16 lg:pt-28 lg:pb-20'
      }`}>
        <div className="animate-fade-up-blur">
          {/* Mobile eyebrow — compact version of the desktop chip */}
          <div className="md:hidden flex items-center justify-center mb-4">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-accent-emerald/90 bg-accent-emerald/[0.06] rounded-full px-3 py-1 border border-accent-emerald/10">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-emerald animate-pulse" />AI 视频知识提取
            </span>
          </div>
          <div className="hidden md:flex items-center justify-center mb-6">
            <span className="eyebrow">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent-emerald animate-pulse" />AI 视频知识提取
            </span>
          </div>
          <div className="flex items-center justify-center gap-2 md:gap-3 mb-2 md:mb-5">
            <img
              src="/logo.png"
              alt="知萃"
              className="h-10 w-10 md:h-20 md:w-20 lg:h-24 lg:w-24 object-contain drop-shadow-[0_0_30px_rgba(16,185,129,0.2)]"
            />
            <h1 className="text-2xl md:text-5xl lg:text-6xl font-extrabold text-foreground tracking-tight text-balance leading-[1.1]">知萃</h1>
          </div>
          <p className="text-foreground-secondary text-xs md:text-xl max-w-lg mx-auto leading-relaxed text-pretty px-2">粘贴视频链接,AI 自动萃成知识卡片和行动计划</p>
          <p className="text-foreground-muted text-[10px] md:text-base max-w-md mx-auto mt-1 md:mt-2">支持抖音 · B站 · 公众号文章</p>
        </div>
      </section>

      {/* Input section */}
      <section className="relative z-10 w-full mb-6 md:mb-8">
        <InputBar onSubmit={handleSubmit} isLoading={isLoading} error={error} fillUrl={fillUrl} onFillComplete={() => setFillUrl(null)} />
      </section>

      {/* Loading state: pipeline progress */}
      {isLoading && (
        <section className="relative z-10 w-full max-w-xl mx-auto mb-10 animate-fade-in">
          <div className="glass-card p-6 md:p-8">
            <PipelineProgress steps={progressSteps} />
          </div>
        </section>
      )}

      {/* Sample links */}
      {!cardData && !isLoading && (
        <section className="relative z-10 w-full mb-10 md:mb-14">
          <SampleLinks onFill={setFillUrl} isLoading={isLoading} />
        </section>
      )}

      {/* Category cards */}
      {!cardData && !isLoading && (
        <section className="relative z-10 w-full max-w-5xl mx-auto px-2 md:px-0">
          <div className="mb-4 md:mb-6 text-center">
            <p className="text-[11px] md:text-xs font-medium text-accent-emerald/90">覆盖你收藏夹里的高频内容</p>
            <h2 className="mt-1 md:mt-1.5 text-base md:text-2xl font-bold text-foreground tracking-tight">各类视频，一键萃成可用知识</h2>
            <p className="mt-1 md:mt-2 text-[11px] md:text-sm text-foreground-muted">AI 自动识别内容类型，生成结构化卡片和行动计划</p>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-2.5 md:gap-5">
            {HOME_CATEGORIES.map((category, index) => (
              <CategoryCard key={category.slug} category={category} delay={index} />
            ))}
          </div>
        </section>
      )}

      {/* Card display */}
      {cardData && (
        <section className="relative z-10 w-full max-w-6xl mx-auto">
          <CardRenderer cardData={cardData} showExport={true} showToolbar={true} noteId={cardData.id} />
          {cardData.card_type === 'plan' && cardData.plan_id && (
            <div className="mt-5 animate-fade-in">
              <Link href={`/plans?id=${cardData.plan_id}`}
                className="flex items-center gap-3 p-4 rounded-2xl bg-accent-indigo/10 border border-accent-indigo/20 hover:bg-accent-indigo/15 transition-colors group">
                <span className="text-2xl">📋</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-foreground">已为你建立执行计划</span>
                  <span className="block text-xs text-foreground-muted mt-0.5">AI 已将视频中的步骤拆解为可执行的任务清单</span>
                </span>
                <span className="flex-shrink-0 text-sm font-medium text-accent-indigo group-hover:underline">查看计划 →</span>
              </Link>
            </div>
          )}
        </section>
      )}

      {/* Error state */}
      {error && !isLoading && !cardData && (
        <section className="relative z-10 w-full max-w-xl mx-auto mb-10">
          <div className="glass-card p-5 md:p-6 border-accent-rose/20">
            <div className="flex items-start gap-3">
              <span className="text-xl flex-shrink-0">⚠️</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground mb-1">提取失败</p>
                <p className="text-xs text-foreground-muted leading-relaxed mb-3">{error}</p>
                <button onClick={dismissError} className="text-xs font-medium text-accent-emerald hover:underline">关闭</button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function CategoryCard({ category, delay }: { category: HomeCategory; delay: number }) {
  const [imgOk, setImgOk] = useState(false);
  const IconComp = CATEGORY_ICON_MAP[category.icon];

  const handleClick = () => {
    // Click the card → fill InputBar with the first sample URL (if any).
    if (category.samples.length > 0) {
      const first = category.samples[0].url;
      const input = document.querySelector<HTMLInputElement>('input[placeholder*="粘贴"]');
      if (input) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        nativeInputValueSetter?.call(input, first);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
    }
  };

  return (
    <article
      onClick={handleClick}
      className="group relative min-h-[100px] md:min-h-[140px] overflow-hidden rounded-2xl animate-fade-up-blur transition-all duration-300 active:scale-[0.98] md:hover:-translate-y-1 cursor-pointer"
      style={{
        animationDelay: `${delay * 50}ms`,
        backgroundColor: category.accent + '12',
        borderLeft: `4px solid ${category.accent}`,
        boxShadow: `0 4px 24px ${category.accent}10`,
      }}
    >
      {/* Giant watermark icon — top-right, very subtle */}
      {IconComp && (
        <IconComp
          size={56}
          className="absolute -top-2 -right-2 md:top-0 md:right-0 transition-all duration-500 md:group-hover:scale-110 md:group-hover:opacity-20"
          style={{ color: category.accent, opacity: 0.1 }}
          aria-hidden="true"
        />
      )}

      {/* Content */}
      <div className="relative z-10 flex flex-col justify-end h-full min-h-[100px] md:min-h-[140px] p-3 md:p-4">
        {/* Small icon + title row */}
        <div className="flex items-center gap-2 mb-1.5 md:mb-2">
          {IconComp && (
            <div
              className="flex-shrink-0 w-8 h-8 md:w-9 md:h-9 rounded-xl flex items-center justify-center transition-colors duration-300"
              style={{ backgroundColor: category.accent + '28' }}
            >
              <IconComp
                size={16}
                className="md:size-[17px]"
                style={{ color: category.accent }}
                aria-hidden="true"
              />
            </div>
          )}
          <h3 className="text-[14px] md:text-lg font-bold text-foreground tracking-tight">
            {category.title}
          </h3>
        </div>
        <p className="text-[11px] md:text-[13px] leading-relaxed text-foreground-muted/90 line-clamp-2 pl-10 md:pl-[44px]">
          {category.desc}
        </p>
      </div>
    </article>
  );
}
