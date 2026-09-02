'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ChatCenteredText,
  CheckCircle,
  DeviceMobile,
  DownloadSimple,
  FileText,
  Monitor,
  Play,
  Sparkle,
  Target,
} from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import Link from 'next/link';
import {
  CLIENT_RELEASE_FALLBACKS,
  countedClientDownloadUrl,
  detectPreferredClient,
  formatReleaseSize,
  loadClientReleaseCatalog,
  toAbsoluteDownloadUrl,
  type ClientPlatform,
} from '@/lib/clientReleases';
import styles from './WebLandingPage.module.css';

const CORE_FEATURES = [
  {
    title: '视频变成完整文案',
    description: '从收藏、喜欢、博主作品或分享链接手动挑选，处理好一条就先显示一条。',
    Icon: FileText,
  },
  {
    title: '对视频直接提问',
    description: '可以单选或多选视频，AI 基于完整文案回答，并保留对应的原文依据。',
    Icon: ChatCenteredText,
  },
  {
    title: '把结论变成行动',
    description: '把有用结论保存为知识，或直接转成今天能执行的计划。',
    Icon: Target,
  },
] as const;

type ProductDemoKind = 'creator' | 'multi-video';

interface ProductStory {
  kind: ProductDemoKind;
  title: string;
  description: string;
  facts: readonly string[];
  demoTitle: string;
  demoCaption: string;
  videoSrc?: string;
  posterSrc?: string;
  captionsSrc?: string;
}

// 将录屏放入 public/videos 后，在对应项填写 videoSrc、posterSrc 和 captionsSrc，
// 页面会自动用真实视频替换当前的静态功能演示。
const PRODUCT_STORIES: readonly ProductStory[] = [
  {
    kind: 'creator',
    title: '只整理你关心的博主',
    description: '连接可用时，粘贴公开博主主页，可以直接准备近期 20/50/100 条文稿；也可以先刷新全部公开作品清单，再勾选需要的视频，单次最多 50 条。所有同步都由你手动发起。',
    facts: [
      '先看作品清单，再决定提取哪些视频',
      '全量刷新只保存公开元数据，不会自动转写全部作品',
      '文案完成一条，就先在视频资料中显示一条',
    ],
    demoTitle: '定向整理博主视频功能演示',
    demoCaption: '从识别博主主页，到勾选作品并准备完整文案。',
  },
  {
    kind: 'multi-video',
    title: '多选视频，一次问清楚',
    description: '在视频资料中勾选同一主题的多条视频，带入知萃 AI 进行一次提问。回答基于已就绪的完整文案，可以继续追问共识、差异和下一步。',
    facts: [
      '支持点选或框选多条视频',
      '回答保留对应视频和原文依据',
      '有用结论可以保存为知识或行动计划',
    ],
    demoTitle: '多选视频集中提问功能演示',
    demoCaption: '选中一组视频，带着完整文案进入同一次提问。',
  },
] as const;

export default function WebLandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState('https://luxai.cn');
  const [releases, setReleases] = useState(CLIENT_RELEASE_FALLBACKS);
  const [preferredClient, setPreferredClient] = useState<ClientPlatform | null>(null);

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
    const controller = new AbortController();
    const browserNavigator = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    setPreferredClient(detectPreferredClient(
      browserNavigator.userAgent,
      browserNavigator.userAgentData?.platform || browserNavigator.platform,
    ));

    void loadClientReleaseCatalog(controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setReleases(catalog);
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (window.location.hash !== '#download') return undefined;
    const timeoutId = window.setTimeout(() => {
      document.getElementById('download')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      });
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const androidDownloadHref = countedClientDownloadUrl('android');
  const androidUrl = toAbsoluteDownloadUrl(androidDownloadHref, origin);
  const windowsDownloadHref = countedClientDownloadUrl('windows');
  const androidSize = formatReleaseSize(releases.android.sizeBytes);
  const windowsSize = formatReleaseSize(releases.windows.sizeBytes);

  return (
    <div ref={rootRef} className={`${styles.page} marketing-home`}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy} data-reveal>
          <h1 id="landing-title">
            <span className={styles.heroInk}>把收藏视频，</span>
            <span>变成能问、能用的知识。</span>
          </h1>
          <p className={styles.heroLead}>
            从喜欢、收藏、博主作品或分享链接中手动选择视频，生成完整文案；可以一次选多条提问，再把有用结论保存为知识或行动计划。
          </p>

          <div className={styles.heroActions}>
            <a
              className={preferredClient === 'android' ? styles.secondaryAction : styles.primaryAction}
              data-platform="windows"
              href={windowsDownloadHref}
              aria-label={`下载 Windows 桌面端 v${releases.windows.version}`}
            >
              <Monitor size={20} weight="light" aria-hidden="true" />
              <span>
                <strong>下载 Windows 版</strong>
                <small>
                  {preferredClient === 'windows' ? '本机推荐 · ' : ''}
                  v{releases.windows.version} · {windowsSize}
                </small>
              </span>
              <i aria-hidden="true"><ArrowDown size={16} weight="bold" /></i>
            </a>
            <a
              className={preferredClient === 'android' ? styles.primaryAction : styles.secondaryAction}
              data-platform="android"
              href={androidDownloadHref}
              aria-label={`下载 Android 移动端 v${releases.android.version}`}
            >
              <DeviceMobile size={20} weight="light" aria-hidden="true" />
              <span>
                <strong>下载 Android 版</strong>
                <small>
                  {preferredClient === 'android' ? '本机推荐 · ' : ''}
                  v{releases.android.version} · {androidSize}
                </small>
              </span>
              <i aria-hidden="true"><ArrowDown size={16} weight="bold" /></i>
            </a>
          </div>
        </div>

        <ProductStage />
      </section>

      <section id="product" className={styles.core} aria-labelledby="core-title">
        <header className={styles.sectionHeading} data-reveal>
          <p>核心功能</p>
          <h2 id="core-title">从视频到行动，只做三件事</h2>
        </header>

        <ul className={styles.coreList}>
          {CORE_FEATURES.map(({ title, description, Icon }) => (
            <li key={title} data-reveal>
              <span className={styles.coreIcon} aria-hidden="true">
                <Icon size={23} weight="light" />
              </span>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.useCases} aria-labelledby="use-cases-title">
        <header className={styles.useCaseHeading} data-reveal>
          <h2 id="use-cases-title">从一个博主，到一组视频</h2>
          <p>两种常用方式，都从你主动选择资料开始。</p>
        </header>

        <div className={styles.useCaseList}>
          {PRODUCT_STORIES.map((story) => (
            <article key={story.kind} className={styles.useCase} data-reveal>
              <div className={styles.useCaseCopy}>
                <h3>{story.title}</h3>
                <p>{story.description}</p>
                <ul>
                  {story.facts.map((fact) => (
                    <li key={fact}>
                      <CheckCircle size={18} weight="fill" aria-hidden="true" />
                      <span>{fact}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <ProductDemoMedia story={story} />
            </article>
          ))}
        </div>
      </section>

      <section id="download" className={styles.downloadSection} aria-labelledby="download-title">
        <header className={styles.sectionHeading} data-reveal>
          <p>客户端下载</p>
          <h2 id="download-title">在电脑整理，在手机继续</h2>
          <span>同一账号，文案、问答和计划跨端同步；平台账号采集由 Windows 手动发起。</span>
        </header>

        <div className={styles.platformGrid}>
          <article
            className={`${styles.platformCard} ${styles.windowsCard}`}
            data-recommended={preferredClient === 'windows' ? 'true' : undefined}
            data-reveal
          >
            <div className={styles.platformTop}>
              <span className={styles.platformIcon}><Monitor size={28} weight="light" /></span>
              <span className={preferredClient === 'windows' ? styles.recommended : styles.platformLabel}>
                {preferredClient === 'windows' ? '本机推荐' : '桌面工作台'}
              </span>
            </div>
            <h3>Windows 桌面端</h3>
            <p>批量同步视频、整理完整文案并进行深度提问。</p>
            <div className={styles.releaseMeta} aria-label="Windows 版本信息">
              <span>v{releases.windows.version} · beta 公测</span>
              <span>{windowsSize}</span>
              <span>Windows 10/11 {releases.windows.architecture || 'x64'}</span>
            </div>
            <div className={styles.platformFooter}>
              <a href={windowsDownloadHref}>
                <DownloadSimple size={19} weight="light" />
                <strong>下载 Windows 安装包</strong>
                <ArrowDown size={16} weight="bold" aria-hidden="true" />
              </a>
              {releases.windows.codeSigned === false ? (
                <small>未签名公测版，首次安装可能出现 Windows 安全提示。</small>
              ) : null}
            </div>
          </article>

          <article
            className={`${styles.platformCard} ${styles.androidCard}`}
            data-recommended={preferredClient === 'android' ? 'true' : undefined}
            data-reveal
          >
            <div className={styles.platformTop}>
              <span className={styles.platformIcon}><DeviceMobile size={28} weight="light" /></span>
              <span className={preferredClient === 'android' ? styles.recommended : styles.platformLabel}>
                {preferredClient === 'android' ? '本机推荐' : '移动端'}
              </span>
            </div>
            <h3>Android 移动端</h3>
            <p>粘贴分享链接、阅读完整文案、向视频提问并执行每日计划；账号采集需 Windows。</p>
            <div className={styles.releaseMeta} aria-label="Android 版本信息">
              <span>v{releases.android.version} · beta 公测</span>
              <span>{androidSize}</span>
              <span>APK</span>
            </div>
            <div className={`${styles.platformFooter} ${styles.androidFooter}`}>
              <div>
                <a href={androidDownloadHref}>
                  <DownloadSimple size={19} weight="light" />
                  <strong>下载 Android APK</strong>
                  <ArrowDown size={16} weight="bold" aria-hidden="true" />
                </a>
                <small>下载后按系统提示完成安装。</small>
              </div>
              <div className={styles.qrPanel}>
                <QRCodeSVG
                  value={androidUrl}
                  size={104}
                  bgColor="transparent"
                  fgColor="#242426"
                  level="M"
                  marginSize={1}
                  title="知萃 Android 下载二维码"
                />
                <span>扫码下载</span>
              </div>
            </div>
          </article>
        </div>
        <p className={styles.releaseNotice}>
          平台访问可能受登录状态和平台规则影响；已有资料不会因临时限制而丢失。
          <Link href="/platform-limits">查看平台与客户端限制</Link>
        </p>
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
    <div
      className={styles.stage}
      data-reveal
      role="img"
      aria-label="知萃展示三条视频资料并基于完整文案回答问题的界面示意"
    >
      <div className={styles.stageGlow} aria-hidden="true" />
      <div className={styles.stageShell} aria-hidden="true">
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
            <div className={styles.windowMain}>
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
            </div>
          </div>
        </div>
      </div>
      <div className={styles.floatingCard} aria-hidden="true">
        <CheckCircle size={18} weight="fill" />
        <span><strong>完整文案已就绪</strong><small>现在可以直接提问</small></span>
      </div>
    </div>
  );
}

function ProductDemoMedia({ story }: { story: ProductStory }) {
  return (
    <figure className={styles.demoFigure}>
      <div className={styles.demoMedia} data-static={!story.videoSrc ? 'true' : undefined}>
        {story.videoSrc ? (
          <video
            controls
            playsInline
            preload="none"
            poster={story.posterSrc}
            aria-label={story.demoTitle}
          >
            <source src={story.videoSrc} type="video/mp4" />
            {story.captionsSrc ? (
              <track
                default
                kind="captions"
                src={story.captionsSrc}
                srcLang="zh-CN"
                label="中文"
              />
            ) : null}
            你的浏览器暂不支持视频播放。
          </video>
        ) : (
          <DemoPoster kind={story.kind} title={story.demoTitle} />
        )}
      </div>
      <figcaption>
        {story.videoSrc ? (
          <Play size={16} weight="fill" aria-hidden="true" />
        ) : (
          <FileText size={16} weight="fill" aria-hidden="true" />
        )}
        <span>
          <strong>{story.videoSrc ? '功能演示' : '界面示意'}</strong>
          {story.demoCaption}
        </span>
      </figcaption>
    </figure>
  );
}

function DemoPoster({ kind, title }: { kind: ProductDemoKind; title: string }) {
  if (kind === 'creator') {
    return (
      <div className={styles.demoPoster} data-kind={kind} role="img" aria-label={title}>
        <div className={styles.demoTopbar}>
          <span>博主作品</span>
          <small>选择要整理的视频</small>
        </div>
        <div className={styles.creatorSummary}>
          <span className={styles.creatorAvatar} aria-hidden="true">新</span>
          <span><strong>新儿说游</strong><small>已读取 86 条公开作品</small></span>
          <b>近期 20 条</b>
        </div>
        <div className={styles.creatorRows} aria-hidden="true">
          {['关卡设计为什么会让人上瘾', '独立游戏如何做好新手引导', '从完整流程拆解游戏制作'].map((item, index) => (
            <span key={item}>
              <i data-checked={index !== 1 ? 'true' : undefined}>{index !== 1 ? '✓' : ''}</i>
              <strong>{item}</strong>
              <small>{index === 2 ? '待准备' : '文案已就绪'}</small>
            </span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.demoPoster} data-kind={kind} role="img" aria-label={title}>
      <div className={styles.demoTopbar}>
        <span>视频资料</span>
        <small>已选 3 条</small>
      </div>
      <div className={styles.selectedVideos} aria-hidden="true">
        {['定价的底层逻辑', '用户为什么会买', '三种产品叙事'].map((item) => (
          <span key={item}><i>✓</i><strong>{item}</strong></span>
        ))}
      </div>
      <div className={styles.demoQuestion} aria-hidden="true">
        <span>这三条视频对“用户为什么买单”有哪些共识？</span>
        <strong>回答将核对 3 条完整文案</strong>
      </div>
    </div>
  );
}
