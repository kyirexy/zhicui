'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, ArrowsClockwise, CalendarBlank, Check, ChatCircleDots, Pause, Play, UsersThree } from '@phosphor-icons/react';
import Link from 'next/link';
import styles from './LandingProductDemo.module.css';

const MODES = [
  { label: '同步视频', Icon: ArrowsClockwise },
  { label: '昨日回顾', Icon: CalendarBlank },
  { label: '博主问答', Icon: UsersThree },
] as const;

// 公开博主展示使用已核验的目录元数据；不把不同作者的视频拼成“博主作品”。
const creatorVideos = ['快速排序教学'];

export default function LandingProductDemo() {
  const [mode, setMode] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedVideos, setSelectedVideos] = useState<number[]>([0]);
  const [synced, setSynced] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (mode === MODES.length - 1) setPlaying(false);
      else setMode((current) => current + 1);
    }, 4200);
    return () => window.clearTimeout(timer);
  }, [playing, mode]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const selectMode = (next: number) => { setPlaying(false); setMode(next); };
  const toggleVideo = (index: number) => setSelectedVideos((current) => current.includes(index)
    ? current.filter((item) => item !== index)
    : [...current, index]);

  return (
    <section id="demo" className={styles.demo} aria-label="知萃真实功能演示" tabIndex={-1}>
      <header className={styles.topbar}>
        <span className={styles.brand}><img src="/logo.png" alt="" width="23" height="23" /> 知萃工作台</span>
        <span className={styles.exampleLabel}>功能演示 · 抖音 / B站</span>
      </header>
      <div className={styles.steps} aria-label="选择功能演示">
        {MODES.map(({ label, Icon }, index) => (
          <button key={label} type="button" aria-pressed={mode === index} onClick={() => selectMode(index)}>
            <Icon size={17} aria-hidden="true" /><span>{label}</span><small>0{index + 1}</small>
          </button>
        ))}
      </div>
      <div className={styles.content}>
        <div className={styles.panel} aria-live="polite" aria-atomic="true">
          <div aria-hidden={mode !== 0} inert={mode !== 0}>
            <div className={styles.realPanel}>
            <div className={styles.panelIntro}><span className={styles.panelEyebrow}>平台同步</span><h2>把喜欢和收藏，自动整理成资料</h2><p>目前支持抖音、B站，Windows 端可直接同步账号内容。</p></div>
            <div className={styles.platformRows}>
              <div className={styles.platformRow}><span className={styles.platformBadge}>抖</span><span><strong>抖音</strong><small>喜欢 · 收藏 · 作品</small></span><span className={styles.connected}>{synced ? '已同步' : '可同步'}</span></div>
              <div className={styles.platformRow}><span className={`${styles.platformBadge} ${styles.biliBadge}`}>哔</span><span><strong>B站</strong><small>收藏 · 喜欢 · 导入视频</small></span><span className={styles.connected}>{synced ? '已同步' : '可同步'}</span></div>
            </div>
            <div className={styles.syncProgress}><span style={{ width: synced ? '100%' : '42%' }} /></div>
            <div className={styles.panelActions}><button type="button" className={styles.primaryButton} onClick={() => setSynced(true)}><ArrowsClockwise size={16} />{synced ? '同步完成' : '开始同步'}</button><Link href="/library?sync=1">打开同步页 <ArrowRight size={15} /></Link></div>
            </div>
          </div>
          <div aria-hidden={mode !== 1} inert={mode !== 1}>
            <div className={styles.realPanel}>
            <div className={styles.panelIntro}><span className={styles.panelEyebrow}>昨日回顾 · 9月20日</span><h2>昨天新增的内容，都在这里</h2><p>按首次同步记录整理，已有文稿会直接复用。</p></div>
            <div className={styles.recapStats}><strong>12 条视频</strong><span>♡ 喜欢 8</span><span>▣ 收藏 4</span></div>
            <div className={styles.recapItems}><div><span>抖音</span><strong>世界健体第六名：完整训练计划</strong><small>文案已就绪</small></div><div><span>B站</span><strong>如何安排一周学习计划？</strong><small>等待提取</small></div></div>
            <div className={styles.panelActions}><Link href="/library?sync=1" className={styles.primaryButton}><Check size={16} />一键提取解析</Link><a href="#demo" onClick={() => selectMode(0)}>继续同步 <ArrowRight size={15} /></a></div>
            </div>
          </div>
          <div aria-hidden={mode !== 2} inert={mode !== 2}>
            <div className={styles.realPanel}>
            <div className={styles.panelIntro}><span className={styles.panelEyebrow}>博主作品 · 多选问答</span><h2>选一个博主，批量读懂他的作品</h2><p>已发现 90 条公开作品，选择视频后按需提取并提问。</p></div>
            <div className={styles.creatorHeader}><span className={styles.creatorAvatar}>GG</span><span><strong>GGBond的小课堂</strong><small>抖音 · 已核验的公开博主</small></span><span className={styles.creatorVerified}>真实目录</span></div>
            <div className={styles.creatorFacts} aria-label="博主目录信息"><div><strong>90</strong><small>公开作品</small></div><div><strong>按需</strong><small>提取文稿</small></div><div><strong>{selectedVideos.length}</strong><small>已选作品</small></div></div>
            <div className={styles.creatorVideos}>{creatorVideos.map((title, index) => <label key={title}><input type="checkbox" checked={selectedVideos.includes(index)} onChange={() => toggleVideo(index)} /><span>{title}</span><small>可提取</small></label>)}</div>
            <p className={styles.creatorNote}>目录只展示这位博主的公开作品，选中后再提取文稿，不混入其他作者内容。</p>
            <div className={styles.panelActions}><Link href="/library/creators" className={styles.primaryButton}><ChatCircleDots size={16} />用 {selectedVideos.length} 条视频提问</Link><Link href="/library/creators">查看全部作品 <ArrowRight size={15} /></Link></div>
            </div>
          </div>
        </div>
      </div>
      <footer className={styles.footer}>
        <p>点击上方标签，查看三项核心功能<br /><span>支持抖音和 B站 · 进入后使用真实数据</span></p>
        <button type="button" onClick={() => { if (playing) setPlaying(false); else { setMode(0); setPlaying(true); } }} aria-label={playing ? '暂停分步演示' : '播放分步演示'}>
          {playing ? <Pause size={15} weight="fill" aria-hidden="true" /> : <Play size={15} weight="fill" aria-hidden="true" />}
          {playing ? '暂停演示' : '播放演示'}
        </button>
      </footer>
    </section>
  );
}
