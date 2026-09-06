'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Pause, Play } from '@phosphor-icons/react';
import { listPublicShowcaseCases, type ShowcaseCase } from '@/lib/showcaseCases';
import LandingRealCase from './LandingRealCase';
import styles from './LandingShowcase.module.css';

export default function LandingShowcase() {
  const [cases, setCases] = useState<ShowcaseCase[]>([]);
  const [industry, setIndustry] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      void listPublicShowcaseCases(signal).then((items) => {
        if (!signal.aborted) setCases(items);
      }).catch(() => {
        // 网络暂不可用时保留已加载内容；初次访问仍可看既有的真实解析案例。
      });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (!cases.length) return <LandingRealCase />;

  const industries = Array.from(new Set(cases.map((item) => item.industry)));
  const currentIndustry = industries.includes(industry) ? industry : '';
  const visibleCases = currentIndustry ? cases.filter((item) => item.industry === currentIndustry) : cases;
  const selected = visibleCases.find((item) => item.id === selectedId) ?? visibleCases[0];

  return (
    <section id="real-case" className={styles.section} aria-labelledby="showcase-title">
      <header className={styles.heading}>
        <div><p>看看大家，怎么把收藏用起来</p><h2 id="showcase-title">不同的工作，<br />都有知识派上用场的时刻。</h2></div>
        <p>真实使用过程，实际留下的成果。<br />找到与你相近的场景，点开看看。</p>
      </header>
      {industries.length > 1 ? (
        <div className={styles.filters} role="group" aria-label="按行业筛选案例">
          {['', ...industries].map((value) => <button key={value} type="button" aria-pressed={currentIndustry === value} onClick={() => { setIndustry(value); setSelectedId(null); }}>{value || '全部行业'}</button>)}
        </div>
      ) : null}
      {visibleCases.length > 1 ? (
        <div className={styles.caseList} role="group" aria-label="选择真实使用案例">
          {visibleCases.map((item) => (
            <button key={item.id} type="button" aria-pressed={selected.id === item.id} aria-controls="showcase-detail" onClick={() => setSelectedId(item.id)}>
              <span>{item.industry}{item.role ? ` / ${item.role}` : ''}</span><strong>{item.title}</strong><ArrowRight size={17} aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
      <article id="showcase-detail" className={styles.detail} key={`${selected.id}-${selected.updated_at}`} aria-labelledby={`case-title-${selected.id}`}>
        <div className={styles.visual}>
          <div className={styles.mediaLabel}><span>{selected.industry} · 实际使用记录</span><span>{selected.media_type === 'image/gif' ? 'GIF 动图' : '视频演示'}</span></div>
          <CaseMedia item={selected} />
          <p className={styles.caption}>{selected.source_label || '案例提供者的实际使用记录'}{selected.person_name ? ` · ${selected.person_name}` : ''}{selected.role ? ` / ${selected.role}` : ''}</p>
          {selected.source_url ? <a className={styles.sourceLink} href={selected.source_url} target="_blank" rel="noopener noreferrer">查看案例来源 <ArrowUpRight size={15} aria-hidden="true" /></a> : null}
        </div>
        <div className={styles.copy}>
          <p className={styles.kicker}>{selected.industry}{selected.role ? ` / ${selected.role}` : ''}</p>
          <h3 id={`case-title-${selected.id}`}>{selected.title}</h3>
          <p className={styles.summary}>{selected.summary}</p>
          <dl className={styles.story}>
            {selected.challenge ? <div><dt>遇到的问题</dt><dd>{selected.challenge}</dd></div> : null}
            {selected.workflow ? <div><dt>用知萃怎么做</dt><dd>{selected.workflow}</dd></div> : null}
            {selected.outcome ? <div className={styles.outcome}><dt>最后留下了什么</dt><dd>{selected.outcome}</dd></div> : null}
          </dl>
          <a className={styles.tryLink} href="#download">把你的收藏，也用起来 <ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </article>
    </section>
  );
}

function CaseMedia({ item }: { item: ShowcaseCase }) {
  const [playingGif, setPlayingGif] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stop = () => {
      videoRef.current?.pause();
      setPlayingGif(false);
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') stop(); };
    const observer = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) stop();
    }) : undefined;
    if (mediaRef.current) observer?.observe(mediaRef.current);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);

  return (
    <div className={styles.media} ref={mediaRef}>
      {failed || !item.media_url ? (
        <div className={styles.mediaError}><p>演示暂时未能加载</p><span>可以先阅读这个案例的使用过程。</span><button type="button" onClick={() => { setFailed(false); setPlayingGif(false); }}>重新加载</button></div>
      ) : item.media_type === 'video/mp4' ? (
        <video ref={videoRef} controls playsInline preload="none" poster={item.poster_url || undefined} src={item.media_url} aria-label={`${item.title}：实际使用视频`} onError={() => setFailed(true)} />
      ) : playingGif ? (
        <div className={styles.gifView}><img src={item.media_url} alt={`${item.title}：实际操作动图`} onError={() => setFailed(true)} /><button type="button" className={styles.pause} onClick={() => setPlayingGif(false)}><Pause size={15} weight="fill" aria-hidden="true" />停止动图</button></div>
      ) : (
        <button type="button" className={styles.gifStart} onClick={() => setPlayingGif(true)} aria-label={`播放动图：${item.title}`}>
          {item.poster_url ? <img src={item.poster_url} alt="" loading="lazy" /> : <strong>{item.title}</strong>}
          <span><Play size={16} weight="fill" aria-hidden="true" />点击播放真实操作</span>
        </button>
      )}
    </div>
  );
}
