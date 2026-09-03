'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowSquareOut,
  CheckCircle,
  PlayCircle,
  StackSimple,
} from '@phosphor-icons/react';
import InputBar from '@/components/InputBar';
import { useExtraction } from '@/lib/hooks/ExtractionContext';
import { buildBilibiliEmbedUrl, buildVideoDetailHref, shouldOpenExtractedVideo } from '@/lib/singleLinkImport';
import styles from './SingleLinkExtract.module.css';

const PipelineProgress = dynamic(() => import('@/components/PipelineProgress'));

const WORKFLOW_STEPS = [
  {
    title: '读取视频内容',
    description: '识别标题、作者和可用的视频内容。',
  },
  {
    title: '提取文稿与总结',
    description: '整理完整文稿，并生成便于浏览的内容总结。',
  },
  {
    title: '打开视频资料',
    description: '完成后直接进入原视频、文稿和提问界面。',
  },
] as const;

export default function SingleLinkExtractPage() {
  const router = useRouter();
  const navigationArmedRef = useRef(false);
  const observedLoadingRef = useRef(false);
  const incomingUrlHandledRef = useRef(false);
  const [openingVideo, setOpeningVideo] = useState(false);
  const [completedWithoutId, setCompletedWithoutId] = useState(false);
  const {
    isLoading,
    error,
    cardData,
    previewVideo,
    transcript,
    progressSteps,
    startExtraction,
    clearCard,
    dismissError,
  } = useExtraction();
  const bilibiliEmbedUrl = previewVideo?.platform === 'bilibili'
    ? buildBilibiliEmbedUrl(previewVideo.video_id)
    : null;

  const handleSubmit = useCallback((url: string) => {
    navigationArmedRef.current = true;
    observedLoadingRef.current = false;
    setCompletedWithoutId(false);
    setOpeningVideo(false);
    startExtraction(url);
  }, [startExtraction]);

  useEffect(() => {
    if (incomingUrlHandledRef.current) return;
    const currentUrl = new URL(window.location.href);
    const incomingUrl = currentUrl.searchParams.get('url')?.trim();
    if (!incomingUrl) return;
    incomingUrlHandledRef.current = true;
    currentUrl.searchParams.delete('url');
    window.history.replaceState(window.history.state, '', `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    handleSubmit(incomingUrl);
  }, [handleSubmit]);

  useEffect(() => {
    if (navigationArmedRef.current && isLoading) {
      observedLoadingRef.current = true;
      return;
    }
    if (!navigationArmedRef.current || !observedLoadingRef.current || isLoading) return;
    if (error) {
      navigationArmedRef.current = false;
      observedLoadingRef.current = false;
      return;
    }
    if (!cardData) return;
    if (shouldOpenExtractedVideo({
      armed: navigationArmedRef.current,
      observedLoading: observedLoadingRef.current,
      isLoading,
      noteId: cardData.id,
    })) {
      navigationArmedRef.current = false;
      observedLoadingRef.current = false;
      setOpeningVideo(true);
      router.replace(buildVideoDetailHref(cardData.id!));
      return;
    }
    navigationArmedRef.current = false;
    observedLoadingRef.current = false;
    setCompletedWithoutId(true);
  }, [cardData, error, isLoading, router]);

  const handleCancelOrReset = useCallback(() => {
    navigationArmedRef.current = false;
    observedLoadingRef.current = false;
    setOpeningVideo(false);
    setCompletedWithoutId(false);
    clearCard();
  }, [clearCard]);

  return (
    <div className={styles.page}>
      <nav className={styles.topbar} aria-label="页面路径">
        <div className={styles.breadcrumb}>
          <Link href="/">首页</Link>
          <ArrowRight size={13} aria-hidden="true" />
          <span aria-current="page">单条解析</span>
        </div>
        <Link href="/library?sync=1" className={styles.batchLink}>
          <StackSimple size={18} weight="regular" aria-hidden="true" />
          <span>批量同步视频</span>
          <ArrowRight size={14} weight="bold" aria-hidden="true" />
        </Link>
      </nav>

      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p>单条内容入口</p>
          <h1>导入这一条视频，直接看原视频和完整文稿</h1>
          <p>
            粘贴链接后，知萃会整理完整文稿与总结。完成后自动打开这条视频的资料页，可以播放原视频、查看文稿并继续提问。
          </p>
        </div>
        <ul className={styles.guarantees} aria-label="处理说明">
          <li><CheckCircle size={17} weight="fill" aria-hidden="true" />只处理当前链接</li>
          <li><CheckCircle size={17} weight="fill" aria-hidden="true" />完成后直接打开原视频</li>
          <li><CheckCircle size={17} weight="fill" aria-hidden="true" />不永久保存视频文件</li>
        </ul>
      </header>

      <section className={styles.workspace} aria-labelledby="single-link-start-title">
        <div className={styles.workspaceHeader}>
          <span className={styles.stepIndex} aria-hidden="true">01</span>
          <div>
            <h2 id="single-link-start-title">粘贴视频链接</h2>
            <p>支持抖音、B站及其他常见视频页面</p>
          </div>
          {(completedWithoutId || error) && !isLoading ? (
            <button type="button" onClick={handleCancelOrReset} className={styles.resetButton}>
              <ArrowCounterClockwise size={17} aria-hidden="true" />
              解析另一条
            </button>
          ) : null}
        </div>

        <div className={styles.composer}>
          <InputBar
            onSubmit={handleSubmit}
            isLoading={isLoading}
            error={error}
            showPlatformHint={false}
            variant="workspace"
            placeholder="粘贴抖音或 B站视频链接…"
            submitLabel="开始解析"
            loadingLabel="正在导入"
          />
        </div>

        <div className={styles.composerMeta}>
          <div className={styles.platforms} aria-label="支持的平台">
            <span>支持</span>
            <strong>抖音</strong>
            <i aria-hidden="true" />
            <strong>B站</strong>
            <i aria-hidden="true" />
            <strong>常见视频链接</strong>
          </div>
          <span>每次解析 1 条</span>
        </div>

        {error ? (
          <div className={styles.errorAction}>
            <button type="button" onClick={dismissError}>关闭提示</button>
          </div>
        ) : null}

        <ol className={styles.processRail} aria-label="单条解析流程">
          {WORKFLOW_STEPS.map((step, index) => (
            <li key={step.title}>
              <span className={styles.railNumber}>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {previewVideo ? (
        <section className={styles.preview} aria-labelledby="single-link-video-title">
          <div className={styles.videoStage}>
            {bilibiliEmbedUrl ? (
              <iframe src={bilibiliEmbedUrl} title={`播放视频：${previewVideo.title}`} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
            ) : previewVideo.media_url ? (
              <video src={previewVideo.media_url} poster={previewVideo.cover_url || undefined} controls playsInline preload="metadata" aria-label={`播放视频：${previewVideo.title}`} />
            ) : previewVideo.cover_url ? (
              <img src={previewVideo.cover_url} alt={`${previewVideo.title} 视频封面`} referrerPolicy="no-referrer" />
            ) : (
              <div className={styles.videoUnavailable}><PlayCircle size={36} /><span>视频地址正在准备</span></div>
            )}
          </div>
          <div className={styles.previewInfo}>
            <p>{previewVideo.platform === 'bilibili' ? 'B站' : previewVideo.platform === 'douyin' ? '抖音' : previewVideo.platform}</p>
            <h2 id="single-link-video-title">{previewVideo.title}</h2>
            {previewVideo.author_name ? <span>{previewVideo.author_name}</span> : null}
            <a href={previewVideo.source_url} target="_blank" rel="noreferrer">打开原页面 <ArrowSquareOut size={14} /></a>
          </div>
        </section>
      ) : null}

      {transcript ? (
        <section className={styles.transcript} aria-labelledby="single-link-transcript-title">
          <header>
            <div><p>文稿已提取</p><h2 id="single-link-transcript-title">完整文稿</h2></div>
            <span>{transcript.length.toLocaleString('zh-CN')} 字</span>
          </header>
          <div className={styles.transcriptBody}>{transcript}</div>
        </section>
      ) : null}

      {isLoading ? (
        <section className={styles.activity} aria-labelledby="single-link-progress-title" aria-live="polite">
          <header>
            <div>
              <p>正在处理</p>
              <h2 id="single-link-progress-title">单条解析进度</h2>
            </div>
            <button type="button" onClick={handleCancelOrReset}>取消导入</button>
          </header>
          <div className={styles.progressSurface}>
            <PipelineProgress steps={progressSteps} />
          </div>
        </section>
      ) : null}

      {openingVideo ? (
        <section className={styles.opening} role="status" aria-live="polite">
          <span aria-hidden="true"><PlayCircle size={22} weight="fill" /></span>
          <div><strong>视频资料已准备好</strong><p>正在打开原视频、完整文稿和总结…</p></div>
        </section>
      ) : null}

      {completedWithoutId ? (
        <section className={styles.opening} role="status">
          <span aria-hidden="true"><CheckCircle size={22} weight="fill" /></span>
          <div><strong>视频已经保存</strong><p>暂时无法自动定位这一条，可以从视频资料中打开。</p></div>
          <Link href="/library">前往视频资料 <ArrowRight size={14} aria-hidden="true" /></Link>
        </section>
      ) : null}
    </div>
  );
}
