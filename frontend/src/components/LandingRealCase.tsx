'use client';

import { useState } from 'react';
import { ArrowUpRight, FileText, Play, Quotes } from '@phosphor-icons/react';
import styles from './LandingRealCase.module.css';

// 公开来源已在 2026-09-06 核对；片段与既有解析结果逐字一致。
// 仅引用公开内容，不输出账号 ID、笔记 ID、签名媒体地址或私有问答。
const CASE = {
  title: '独游绕不过的高山 游戏好玩的关键问题',
  author: '分裂细胞官方',
  url: 'https://www.bilibili.com/video/BV112V868E5S/',
  embed: 'https://player.bilibili.com/player.html?bvid=BV112V868E5S&autoplay=0',
  excerpt: '因为玩家很多时候不是因为成长而快乐，而是因为感觉到自己正在成长才快乐。这俩东西差别特别大，很多独立游戏的问题就在这里，开发者觉得我已经给玩家加属性了啊，但玩家根本没感觉',
  sections: [
    { title: '心流的本质与游戏沉迷', content: '心流是玩家持续投入游戏的核心机制，它并非单纯的“爽”，而是一种深度沉浸的状态。玩家在游戏中感到“我快不行了”但“还有可能赢”的临界感，是心流的关键。' },
    { title: '心流循环与反馈设计', content: '游戏心流本质上是一个循环：目标→行动→反馈→再行动。反馈是循环中最重要的一环，因为玩家快乐源于“感觉到自己正在成长”，而非单纯的数值增长。' },
  ],
  conclusion: '反馈设计比数值成长更重要，玩家需要“感觉到自己在变强”而非仅仅变强。',
};

export default function LandingRealCase() {
  const [showVideo, setShowVideo] = useState(false);
  return (
    <section id="real-case" className={styles.section} aria-labelledby="real-case-title">
      <header className={styles.heading}><div><p>真实内容，实际整理结果</p><h2 id="real-case-title">一条真实视频，<br />整理后是这样。</h2></div><p>这是知萃已有的一次解析记录。<br />原文和生成结果，放在一起看。</p></header>
      <div className={styles.comparison}>
        <article className={styles.source}>
          <div className={styles.label}><span>01 / 原视频</span><span>哔哩哔哩 · 06:38</span></div>
          <div className={styles.video}>
            {showVideo ? <iframe src={CASE.embed} title={CASE.title} allow="fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <button type="button" onClick={() => setShowVideo(true)} aria-label="播放真实案例原视频"><span className={styles.videoTopic}>游戏设计 / 玩家心理</span><strong>为什么有些游戏，<br />让人停不下来？</strong><span className={styles.play}><Play size={15} weight="fill" aria-hidden="true" /> 播放原视频</span></button>}
          </div>
          <h3>{CASE.title}</h3>
          <p className={styles.author}>{CASE.author} · 原视频作者</p>
          <a href={CASE.url} target="_blank" rel="noopener noreferrer">去 B 站看原视频 <ArrowUpRight size={15} aria-hidden="true" /></a>
          <details className={styles.excerpt}><summary>对照一段原文</summary><blockquote><Quotes size={17} aria-hidden="true" /><p>{CASE.excerpt}</p></blockquote></details>
        </article>
        <article className={styles.result}>
          <div className={styles.label}><span><FileText size={15} aria-hidden="true" />02 / 知萃知识卡片</span><span>实际生成 · 节选</span></div>
          <h3>玩家真正沉迷的不是爽，而是‘我还能再来一把’的状态。</h3>
          {CASE.sections.map((section) => <section key={section.title}><h4>{section.title}</h4><p>{section.content}</p></section>)}
          <div className={styles.conclusion}><span>留下一条关键结论</span><p>{CASE.conclusion}</p></div>
        </article>
      </div>
      <p className={styles.note}>公开视频与文案仅作案例引用；卡片为既有 AI 生成结果节选，可结合原视频核对。播放器点击后才加载。</p>
    </section>
  );
}
