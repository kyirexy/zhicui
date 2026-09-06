'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, BookOpenText, Check, FileText, ListChecks, Pause, Play, Quotes, Sparkle } from '@phosphor-icons/react';
import { LANDING_DEMO as demo } from '@/lib/landingDemo';
import styles from './LandingProductDemo.module.css';

const STEPS = [
  { label: '读文案', Icon: FileText },
  { label: '问重点', Icon: Sparkle },
  { label: '列行动', Icon: ListChecks },
] as const;

export default function LandingProductDemo() {
  const rootRef = useRef<HTMLElement>(null);
  const [step, setStep] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [source, setSource] = useState<number | null>(null);
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (step === 2) setPlaying(false);
      else setStep((current) => current + 1);
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [playing, step]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!('IntersectionObserver' in window)) return () => document.removeEventListener('visibilitychange', onVisibility);
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setPlaying(false);
    });
    if (rootRef.current) observer.observe(rootRef.current);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const selectStep = (next: number) => {
    setPlaying(false);
    setSource(null);
    setStep(next);
  };

  return (
    <section id="demo" ref={rootRef} className={styles.demo} aria-label="知萃交互示例" tabIndex={-1}>
      <header className={styles.topbar}>
        <span className={styles.brand}><img src="/logo.png" alt="" width="23" height="23" /> 知萃工作台</span>
        <span className={styles.exampleLabel}>交互示例</span>
      </header>
      <div className={styles.steps} aria-label="选择演示步骤">
        {STEPS.map(({ label, Icon }, index) => (
          <button key={label} type="button" aria-pressed={step === index} onClick={() => selectStep(index)}>
            <Icon size={17} aria-hidden="true" /><span>{label}</span><small>0{index + 1}</small>
          </button>
        ))}
      </div>
      <div className={styles.content}>
        <div className={styles.sourceCard}>
          <span className={styles.sourceIcon}><BookOpenText size={24} weight="light" aria-hidden="true" /></span>
          <div><small>{demo.sourceLabel}</small><h2>{demo.title}</h2></div>
        </div>
        <div className={styles.panel} aria-live="polite" aria-atomic="true">
          {step === 0 && (
            <div className={styles.transcript}>
              <p className={styles.panelLabel}>原文在这里，随时可以核对</p>
              {demo.paragraphs.map((paragraph, index) => (
                <p key={paragraph}><span>0{index + 1}</span>{paragraph}</p>
              ))}
            </div>
          )}
          {step === 1 && (
            <div className={styles.answer}>
              <div className={styles.question}>{demo.question}<ArrowRight size={18} aria-hidden="true" /></div>
              <div className={styles.answerHeading}><Sparkle size={18} weight="fill" aria-hidden="true" /><span>把重点，变成下一步</span></div>
              <p className={styles.answerLead}>{demo.answer}</p>
              <ol className={styles.points}>
                {demo.points.map((point, index) => (
                  <li key={point.title}>
                    <span className={styles.pointNumber}>0{index + 1}</span>
                    <div><strong>{point.title}</strong><p>{point.detail}</p></div>
                    <button type="button" aria-label={`查看第 ${point.source} 段原文依据`} aria-expanded={source === point.source} onClick={() => { setSource(source === point.source ? null : point.source); setPlaying(false); }}>[{point.source}]</button>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {step === 2 && (
            <div className={styles.plan}>
              <p className={styles.panelLabel}>今日行动 · 示例计划</p>
              <h3>把一条收藏，真正用一次。</h3>
              <div className={styles.progress}><span>已完成 {checked.length} / {demo.tasks.length}</span><progress value={checked.length} max={demo.tasks.length} aria-label="示例计划完成进度" /></div>
              <div className={styles.tasks}>
                {demo.tasks.map((task) => (
                  <label key={task.id}>
                    <input type="checkbox" checked={checked.includes(task.id)} onChange={() => { setPlaying(false); setChecked((current) => current.includes(task.id) ? current.filter((id) => id !== task.id) : [...current, task.id]); }} />
                    <span>{task.title}</span>
                  </label>
                ))}
              </div>
              <p className={styles.planNote}><Check size={15} aria-hidden="true" />可以勾选试试，体验进度变化。</p>
            </div>
          )}
        </div>
        {source !== null && step === 1 && (
          <aside className={styles.evidence} aria-label={`第 ${source} 段原文`}>
            <Quotes size={18} weight="fill" aria-hidden="true" /><p><strong>原文依据 [{source}]</strong>{demo.paragraphs[source - 1]}</p>
          </aside>
        )}
      </div>
      <footer className={styles.footer}>
        <p>原创素材 · 预设回答<br /><span>仅供体验，不调用 AI 或保存数据</span></p>
        <button type="button" onClick={() => { if (playing) setPlaying(false); else { setStep(0); setSource(null); setPlaying(true); } }} aria-label={playing ? '暂停分步演示' : '播放分步演示'}>
          {playing ? <Pause size={15} weight="fill" aria-hidden="true" /> : <Play size={15} weight="fill" aria-hidden="true" />}
          {playing ? '暂停演示' : '播放演示'}
        </button>
      </footer>
    </section>
  );
}
