'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, ArrowsClockwise, CalendarBlank, Check, ChatCircleDots, LinkSimple, Pause, Play, Sparkle, UsersThree } from '@phosphor-icons/react';
import Link from 'next/link';
import PlatformBrandIcon from './PlatformBrandIcon';
import styles from './LandingProductDemo.module.css';

const MODES = [
  { label: '批量同步', Icon: ArrowsClockwise, steps: ['连接账号', '同步喜欢 / 收藏', 'AI 全部解析'] },
  { label: '今日 / 昨日回顾', Icon: CalendarBlank, steps: ['选择日期', '同步并提取', '总结与追问'] },
  { label: '视频生成计划', Icon: Sparkle, steps: ['粘贴视频', '提取文稿', '生成计划'] },
  { label: '博主批量问答', Icon: UsersThree, steps: ['粘贴主页', '批量提取', '多视频问答'] },
] as const;

// 全部内容均为演示样本；界面与操作顺序对应客户端，不调用用户账号或收费解析接口。
const creatorVideos = ['快速排序教学', '二分查找：如何缩小问题范围', '递归思维：把复杂问题拆开'];
const batchScopes = [
  { platform: 'douyin', label: '喜欢', count: 24 },
  { platform: 'douyin', label: '收藏', count: 18 },
  { platform: 'bilibili', label: '收藏', count: 8 },
] as const;
const TYPE_MS = 32;
const MESSAGE_GAP_MS = 480;
const RESULT_HOLD_MS = 3000;
const CHAT_START = [0, 6600, 5700, 8000];
type DemoMessage = { role: 'user' | 'assistant'; text: string };
const DIALOGUES: DemoMessage[][] = [
  [],
  [
    { role: 'assistant', text: '已读完这批喜欢与收藏，主要围绕排序、查找和递归。共同方法是先缩小问题，再拆成可重复的小步骤。建议从二分查找开始练习。[1][2]' },
    { role: 'user', text: '零基础的话，今天应该先做什么？' },
    { role: 'assistant', text: '先用 20 分钟在有序数组里手动查找数字，每轮划掉一半，再试着写出循环条件。这对应第 2 条视频的方法。[2]' },
  ],
  [
    { role: 'user', text: '把这个视频整理成一份三天的学习计划。' },
    { role: 'assistant', text: '可以。我已把视频中的“理解原理 → 手动推演 → 独立实现”拆成三天任务，每天约 20 分钟，并保留视频依据。[1]' },
    { role: 'user', text: '如果第一天只有十分钟呢？' },
    { role: 'assistant', text: '第一天先完成一次手动推演，把边界情况留到第二天。你可以直接编辑计划中的任务和时长。' },
  ],
  [
    { role: 'user', text: '这三条视频有什么共同思路？应该按什么顺序学？' },
    { role: 'assistant', text: '共同思路是把大问题逐步缩小。建议先学二分查找，再理解递归，最后用快速排序串起分治思维。[2][3][1]' },
    { role: 'user', text: '能把递归的停止条件讲得简单一点吗？' },
    { role: 'assistant', text: '就像拆盒子，遇到最小、无需再拆的盒子就停。第 3 条视频里的“问题已能直接求解”就是停止条件。[3]' },
  ],
];
const messageDuration = (message: DemoMessage) => message.text.length * TYPE_MS + MESSAGE_GAP_MS;
const chatDuration = (messages: DemoMessage[]) => messages.reduce((total, message) => total + messageDuration(message), 0);
const FLOW_DURATIONS = [13500, ...[1, 2, 3].map((mode) => CHAT_START[mode] + chatDuration(DIALOGUES[mode]) + RESULT_HOLD_MS)];
const PLAN_READY_AT = CHAT_START[2] + chatDuration(DIALOGUES[2].slice(0, 2));
const percentBetween = (elapsed: number, start: number, end: number) => Math.max(0, Math.min(100, Math.floor((elapsed - start) / (end - start) * 100)));

function ExtractionProgress({ elapsed, start, end, total, label }: { elapsed: number; start: number; end: number; total: number; label: string }) {
  const percent = percentBetween(elapsed, start, end);
  const completed = Math.floor(total * percent / 100);
  return <div className={styles.batchPanel}>
    <div className={styles.analysisSummary}><span className={styles.analysisIcon}>{percent === 100 ? <Check size={15} /> : <ArrowsClockwise size={15} />}</span><div><strong>{label}</strong><small>{percent === 100 ? '已完成，现在可以查看或提问' : elapsed < start ? '准备开始' : '正在处理，完成的文稿会自动保存'}</small></div><strong>{completed}/{total}</strong></div>
    <div className={styles.syncProgress} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}><span style={{ width: `${percent}%` }} /></div>
  </div>;
}

function Conversation({ mode, elapsed, sourceCount = mode === 2 ? 1 : 3 }: { mode: number; elapsed: number; sourceCount?: number }) {
  let startsAt = CHAT_START[mode];
  return <div className={styles.chatStream} aria-label="模拟流式问答">
    <div className={styles.chatHeading}><ChatCircleDots size={15} /><strong>知萃 AI</strong><span>已读取 {sourceCount} 条视频资料</span></div>
    {DIALOGUES[mode].map((message, index) => {
      const start = startsAt;
      startsAt += messageDuration(message);
      if (elapsed < start) return null;
      const count = Math.floor((elapsed - start) / TYPE_MS);
      const streamQuestion = message.role === 'user' ? message.text.slice(0, count) : '';
      const streamAnswer = message.role === 'assistant' ? message.text.slice(0, count) : '';
      return <div key={index} className={message.role === 'user' ? styles.userMessage : styles.aiMessage}>
        <small>{message.role === 'user' ? '我' : '知萃 AI'}</small>
        <p>{streamQuestion || streamAnswer}{count < message.text.length && <span className={styles.streamCursor} aria-hidden="true" />}</p>
      </div>;
    })}
  </div>;
}

function UrlInput({ elapsed, creator = false }: { elapsed: number; creator?: boolean }) {
  const value = creator ? 'https://www.douyin.com/user/GGBond' : 'https://www.bilibili.com/video/BV1…';
  const typed = value.slice(0, Math.floor(elapsed / 34));
  return <div className={styles.creatorLinkBar}><LinkSimple size={16} /><span>{typed || (creator ? '粘贴博主主页链接…' : '粘贴视频链接…')}{typed.length < value.length && <span className={styles.streamCursor} aria-hidden="true" />}</span><strong>{elapsed < 1600 ? '粘贴链接' : creator ? '读取作品' : '开始解析'}</strong></div>;
}

export default function LandingProductDemo() {
  const [mode, setMode] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [visible, setVisible] = useState(true);
  const [reviewDay, setReviewDay] = useState<'today' | 'yesterday'>('today');

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    // 只累计可见页面的播放时间；暂停、切换标签、返回页面都不会跳过未播完的文字。
    const timer = window.setInterval(() => setElapsed((current) => current + 40), 40);
    return () => window.clearInterval(timer);
  }, [playing, visible]);

  useEffect(() => {
    if (elapsed < FLOW_DURATIONS[mode]) return;
    setMode((current) => (current + 1) % MODES.length);
    setElapsed(0);
  }, [elapsed, mode]);

  const selectMode = (next: number) => { setMode(next); setElapsed(0); setPlaying(true); };
  const replay = () => { setElapsed(0); setPlaying(true); };
  const changeDay = (day: 'today' | 'yesterday') => { setReviewDay(day); setElapsed(0); setPlaying(true); };
  const stage = mode === 0 ? elapsed < 1800 ? 0 : elapsed < 5300 ? 1 : 2
    : mode === 1 ? elapsed < 1600 ? 0 : elapsed < CHAT_START[1] ? 1 : 2
      : mode === 2 ? elapsed < 1600 ? 0 : elapsed < CHAT_START[2] ? 1 : 2
        : elapsed < 2600 ? 0 : elapsed < CHAT_START[3] ? 1 : 2;
  const today = reviewDay === 'today';

  return <section id="demo" className={styles.demo} aria-label="知萃客户端流程演示" tabIndex={-1}>
    <header className={styles.topbar}><span className={styles.brand}><img src="/logo.png" alt="" width="23" height="23" />知萃工作台</span><span className={styles.exampleLabel}>客户端流程 · 示例数据</span></header>
    <div className={styles.steps} aria-label="选择功能演示">{MODES.map(({ label, Icon }, index) => <button key={label} type="button" aria-pressed={mode === index} onClick={() => selectMode(index)}><Icon size={17} aria-hidden="true" /><span>{label}</span></button>)}</div>
    <div className={styles.stageRail} aria-label="当前流程步骤">{MODES[mode].steps.map((label, index) => <span key={label} data-active={stage === index} data-done={stage > index}><i>{stage > index ? <Check size={11} /> : index + 1}</i>{mode === 1 && !today && index === 1 ? '补齐昨日文稿' : label}{index < 2 && <ArrowRight size={11} />}</span>)}</div>
    <div className={styles.content}><div className={styles.panel}>
      <div aria-hidden={mode !== 0} inert={mode !== 0}>
        <div className={styles.panelIntro}><span className={styles.panelEyebrow}>客户端 · 批量读取</span><h2>喜欢与收藏，一次同步到资料库</h2><p>选择账号和范围，批量读取文稿，再交给 AI 全部解析。</p></div>
        <div className={styles.scene}>
          <div className={styles.platformRows}>{(['douyin', 'bilibili'] as const).map((platform) => <div className={styles.platformRow} data-platform={platform} key={platform}><span className={styles.platformBadge}><PlatformBrandIcon platform={platform} size={23} /></span><span><strong>{platform === 'douyin' ? '抖音' : 'B站'}</strong><small>演示账号 · {platform === 'douyin' ? '喜欢与收藏' : '收藏夹'}</small></span><span className={styles.connected}>{elapsed < 1800 ? '已连接' : elapsed < 5300 ? '正在同步…' : '同步完成'}</span></div>)}</div>
          <div className={styles.batchPanelHeader}><strong>本次读取范围</strong><span>共 50 条</span></div>
          <div className={styles.scopeGrid}>{batchScopes.map(({ platform, label, count }) => <span className={styles.scopeChip} data-selected={elapsed >= 800} key={`${platform}:${label}`}><Check size={12} /><PlatformBrandIcon platform={platform} size={13} />{label} <small>{count}</small></span>)}</div>
          <ExtractionProgress elapsed={elapsed} start={1800} end={5300} total={50} label="同步喜欢与收藏" />
          <ExtractionProgress elapsed={elapsed} start={5500} end={10000} total={50} label="AI 全部解析" />
          <div className={styles.resultNotice} data-ready={elapsed >= 10000}><Check size={16} /><span>{elapsed >= 10000 ? '50 条资料已就绪，文稿和 AI 重点已保存' : '同步后自动开始解析，无需逐条打开视频'}</span></div>
        </div>
      </div>
      <div aria-hidden={mode !== 1} inert={mode !== 1}>
        <div className={styles.panelIntro}><span className={styles.panelEyebrow}>每日回顾 · 一键解析并提问</span><h2>{today ? '今天' : '昨天'}收藏了什么？让 AI 先帮你总结</h2><p>今日先同步新增内容，昨日读取已有记录；补齐文稿后进入知萃 AI 追问。</p></div>
        <div className={styles.scene}>
          <div className={styles.reviewToggle} role="tablist" aria-label="选择回顾日期"><button type="button" role="tab" aria-selected={today} onClick={() => changeDay('today')}>今日新增</button><button type="button" role="tab" aria-selected={!today} onClick={() => changeDay('yesterday')}>昨日回顾</button><span>{today ? '喜欢 4 · 收藏 2' : '喜欢 8 · 收藏 4'}</span></div>
          {elapsed < CHAT_START[1] ? <>
            <div className={styles.recapStats}><CalendarBlank size={21} /><strong>{today ? '今日分析' : '昨日回顾'}</strong><span>{today ? '6' : '12'} 条视频</span></div>
            <div className={styles.recapItems}>{creatorVideos.map((title, index) => <div key={title}><PlatformBrandIcon platform={index === 1 ? 'bilibili' : 'douyin'} size={17} /><strong>{title}</strong><small>{elapsed > 3900 + index * 650 ? '文稿已就绪' : index === 0 ? '复用已有文稿' : '等待提取'}</small></div>)}</div>
            <ExtractionProgress elapsed={elapsed} start={1600} end={5800} total={today ? 6 : 12} label={elapsed < 3100 ? today ? '同步今日新增喜欢与收藏' : '读取昨日已同步记录' : '提取文稿并准备总结'} />
            <div className={styles.resultNotice}><ChatCircleDots size={16} />{elapsed < 5800 ? '一键解析并提问 · 正在自动准备资料' : '资料已齐，正在进入知萃 AI…'}</div>
          </> : <Conversation mode={1} elapsed={elapsed} sourceCount={today ? 6 : 12} />}
        </div>
      </div>
      <div aria-hidden={mode !== 2} inert={mode !== 2}>
        <div className={styles.panelIntro}><span className={styles.panelEyebrow}>视频 → 文稿 → 行动计划</span><h2>看完一个视频，带走一份可执行的计划</h2><p>粘贴视频链接，提取内容，告诉 AI 你的目标，再继续调整。</p></div>
        <div className={styles.scene}>
          {elapsed < CHAT_START[2] ? <>
            <UrlInput elapsed={elapsed} />
            <div className={styles.videoPreview}><span><PlatformBrandIcon platform="bilibili" size={28} /></span><div><strong>二分查找：从理解到独立实现</strong><small>B站 · 教学视频 · 演示样本</small></div></div>
            <ExtractionProgress elapsed={elapsed} start={1600} end={5000} total={1} label={elapsed < 3200 ? '读取视频并提取文稿' : '整理知识点与原文依据'} />
            <div className={styles.transcriptPreview}><small>文稿预览</small><p>{'每次比较中间位置，就能排除一半不可能的答案。练习时先手动画出左右边界，再把步骤写成循环。'.slice(0, Math.max(0, Math.floor((elapsed - 3000) / 35))) || '解析完成后，完整文稿会保存在资料中。'}</p></div>
          </> : <>
            <Conversation mode={2} elapsed={elapsed} />
            {elapsed >= PLAN_READY_AT && <div className={styles.planPreview}><strong><Check size={15} />行动计划已生成 · 3 天</strong><span>第 1 天　理解原理，手动推演一次</span><span>第 2 天　练习边界，完成两个例子</span><span>第 3 天　独立实现，再检查结果</span><small>每天约 20 分钟 · 可编辑任务</small></div>}
          </>}
        </div>
      </div>
      <div aria-hidden={mode !== 3} inert={mode !== 3}>
        <div className={styles.panelIntro}><span className={styles.panelEyebrow}>博主作品 · 一键提取并提问</span><h2>粘贴博主主页，批量读懂他的作品</h2><p>读取作品目录，选择视频批量提取，再围绕多条内容一起问。</p></div>
        <div className={styles.scene}>
          {elapsed < CHAT_START[3] ? <>
            <UrlInput elapsed={elapsed} creator />
            <div className={styles.creatorHeader} data-ready={elapsed >= 2200}><span className={styles.creatorAvatar}>GG</span><span><strong>{elapsed >= 2200 ? 'GGBond的小课堂' : '正在识别博主主页…'}</strong><small>{elapsed >= 2200 ? '90 条公开作品 · 示例目录' : '读取主页和作品列表'}</small></span><span className={styles.creatorVerified}>演示博主</span></div>
            <div className={styles.creatorFacts}><strong>{elapsed >= 2800 ? '90' : '—'} <small>条作品</small></strong><strong>{elapsed >= 3500 ? '3' : '0'} <small>条已选</small></strong><span>{elapsed >= 3500 ? '批量提取文稿' : '选择要一起读的作品'}</span></div>
            <div className={styles.creatorVideos}>{creatorVideos.map((title, index) => <div key={title} data-selected={elapsed >= 3500}><span className={styles.mockCheckbox}>{elapsed >= 3500 && <Check size={12} />}</span><span>{elapsed >= 2800 ? title : '正在读取作品…'}</span><small>{elapsed >= 5000 + index * 1100 ? '文稿已就绪' : elapsed >= 4000 ? '提取中' : '待提取'}</small></div>)}</div>
            <ExtractionProgress elapsed={elapsed} start={4000} end={7400} total={3} label="一键提取并提问" />
          </> : <Conversation mode={3} elapsed={elapsed} />}
        </div>
      </div>
    </div></div>
    <div className={styles.playbackTrack} aria-hidden="true"><span style={{ width: `${Math.min(100, elapsed / FLOW_DURATIONS[mode] * 100)}%` }} /></div>
    <footer className={styles.footer}><div><p>自动播放完整流程 · 示例数据与回答</p><Link href="/library">进入客户端，使用自己的资料 <ArrowRight size={12} /></Link></div><div className={styles.playbackControls}><button type="button" onClick={replay} aria-label="重播当前流程"><ArrowsClockwise size={15} /></button><button type="button" onClick={() => setPlaying((current) => !current)} aria-label={playing ? '暂停分步演示' : '继续分步演示'}>{playing ? <Pause size={14} weight="fill" /> : <Play size={14} weight="fill" />}{playing ? '暂停' : '继续'}</button></div></footer>
  </section>;
}
