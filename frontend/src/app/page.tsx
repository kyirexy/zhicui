'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  FileText,
  Library,
  ListChecks,
  MessageSquare,
  Play,
  Sparkles,
  X,
} from 'lucide-react';
import InputBar from '@/components/InputBar';
import CardRenderer from '@/components/CardRenderer';
import PipelineProgress from '@/components/PipelineProgress';
import DesktopWorkspaceHome from '@/components/DesktopWorkspaceHome';
import WorkspaceActionHome from '@/components/WorkspaceActionHome';
import WebLandingPage from '@/components/WebLandingPage';
import { useDesktopApp } from '@/components/DesktopAppFrame';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { isNativeAndroidApp } from '@/lib/douyinNative';

const LIBRARY_STEPS = [
  {
    number: '01',
    title: '选择视频范围',
    description: '收藏、喜欢或自己的作品，数量由你决定。',
  },
  {
    number: '02',
    title: '完整文案逐条出现',
    description: '处理好一条就展示一条，不用等整批完成。',
  },
  {
    number: '03',
    title: '直接问整组视频',
    description: 'AI 先读完整文案，再结合原文依据回答。',
  },
  {
    number: '04',
    title: '变成行动',
    description: '需要时再生成计划、清单或知识卡。',
  },
] as const;

const PREVIEW_VIDEOS = [
  {
    title: '3 个动作改善久坐肩颈',
    duration: '02:18',
    label: '完整文案',
  },
  {
    title: '一周晚餐的备菜顺序',
    duration: '04:06',
    label: '文案提取中',
  },
  {
    title: '产品演示开场怎么讲',
    duration: '01:42',
    label: '完整文案',
  },
  {
    title: '新手跑步的呼吸节奏',
    duration: '03:25',
    label: '完整文案',
  },
] as const;

export default function HomePage() {
  const { isDesktop, resolved } = useDesktopApp();
  const {
    isLoading,
    error,
    cardData,
    progressSteps,
    startExtraction,
    dismissError,
  } = useExtraction();
  const [singleExtractorOpen, setSingleExtractorOpen] = useState(false);
  const [nativeAndroid, setNativeAndroid] = useState<boolean | null>(null);

  useEffect(() => {
    setNativeAndroid(isNativeAndroidApp());
  }, []);

  useEffect(() => {
    if (isDesktop || nativeAndroid !== true) return;
    try {
      const cached = sessionStorage.getItem('vc-home-card');
      if (cached && !cardData) {
        startExtraction('');
      }
    } catch {}
  }, [cardData, isDesktop, nativeAndroid, startExtraction]);

  const handleSubmit = useCallback((url: string) => {
    startExtraction(url);
  }, [startExtraction]);

  const openSingleExtractor = () => {
    setSingleExtractorOpen(true);
    window.setTimeout(() => {
      document.getElementById('single-link-extractor')?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }, 60);
  };

  if (!resolved || nativeAndroid === null) {
    return <div className="min-h-[68dvh]" aria-hidden="true" />;
  }

  if (isDesktop) {
    return <DesktopWorkspaceHome />;
  }

  if (!nativeAndroid) {
    return <WebLandingPage />;
  }

  const showLanding = !isLoading && !cardData;
  const showSingleExtractor = singleExtractorOpen || isLoading || Boolean(cardData) || Boolean(error);

  if (showLanding && !singleExtractorOpen) {
    return (
      <div className="relative min-h-[calc(100dvh-8rem)] pb-24">
        <WorkspaceActionHome onOpenSingleLink={openSingleExtractor} />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center pb-24 md:pb-32">
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <div className="emerald-orb h-[34rem] w-[34rem] -left-56 -top-48 opacity-55" />
        <div className="emerald-orb right-[-12rem] top-[24%] h-[30rem] w-[30rem] opacity-30 [animation-delay:-4s]" />
      </div>

      {showLanding && !singleExtractorOpen && (
        <>
          <section className="relative z-10 grid w-full max-w-[1380px] items-center gap-10 pb-10 pt-7 lg:grid-cols-[minmax(0,0.86fr)_minmax(0,1.14fr)] lg:gap-14 lg:pb-16 lg:pt-16">
            <div className="max-w-[39rem] animate-fade-up-blur">
              <div className="mb-5 flex items-center gap-3">
                <img
                  src="/logo.png"
                  alt="知萃"
                  className="h-10 w-10 object-contain drop-shadow-[0_0_24px_rgba(48,48,52,0.22)] md:h-12 md:w-12"
                />
                <div>
                  <p className="text-base font-bold tracking-tight text-foreground">知萃</p>
                  <p className="text-xs text-foreground-muted">抖音批量视频库</p>
                </div>
              </div>

              <p className="mb-4 inline-flex items-center gap-2 text-xs font-semibold tracking-[0.12em] text-accent-emerald">
                <span className="h-1.5 w-1.5 rounded-full bg-accent-emerald shadow-[0_0_0_5px_rgba(48,48,52,0.1)]" />
                把收藏夹重新用起来
              </p>

              <h1 className="max-w-[12ch] text-balance text-[2.35rem] font-extrabold leading-[1.06] tracking-[-0.045em] text-foreground sm:text-5xl lg:text-[4.15rem]">
                视频收藏了很多，
                <span className="block text-accent-emerald">真正用上的很少。</span>
              </h1>

              <p className="mt-6 max-w-[36rem] text-pretty text-base leading-8 text-foreground-secondary md:text-lg">
                同步最近收藏、喜欢或自己的作品。知萃会逐条生成完整文案，让你直接向整组视频提问，再把有用的答案变成计划和知识卡。
              </p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link
                  href="/library"
                  className="btn-primary btn-magnetic inline-flex min-h-[52px] items-center justify-center gap-2 px-6 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/60 focus-visible:ring-offset-2"
                >
                  打开我的视频库
                  <ArrowRight size={17} />
                </Link>
                <button
                  type="button"
                  onClick={openSingleExtractor}
                  aria-expanded={singleExtractorOpen}
                  aria-controls="single-link-extractor"
                  className="inline-flex min-h-[52px] items-center justify-center gap-2 rounded-xl border border-card-border bg-card-bg/65 px-6 text-sm font-semibold text-foreground-secondary transition-[transform,background-color,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-accent-emerald/30 hover:bg-accent-emerald/[0.05] hover:text-foreground active:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/50"
                >
                  提取单条链接
                </button>
              </div>

              <ul className="mt-7 grid gap-3 text-sm text-foreground-muted sm:grid-cols-3">
                {[
                  '只同步你选择的范围',
                  '处理好一条就显示一条',
                  '不在数据库保存视频',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2">
                    <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md bg-accent-emerald/10 text-accent-emerald">
                      <Check size={12} strokeWidth={2.5} />
                    </span>
                    <span className="leading-5">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <LibraryWorkbenchPreview />
          </section>

          <section
            className="relative z-10 w-full max-w-[1380px] border-y border-card-border/70 py-7 md:py-9"
            aria-labelledby="library-flow-title"
          >
            <div className="mb-7 flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-semibold tracking-[0.12em] text-accent-emerald">
                  从视频到行动
                </p>
                <h2
                  id="library-flow-title"
                  className="mt-2 max-w-2xl text-balance text-2xl font-bold tracking-tight text-foreground md:text-3xl"
                >
                  不是把视频搬进来，而是把内容变得能查、能问、能执行
                </h2>
              </div>
              <Link
                href="/library"
                className="group inline-flex min-h-[44px] items-center gap-2 self-start rounded-lg py-2 text-sm font-semibold text-foreground-secondary transition-colors hover:text-accent-emerald focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/50 md:self-auto"
              >
                进入视频库体验
                <ArrowRight
                  size={15}
                  className="transition-transform duration-200 group-hover:translate-x-1"
                />
              </Link>
            </div>

            <ol className="grid gap-x-7 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
              {LIBRARY_STEPS.map((step, index) => (
                <li
                  key={step.number}
                  className={`relative min-w-0 ${index > 0 ? 'lg:before:absolute lg:before:-left-3.5 lg:before:top-1 lg:before:h-16 lg:before:w-px lg:before:bg-card-border' : ''}`}
                >
                  <span className="font-mono text-[11px] font-semibold tabular-nums tracking-[0.15em] text-accent-emerald/80">
                    {step.number}
                  </span>
                  <h3 className="mt-2 text-base font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-1.5 max-w-[28ch] text-sm leading-6 text-foreground-muted">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}

      {showSingleExtractor && (
        <section
          id="single-link-extractor"
          className="relative z-10 mt-8 w-full max-w-3xl animate-fade-up-blur rounded-[1.75rem] border border-card-border bg-card-bg/75 p-4 shadow-[0_24px_70px_-45px_rgba(48,48,52,0.42)] backdrop-blur-2xl md:mt-12 md:p-7"
          aria-labelledby="single-link-title"
        >
          <div className="mb-5 flex items-start justify-between gap-4 px-1">
            <div>
              <p className="text-xs font-semibold tracking-[0.12em] text-accent-emerald">
                单条内容
              </p>
              <h2 id="single-link-title" className="mt-1.5 text-xl font-bold text-foreground">
                提取一条视频链接
              </h2>
              <p className="mt-1 text-sm text-foreground-muted">
                适合临时整理一个视频；批量内容请使用视频库。
              </p>
            </div>
            {!isLoading && !cardData && !error && (
              <button
                type="button"
                onClick={() => setSingleExtractorOpen(false)}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl text-foreground-muted transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/50"
                aria-label="收起单条链接提取"
              >
                <X size={18} />
              </button>
            )}
          </div>

          <InputBar
            onSubmit={handleSubmit}
            isLoading={isLoading}
            showPlatformHint={false}
          />
        </section>
      )}

      {isLoading && (
        <section className="relative z-10 mt-7 w-full max-w-xl animate-fade-in">
          <div className="glass-card p-6 md:p-8">
            <PipelineProgress steps={progressSteps} />
          </div>
        </section>
      )}

      {cardData && (
        <section className="relative z-10 mt-8 w-full max-w-6xl">
          <CardRenderer
            cardData={cardData}
            showExport={true}
            showToolbar={true}
            noteId={cardData.id}
          />
          {cardData.card_type === 'plan' && cardData.plan_id && (
            <div className="mt-5 animate-fade-in">
              <Link
                href={`/plans?id=${cardData.plan_id}`}
                className="group flex items-center gap-3 rounded-2xl border border-accent-indigo/20 bg-accent-indigo/10 p-4 transition-colors hover:bg-accent-indigo/15"
              >
                <span className="text-2xl">📋</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">
                    已为你建立执行计划
                  </span>
                  <span className="mt-0.5 block text-xs text-foreground-muted">
                    AI 已将视频中的步骤拆解为可执行的任务清单
                  </span>
                </span>
                <span className="flex-shrink-0 text-sm font-medium text-accent-indigo group-hover:underline">
                  查看计划 →
                </span>
              </Link>
            </div>
          )}
        </section>
      )}

      {error && !isLoading && !cardData && (
        <section className="relative z-10 mt-5 w-full max-w-3xl">
          <div className="glass-card border-accent-rose/20 p-5 md:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent-rose/10 text-accent-rose">
                <X size={16} />
              </span>
              <div className="min-w-0">
                <p className="mb-1 text-sm font-semibold text-foreground">提取失败</p>
                <p className="mb-3 text-xs leading-relaxed text-foreground-muted">{error}</p>
                <button
                  type="button"
                  onClick={dismissError}
                  className="min-h-[40px] rounded-lg py-2 text-xs font-medium text-accent-emerald hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-emerald/50"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function LibraryWorkbenchPreview() {
  return (
    <div className="relative animate-fade-up-blur [animation-delay:100ms]">
      <div
        className="absolute -inset-5 -z-10 rounded-[3rem] bg-accent-emerald/[0.06] blur-3xl"
        aria-hidden="true"
      />
      <div className="relative overflow-hidden rounded-[1.75rem] border border-card-border bg-card-bg/90 p-3 shadow-[0_34px_100px_-52px_rgba(48,48,52,0.55)] backdrop-blur-2xl md:rounded-[2rem] md:p-4">
        <div
          className="absolute inset-0 bg-[radial-gradient(circle_at_82%_0%,rgba(48,48,52,0.13),transparent_38%)]"
          aria-hidden="true"
        />

        <header className="relative flex items-center justify-between gap-3 border-b border-card-border/70 px-1 pb-3 md:px-2">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent-emerald/10 text-accent-emerald">
              <Library size={16} />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">我的视频库</p>
              <p className="text-[10px] text-foreground-muted">最近收藏 · 示例预览</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-lg border border-accent-emerald/15 bg-accent-emerald/[0.07] px-2.5 py-1.5 text-[10px] font-semibold text-accent-emerald">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-emerald" />
            文案逐条就绪
          </span>
        </header>

        <div className="relative mt-3 grid gap-3 sm:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
          <section className="min-w-0 rounded-[1.2rem] border border-card-border/70 bg-background/35 p-2.5">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div className="flex rounded-lg bg-card-bg p-0.5 text-[9px] font-medium text-foreground-muted">
                <span className="rounded-md bg-accent-emerald/10 px-2 py-1 text-accent-emerald">
                  收藏
                </span>
                <span className="px-2 py-1">喜欢</span>
                <span className="px-2 py-1">作品</span>
              </div>
              <span className="text-[9px] text-foreground-muted">最近 50 条</span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {PREVIEW_VIDEOS.map((video, index) => (
                <article
                  key={video.title}
                  className="group min-w-0 overflow-hidden rounded-xl border border-card-border/70 bg-card-bg transition-transform duration-200 hover:-translate-y-0.5"
                >
                  <div className="relative aspect-[16/10] overflow-hidden bg-[radial-gradient(circle_at_78%_16%,rgba(48,48,52,0.28),transparent_42%),linear-gradient(145deg,rgba(48,48,52,0.09),rgba(15,23,42,0.12))]">
                    <span className="absolute left-2 top-2 font-mono text-[9px] font-semibold text-foreground-muted/55">
                      0{index + 1}
                    </span>
                    <span className="absolute inset-0 flex items-center justify-center text-accent-emerald/80">
                      <Play size={17} fill="currentColor" />
                    </span>
                    <span className="absolute bottom-1.5 right-1.5 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[8px] text-foreground-secondary backdrop-blur-sm">
                      {video.duration}
                    </span>
                  </div>
                  <div className="p-2">
                    <h3 className="line-clamp-2 min-h-7 text-[10px] font-semibold leading-3.5 text-foreground">
                      {video.title}
                    </h3>
                    <p
                      className={`mt-1.5 text-[8px] font-medium ${
                        video.label === '完整文案'
                          ? 'text-accent-emerald'
                          : 'text-foreground-muted'
                      }`}
                    >
                      {video.label}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="flex min-h-[21rem] min-w-0 flex-col rounded-[1.2rem] border border-card-border/70 bg-background/35 p-3">
            <div className="flex items-center gap-2 border-b border-card-border/60 pb-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-emerald/10 text-accent-emerald">
                <Sparkles size={14} />
              </span>
              <div>
                <p className="text-[11px] font-semibold text-foreground">向整组视频提问</p>
                <p className="text-[9px] text-foreground-muted">完整文案 + 原文依据</p>
              </div>
            </div>

            <div className="flex-1 space-y-2.5 py-3">
              <div className="ml-auto max-w-[88%] rounded-xl rounded-br-sm bg-accent-emerald px-3 py-2 text-[10px] font-medium leading-4 text-white">
                这些视频里，我今天最适合先做什么？
              </div>
              <div className="max-w-[94%] rounded-xl rounded-bl-sm border border-card-border bg-card-bg px-3 py-2.5">
                <p className="text-[10px] leading-4 text-foreground-secondary">
                  先做 10 分钟肩颈训练。两条文案都把“短时、低门槛”列为最容易开始的第一步。
                </p>
                <p className="mt-2 flex items-center gap-1 text-[8px] font-medium text-accent-emerald">
                  <FileText size={9} />
                  已核对 2 条完整文案
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-card-border bg-card-bg px-2.5 py-2">
                <span className="text-accent-emerald"><ListChecks size={13} /></span>
                <span className="text-[9px] font-semibold text-foreground-secondary">生成计划</span>
              </div>
              <div className="flex items-center gap-2 rounded-xl border border-card-border bg-card-bg px-2.5 py-2">
                <span className="text-accent-emerald"><MessageSquare size={13} /></span>
                <span className="text-[9px] font-semibold text-foreground-secondary">保存知识卡</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
