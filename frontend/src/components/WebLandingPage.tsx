'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  BookOpenText,
  CheckCircle,
  ClockCountdown,
  DownloadSimple,
  FileText,
  FolderOpen,
  Monitor,
  Play,
  Quotes,
  Sparkle,
  Target,
  VideoCamera,
} from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import { DESKTOP_DOWNLOAD_URL } from '@/lib/desktopRuntime';
import styles from './WebLandingPage.module.css';

const ANDROID_DOWNLOAD_URL = '/download/zhicui.apk';
const WINDOWS_VERSION = '1.0.3';
const ANDROID_VERSION = '1.2.1';

const WORKFLOW = [
  {
    number: '01',
    title: '选择要整理的内容',
    description: '收藏、喜欢和自己的作品，由你决定同步哪一组、最近多少条。',
    Icon: FolderOpen,
  },
  {
    number: '02',
    title: '完整文案逐条出现',
    description: '处理好一条就先展示一条，不必等整批视频全部结束。',
    Icon: FileText,
  },
  {
    number: '03',
    title: '直接向视频资料提问',
    description: 'AI 阅读完整文案，并把回答对应到真实的视频和原文依据。',
    Icon: Quotes,
  },
  {
    number: '04',
    title: '把答案变成行动',
    description: '需要时再生成知识卡和计划，把“知道了”变成今天能做的事。',
    Icon: Target,
  },
] as const;

export default function WebLandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState('https://luxai.cn');

  useEffect(() => {
    setOrigin(window.location.origin);
    const root = rootRef.current;
    if (!root) return undefined;
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>('[data-reveal]'),
    );
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || !('IntersectionObserver' in window)
    ) {
      targets.forEach((target) => target.setAttribute('data-visible', 'true'));
      return undefined;
    }

    root.setAttribute('data-motion', 'ready');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        (entry.target as HTMLElement).setAttribute('data-visible', 'true');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (window.location.hash !== '#download') return undefined;
    const timeoutId = window.setTimeout(() => {
      document.getElementById('download')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const androidUrl = `${origin}${ANDROID_DOWNLOAD_URL}`;

  return (
    <div ref={rootRef} className={`${styles.page} marketing-home`}>
      <div className={styles.grain} aria-hidden="true" />

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy} data-reveal>
          <p className={styles.eyebrow}>
            <span aria-hidden="true" />
            让收藏继续产生价值
          </p>
          <h1 id="landing-title">
            <span className={styles.heroInk}>你收藏的不是视频，</span>
            <span>是还没来得及用的知识。</span>
          </h1>
          <p className={styles.heroLead}>
            知萃把抖音收藏、喜欢和个人作品整理成完整文案。你可以向一条或一组视频提问，再把有用的结论变成知识卡与行动计划。
          </p>

          <div className={styles.heroActions}>
            <a className={styles.primaryAction} href={DESKTOP_DOWNLOAD_URL}>
              <Monitor size={20} weight="light" aria-hidden="true" />
              <span>
                <strong>下载 Windows 版</strong>
                <small>推荐首次使用 · v{WINDOWS_VERSION}</small>
              </span>
              <i aria-hidden="true"><ArrowDown size={16} weight="bold" /></i>
            </a>
            <a className={styles.secondaryAction} href={ANDROID_DOWNLOAD_URL}>
              <span>
                <strong>下载 Android 版</strong>
                <small>随时提问、阅读和打卡</small>
              </span>
              <i aria-hidden="true"><ArrowRight size={16} weight="bold" /></i>
            </a>
          </div>

          <div className={styles.heroFacts} aria-label="产品说明">
            <span><CheckCircle size={16} weight="fill" />同步范围由你选择</span>
            <span><CheckCircle size={16} weight="fill" />文案完成一条显示一条</span>
            <span><CheckCircle size={16} weight="fill" />服务器不保存视频文件</span>
          </div>
        </div>

        <ProductStage />
      </section>

      <section id="product" className={styles.statement} data-reveal>
        <p>收藏夹的问题，从来不是内容不够多。</p>
        <h2>
          真正缺少的是一个人，
          <span>帮你读完、找回，并推进下一步。</span>
        </h2>
        <div className={styles.statementAside}>
          <span>从“以后再看”</span>
          <ArrowRight size={20} weight="light" aria-hidden="true" />
          <strong>到“现在就能用”</strong>
        </div>
      </section>

      <section id="workflow" className={styles.workflow} aria-labelledby="workflow-title">
        <header className={styles.sectionHeading} data-reveal>
          <p>一次连接，持续整理</p>
          <h2 id="workflow-title">从收藏夹到行动，只保留四个步骤</h2>
          <span>桌面端负责连接和批量同步；手机端负责随时查看、提问和执行。</span>
        </header>

        <ol className={styles.workflowList}>
          {WORKFLOW.map(({ number, title, description, Icon }, index) => (
            <li
              key={number}
              className={index % 2 === 1 ? styles.offsetStep : undefined}
              data-reveal
            >
              <div className={styles.stepNumber}>{number}</div>
              <span className={styles.stepIcon} aria-hidden="true">
                <Icon size={23} weight="light" />
              </span>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.evidence} aria-labelledby="evidence-title">
        <div className={styles.evidenceCopy} data-reveal>
          <p className={styles.eyebrow}>不是脱离原视频的万能回答</p>
          <h2 id="evidence-title">先读你的视频，再给答案。</h2>
          <p>
            知萃默认依据你选择的视频文案回答。资料没有提到的内容，会明确标注为 AI 补充；需要时再允许联网查证。
          </p>
          <ul>
            <li><BookOpenText size={18} weight="light" />查看完整文案，不只依赖摘要</li>
            <li><VideoCamera size={18} weight="light" />引用对应视频和原文片段</li>
            <li><Sparkle size={18} weight="light" />综合多条视频的共同点与分歧</li>
          </ul>
        </div>

        <div className={styles.answerShell} data-reveal>
          <article className={styles.answerCard}>
            <header>
              <span><Sparkle size={18} weight="fill" /></span>
              <div>
                <strong>视频资料 Agent</strong>
                <small>正在参考 8 条完整文案</small>
              </div>
            </header>
            <div className={styles.question}>
              这些健身视频里，新手今天应该先练什么？
            </div>
            <div className={styles.answer}>
              <strong>先完成一次 20 分钟的全身基础训练。</strong>
              <p>
                其中 5 条视频都建议新手先稳定频率，再逐渐增加动作数量。今天可以从深蹲、推和拉三类动作各选一个。
              </p>
              <div>
                <span><FileText size={14} weight="light" />已核对 8 条文案</span>
                <span><Quotes size={14} weight="light" />引用 5 个片段</span>
              </div>
            </div>
            <footer>
              <span>查看原文依据</span>
              <span>转成行动计划</span>
            </footer>
          </article>
        </div>
      </section>

      <section id="download" className={styles.downloadSection} aria-labelledby="download-title">
        <header className={styles.sectionHeading} data-reveal>
          <p>选择你的使用方式</p>
          <h2 id="download-title">电脑负责整理，手机陪你行动</h2>
          <span>两个客户端共用同一个知萃账号，文案、问答、知识卡和计划保持同步。</span>
        </header>

        <div className={styles.platformGrid}>
          <article className={styles.windowsCard} data-reveal>
            <div className={styles.platformTop}>
              <span className={styles.platformIcon}><Monitor size={28} weight="light" /></span>
              <span className={styles.recommended}>建议先安装</span>
            </div>
            <h3>Windows 桌面端</h3>
            <p>完成抖音扫码绑定、批量同步与深度视频问答，是知萃最完整的使用方式。</p>
            <ul>
              <li><CheckCircle size={17} weight="fill" />使用本机 Chrome 扫码绑定抖音</li>
              <li><CheckCircle size={17} weight="fill" />批量同步最近 1–100 条视频</li>
              <li><CheckCircle size={17} weight="fill" />后台整理文案并自动检查更新</li>
            </ul>
            <a href={DESKTOP_DOWNLOAD_URL}>
              <DownloadSimple size={19} weight="light" />
              下载 Windows 版
              <span>v{WINDOWS_VERSION} · Windows 10/11 x64</span>
            </a>
          </article>

          <article className={styles.androidCard} data-reveal>
            <div className={styles.androidCopy}>
              <div className={styles.platformTop}>
                <span className={styles.platformIcon}><ClockCountdown size={28} weight="light" /></span>
              </div>
              <h3>Android 移动端</h3>
              <p>在手机上查看同步结果、播放原视频、阅读文案、向视频提问，并完成每日计划。</p>
              <a href={ANDROID_DOWNLOAD_URL}>
                <DownloadSimple size={19} weight="light" />
                下载 Android APK
                <span>v{ANDROID_VERSION}</span>
              </a>
            </div>
            <div className={styles.qrPanel}>
              <QRCodeSVG
                value={androidUrl}
                size={116}
                bgColor="transparent"
                fgColor="#173d32"
                level="M"
                marginSize={1}
                title="知萃 Android 下载二维码"
              />
              <span>电脑访问时扫码安装</span>
            </div>
          </article>
        </div>
      </section>

      <section className={styles.finalCta} data-reveal>
        <div>
          <p>别再让收藏夹替你保存遗忘。</p>
          <h2>从最近 50 条开始，把它们真正用起来。</h2>
        </div>
        <a href={DESKTOP_DOWNLOAD_URL}>
          下载 Windows 版
          <i aria-hidden="true"><ArrowDown size={17} weight="bold" /></i>
        </a>
      </section>
    </div>
  );
}

function ProductStage() {
  const videos = [
    { title: '新手健身先练什么', state: '文案已就绪', tone: 'mint' },
    { title: '三步做好一周备菜', state: '正在提取文案', tone: 'sand' },
    { title: '产品演示如何开场', state: '文案已就绪', tone: 'paper' },
  ] as const;

  return (
    <div className={styles.stage} data-reveal>
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.stageShell}>
        <div className={styles.stageWindow}>
          <header>
            <div className={styles.windowDots} aria-hidden="true"><i /><i /><i /></div>
            <span>知萃 · 视频知识工作台</span>
            <b>云端已同步</b>
          </header>
          <div className={styles.windowBody}>
            <aside aria-hidden="true">
              <img src="/logo.png" alt="" />
              <i /><i className={styles.activeNav} /><i /><i /><i />
            </aside>
            <main>
              <div className={styles.libraryTop}>
                <div>
                  <span>批量视频库</span>
                  <strong>最近收藏</strong>
                </div>
                <span className={styles.previewSync}>同步 50 条</span>
              </div>
              <div className={styles.videoStrip}>
                {videos.map((video, index) => (
                  <article key={video.title}>
                    <div className={`${styles.videoCover} ${styles[video.tone]}`}>
                      <span>0{index + 1}</span>
                      <i><Play size={15} weight="fill" /></i>
                    </div>
                    <strong>{video.title}</strong>
                    <small>{video.state}</small>
                  </article>
                ))}
              </div>
              <section className={styles.agentPreview}>
                <header>
                  <Sparkle size={16} weight="fill" />
                  <strong>向这些视频提问</strong>
                  <span>参考 3 条完整文案</span>
                </header>
                <p>这三条内容里，今天最值得先做什么？</p>
                <div>
                  <strong>先完成一个 20 分钟、能立即开始的小行动。</strong>
                  <span>回答已核对原文依据</span>
                </div>
              </section>
            </main>
          </div>
        </div>
      </div>
      <div className={styles.floatingCard}>
        <CheckCircle size={18} weight="fill" />
        <span><strong>完整文案已就绪</strong><small>现在可以直接提问</small></span>
      </div>
    </div>
  );
}
