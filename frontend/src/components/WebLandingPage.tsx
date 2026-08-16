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
import {
  CLIENT_RELEASE_FALLBACKS,
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
    description: '批量整理收藏、喜欢和作品，处理好一条就先显示一条。',
    Icon: FileText,
  },
  {
    title: '对视频直接提问',
    description: 'AI 基于完整视频文案回答，并保留对应的原文依据。',
    Icon: ChatCenteredText,
  },
  {
    title: '把结论变成行动',
    description: '把有用结论保存为知识，或直接转成今天能执行的计划。',
    Icon: Target,
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
        behavior: 'smooth',
        block: 'start',
      });
    }, 80);
    return () => window.clearTimeout(timeoutId);
  }, []);

  const androidUrl = toAbsoluteDownloadUrl(releases.android.downloadUrl, origin);
  const androidDownloadHref = releases.android.downloadUrl
    === CLIENT_RELEASE_FALLBACKS.android.downloadUrl
    ? '/download/zhicui.apk'
    : releases.android.downloadUrl;
  const androidSize = formatReleaseSize(releases.android.sizeBytes);
  const windowsSize = formatReleaseSize(releases.windows.sizeBytes);

  return (
    <div ref={rootRef} className={`${styles.page} marketing-home`}>
      <div className={styles.grain} aria-hidden="true" />

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy} data-reveal>
          <h1 id="landing-title">
            <span className={styles.heroInk}>把收藏视频，</span>
            <span>变成能问、能用的知识。</span>
          </h1>
          <p className={styles.heroLead}>
            自动整理完整文案，基于视频资料提问，再把有用结论保存为知识或行动计划。
          </p>

          <div className={styles.heroActions}>
            <a
              className={preferredClient === 'android' ? styles.secondaryAction : styles.primaryAction}
              data-platform="windows"
              href={releases.windows.downloadUrl}
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

      <section id="download" className={styles.downloadSection} aria-labelledby="download-title">
        <header className={styles.sectionHeading} data-reveal>
          <p>客户端下载</p>
          <h2 id="download-title">在电脑整理，在手机继续</h2>
          <span>同一账号，文案、问答和计划自动同步。</span>
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
              <span>v{releases.windows.version} 公测</span>
              <span>{windowsSize}</span>
              <span>Windows 10/11 {releases.windows.architecture || 'x64'}</span>
            </div>
            <div className={styles.platformFooter}>
              <a href={releases.windows.downloadUrl}>
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
            <p>随时阅读完整文案、向视频提问并执行每日计划。</p>
            <div className={styles.releaseMeta} aria-label="Android 版本信息">
              <span>v{releases.android.version}</span>
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
      <div className={styles.floatingCard}>
        <CheckCircle size={18} weight="fill" />
        <span><strong>完整文案已就绪</strong><small>现在可以直接提问</small></span>
      </div>
    </div>
  );
}
