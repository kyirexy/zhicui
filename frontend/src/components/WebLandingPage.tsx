'use client';

import { useEffect, useRef, useState } from 'react';
import { AndroidLogo, WindowsLogo, ArrowDown, ArrowRight, AppleLogo, BookOpenText, DeviceMobile, DownloadSimple, Monitor, Play, Quotes, Stack, Target } from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';
import Link from 'next/link';
import { CLIENT_RELEASE_FALLBACKS, countedClientDownloadUrl, detectPreferredClient, formatReleaseSize, loadClientReleaseCatalog, toAbsoluteDownloadUrl, type ClientPlatform } from '@/lib/clientReleases';
import { detectMobileDownloadPlatform } from '@/lib/mobilePlatform';
import LandingProductDemo from './LandingProductDemo';
import LandingShowcase from './LandingShowcase';
import styles from './WebLandingPage.module.css';

// 保留已经发布的双架构测试产物与真实发布状态。
const MAC_TEST_DOWNLOAD_ROOT = 'https://luxai.cn/download/mac/test/dccfdecdcb7879746a031053047697822c3b6096';

export default function WebLandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [origin, setOrigin] = useState('https://luxai.cn');
  const [releases, setReleases] = useState(CLIENT_RELEASE_FALLBACKS);
  const [preferredClient, setPreferredClient] = useState<ClientPlatform | null>(null);
  const [mobilePlatform, setMobilePlatform] = useState<'android' | 'ios' | null>(null);

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
    setMobilePlatform(detectMobileDownloadPlatform(
      browserNavigator.userAgent, browserNavigator.platform, browserNavigator.maxTouchPoints,
    ));

    void loadClientReleaseCatalog(controller.signal).then((catalog) => {
      if (!controller.signal.aborted) setReleases(catalog);
    });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!['#demo', '#real-case', '#mobile', '#product', '#download', '#download-mac', '#download-ios'].includes(window.location.hash)) return undefined;
    const sectionId = window.location.hash.slice(1);
    const timeoutId = window.setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({
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
    <div ref={rootRef} className={`${styles.page} marketing-home`} data-mobile-platform={mobilePlatform ?? undefined}>
      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}><span /> 写给爱收藏、有点「仓鼠型」的你</p>
          <h1 id="landing-title"><span className={styles.heroInk}>让收藏的视频，</span><span>变成你的知识。</span></h1>
          <p className={styles.heroLead}>看过的教程、记不住的观点、来不及整理的收藏。<br className={styles.desktopBreak} />交给知萃，留下完整文案，问清重点，再变成能执行的计划。</p>
          <nav className={styles.heroDownloads} aria-label="选择客户端下载渠道">
            <a className={`${styles.heroDownload} ${styles.heroDownloadPrimary}`} href={windowsDownloadHref}>
              <WindowsLogo size={28} aria-hidden="true" /><span><strong>Windows</strong><small>立即下载</small></span><DownloadSimple size={20} aria-hidden="true" />
            </a>
            <a className={styles.heroDownload} href={androidDownloadHref}>
              <AndroidLogo size={28} aria-hidden="true" /><span><strong>Android</strong><small>立即下载</small></span><DownloadSimple size={20} aria-hidden="true" />
            </a>
            <a className={styles.heroDownload} href="#download-mac">
              <AppleLogo size={28} aria-hidden="true" /><span><strong>Mac</strong><small>测试版 · 选择版本</small></span><ArrowRight size={20} aria-hidden="true" />
            </a>
            <a className={`${styles.heroDownload} ${styles.heroDownloadUpcoming}`} href="#download-ios">
              <DeviceMobile size={28} aria-hidden="true" /><span><strong>iPhone</strong><small>即将上线</small></span><ArrowRight size={20} aria-hidden="true" />
            </a>
          </nav>
          <a className={styles.heroDemoLink} href="#demo"><Play size={18} weight="fill" aria-hidden="true" />先试试交互示例<ArrowRight size={18} aria-hidden="true" /></a>
        </div>
        <div className={styles.heroVisual}>
          <div className={styles.visualCaption}><span>从「看过了」到「我会用了」</span><span>↓ 点一点，亲自试试</span></div>
          <LandingProductDemo />
        </div>
      </section>

      <div className={styles.platformStrip} aria-label="支持的内容入口">
        <span>你喜欢的内容，从这里开始</span>
        <strong>抖音</strong><strong>哔哩哔哩</strong><span className={styles.stripDivider} aria-hidden="true" />
        <span>分享链接</span><span>收藏与喜欢</span><span>博主作品</span>
        <a href="/platform-limits">查看支持范围 <ArrowRight size={14} aria-hidden="true" /></a>
      </div>

      <section className={styles.collectorSection} aria-labelledby="collector-title">
        <div className={styles.collectorIntro}>
          <p className={styles.kicker}>好奇心很多，消化内容的时间很少</p>
          <h2 id="collector-title">有点「仓鼠型」？<br />好内容，值得慢慢消化。</h2>
          <p>看见好教程先收藏，刷到好观点舍不得划走，总觉得「以后会用到」。这里说的仓鼠型，就是这种爱积累资料的习惯。</p>
          <a href="#real-case">看看收藏怎么用起来 <ArrowRight size={16} aria-hidden="true" /></a>
        </div>
        <ol className={styles.collectorList}>
          <li><span>01</span><div><h3>先存着，再也不用从头翻</h3><p>把选中的视频整理成完整文案，想起某句话时，有内容可回看。</p></div></li>
          <li><span>02</span><div><h3>不急着看完，先问最关心的</h3><p>带着一个具体问题，读一条或多条视频，留下有依据的重点。</p></div></li>
          <li><span>03</span><div><h3>今天用一点，收藏就有意义</h3><p>留下一张知识卡片、一份行动计划，在手机上接着看、接着做。</p></div></li>
        </ol>
      </section>

      <LandingShowcase />

      <section id="product" className={styles.scenarios} aria-labelledby="scenarios-title">
        <header className={styles.sectionHeading} data-reveal><p>留住内容，更要用好内容</p><h2 id="scenarios-title">那些「以后再看」，<br />现在有了用法。</h2></header>
        <div className={styles.scenarioGrid}>
          <article className={styles.featuredScenario} data-reveal>
            <span className={styles.scenarioNumber}>01 / 学一个新东西</span>
            <h3>教程看了很多，<br />从哪里开始？</h3>
            <p>把同一主题的几条视频放在一起，带着你的问题读。问清共识与差异，再留下自己的行动清单。</p>
            <div className={styles.promptSample}><Quotes size={22} weight="fill" aria-hidden="true" /><span>这几条教程里，哪些方法适合零基础？帮我安排第一步。</span></div>
            <span className={styles.scenarioOutcome}><Target size={17} aria-hidden="true" /> 从一组视频，到一份学习计划</span>
          </article>
          <div className={styles.scenarioSide}>
            <article data-reveal><span className={styles.scenarioNumber}>02 / 找回一个好观点</span><h3>记得讲过，却找不到那句话。</h3><p>在已整理的完整文案里找内容，让回答带上原文依据。有用的结论，存进自己的知识库。</p><span className={styles.scenarioOutcome}><BookOpenText size={17} aria-hidden="true" /> 从模糊印象，到可回看的知识</span></article>
            <article data-reveal><span className={styles.scenarioNumber}>03 / 研究一位创作者</span><h3>喜欢一个博主，想系统地看。</h3><p>选择想整理的作品，准备完整文案，再围绕同一主题提问。看懂思路，也看清不同视频之间的联系。</p><span className={styles.scenarioOutcome}><Stack size={17} aria-hidden="true" /> 从零散作品，到自己的主题资料</span></article>
          </div>
        </div>
      </section>

      <section className={styles.workflow} aria-labelledby="workflow-title">
        <div className={styles.workflowHeading} data-reveal><p className={styles.kicker}>操作很轻，收获很具体</p><h2 id="workflow-title">只整理你关心的博主，<br />多选视频，一次问清楚。</h2><p>先选资料，再问问题。每一步都由你决定。</p></div>
        <ol className={styles.workflowList}>
          <li data-reveal><span>01</span><div><h3>选中你想留下的内容</h3><p>粘贴分享链接，或在 Windows 端连接平台账号，从收藏、喜欢和博主作品中手动挑选。</p></div></li>
          <li data-reveal><span>02</span><div><h3>带着问题，读一条或多条视频</h3><p>文案完成一条，就能先看一条。回答保留对应视频和原文依据，方便你继续追问和核对。</p></div></li>
          <li data-reveal><span>03</span><div><h3>把结论放进自己的生活</h3><p>将有用内容保存为知识，或转成行动计划。在手机上接着看、接着做。</p></div></li>
        </ol>
        <details className={styles.syncDetails}><summary>博主整理具体支持什么？</summary><p>连接可用时，可以直接准备近期 20/50/100 条文稿；也可以先刷新全部公开作品清单，再勾选所需视频，单次最多 50 条。所有同步都由你手动发起。全量刷新只保存公开元数据，不会自动转写全部作品。</p><Link href="/platform-limits">查看平台与客户端限制 <ArrowRight size={14} aria-hidden="true" /></Link></details>
      </section>

      <MobileShowcase androidHref={androidDownloadHref} />

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
          <article id="download-ios" className={`${styles.platformCard} ${styles.iosCard}`}>
            <div className={styles.platformTop}>
              <span className={styles.platformIcon}><AppleLogo size={28} weight="light" aria-hidden="true" /></span>
              <span className={styles.platformLabel}>准备中</span>
            </div>
            <h3>iPhone 移动端</h3>
            <p>iPhone / iPad 版尚未发布。完成苹果签名和测试后，这里会提供安装入口。</p>
            <div className={styles.iosNotice}>
              <strong>暂未开放下载</strong>
              <span>iPhone 不能安装 Android APK 或 Mac DMG，请勿下载其他平台的包。</span>
            </div>
          </article>
          <article id="download-mac" className={`${styles.platformCard} ${styles.macCard}`}>
            <div className={styles.platformTop}>
              <span className={styles.platformIcon}><AppleLogo size={28} weight="light" aria-hidden="true" /></span>
              <span className={styles.platformLabel}>Mac 测试版</span>
            </div>
            <h3>macOS 桌面端</h3>
            <p>仅适用于苹果电脑。选择与你的 Mac 芯片对应的安装包。</p>
            <div className={styles.releaseMeta} aria-label="Mac 版本信息">
              <span>v1.1.0 · 测试版</span>
              <span>macOS 12 及以上</span>
              <span>DMG</span>
            </div>
            <div className={`${styles.platformFooter} ${styles.macFooter}`}>
              <div className={styles.macActions}>
                <a href={`${MAC_TEST_DOWNLOAD_ROOT}/Zhicui-Mac-Test-1.1.0-arm64.dmg`} aria-describedby="mac-test-notice">
                  <DownloadSimple size={19} aria-hidden="true" />
                  <strong>下载 Apple Silicon 版</strong>
                  <ArrowDown size={16} aria-hidden="true" />
                </a>
                <a href={`${MAC_TEST_DOWNLOAD_ROOT}/Zhicui-Mac-Test-1.1.0-x64.dmg`} aria-describedby="mac-test-notice">
                  <DownloadSimple size={19} aria-hidden="true" />
                  <strong>下载 Intel 版</strong>
                  <ArrowDown size={16} aria-hidden="true" />
                </a>
              </div>
              <small id="mac-test-notice">尚未完成苹果签名公证和真机验收，安装时可能出现安全提示。芯片型号可在“关于本机”中查看。</small>
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

function MobileShowcase({ androidHref }: { androidHref: string }) {
  const [view, setView] = useState<'home' | 'plan'>('home');
  const imageSrc = view === 'home' ? '/images/product/android-home-sep2026.png' : '/images/product/android-plan-example-sep2026.png';
  return (
    <section id="mobile" className={styles.mobileSection} aria-labelledby="mobile-title">
      <div className={styles.mobileCopy} data-reveal>
        <p className={styles.kicker}>随身带着，你积累的好内容</p>
        <h2 id="mobile-title">在电脑前整理，<br />在生活里用起来。</h2>
        <p className={styles.mobileLead}>通勤时回看一段文案，遇到问题就追问，晚上完成计划里的一个小行动。手机端，让知识跟着你走。</p>
        <div className={styles.mobileSteps}>
          <div><BookOpenText size={21} aria-hidden="true" /><span><strong>随时翻，接着问</strong><p>用同一账号，在手机上继续阅读资料和提问。</p></span></div>
          <div><Target size={21} aria-hidden="true" /><span><strong>今天要做什么，打开就知道</strong><p>把行动计划带在身边，一项项完成。</p></span></div>
        </div>
        <div className={styles.mobileActions}><a href={androidHref}><DeviceMobile size={19} aria-hidden="true" />下载 Android 版 <ArrowRight size={17} aria-hidden="true" /></a><a href="#download-ios">iPhone 发布状态</a></div>
        <p className={styles.mobileNote}>Android 公测已开放。平台账号连接与采集由 Windows 手动发起。</p>
      </div>
      <figure className={styles.mobileGallery}>
        <div className={styles.mobileTabs} aria-label="切换手机实机截图"><button type="button" aria-pressed={view === 'home'} onClick={() => setView('home')}>手机首页</button><button type="button" aria-pressed={view === 'plan'} onClick={() => setView('plan')}>行动计划</button></div>
        <a className={styles.phone} href={imageSrc} target="_blank" rel="noopener noreferrer" aria-label={`查看${view === 'home' ? '手机首页' : '行动计划'}实机截图原图（新窗口）`}><img src={imageSrc} width="1080" height="2400" loading="lazy" decoding="async" alt={view === 'home' ? '知萃 Android 实机首页：粘贴链接、去提问、管理资料和底部导航' : '知萃 Android 实机行动计划：今日任务清单，展示预置的英语与备菜示例计划'} /></a>
        <figcaption>Android 实机界面 · 2026.09<br /><span>{view === 'home' ? '资料数量为截图时状态' : '演示账号的示例计划与历史日期'} · 点击查看原图</span></figcaption>
      </figure>
    </section>
  );
}
