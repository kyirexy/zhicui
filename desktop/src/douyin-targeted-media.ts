import type { BrowserContext, CDPSession, Page, Response } from 'playwright-core';
import type { PlatformAccountItem } from './contract';

const MEDIA_DOMAINS = ['douyinvod.com', 'bytecdn.cn', 'bytecdn.com', 'snssdk.com',
  'ibytedtos.com', 'douyin.com', 'iesdouyin.com', 'pstatp.com', 'zjcdn.com', 'volccdn.com'];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 只选官方视频资源；图文背景音乐不是视频口述，不能替代文稿或证明“无音频”。 */
export function targetedDouyinMediaUrl(value: unknown): string {
  const video = record(record(value).video);
  const candidates: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5) return;
    if (typeof value === 'string') {
      const normalized = value.trim().replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
      try {
        const url = new URL(normalized);
        if (url.protocol === 'https:' && !url.username && !url.password && !url.hash
          && (!url.port || url.port === '443') && normalized.length <= 8192
          && MEDIA_DOMAINS.some((domain) => url.hostname.endsWith(`.${domain}`))) candidates.push(normalized);
      } catch { /* 只接受受信任的临时视频地址。 */ }
      return;
    }
    if (Array.isArray(value)) { value.slice(0, 20).forEach((item) => visit(item, depth + 1)); return; }
    const object = record(value);
    for (const key of ['url_list', 'urlList', 'url', 'uri', 'src']) if (object[key]) visit(object[key], depth + 1);
  };
  for (const source of [video.play_addr, video.playAddr, video.play_addr_h264,
    ...(Array.isArray(video.bit_rate) ? video.bit_rate.map((item) => record(item).play_addr) : []),
    video.download_addr]) visit(source);
  // 优先选择 CDN 直链，避免将播放接口的再次解析交给无登录状态的服务器。
  return candidates.find((value) => !/(?:^|\.)douyin\.com$/.test(new URL(value).hostname)) || candidates[0] || '';
}

export function findTargetedDouyinRecords(value: unknown, videoId: string): unknown[] {
  const found: unknown[] = [];
  let visited = 0;
  const walk = (entry: unknown, depth = 0): void => {
    if (++visited > 3000 || depth > 12 || !entry || typeof entry !== 'object') return;
    const object = record(entry);
    if (String(object.aweme_id || object.awemeId || object.item_id || '') === videoId) found.push(entry);
    for (const child of Object.values(entry).slice(0, 200)) walk(child, depth + 1);
  };
  walk(value);
  return found;
}

/** 只读取指定详情页的公开作品状态，不读取浏览器身份或存储。 */
async function readPageRecords(page: Page, videoId: string): Promise<unknown[]> {
  return page.evaluate((targetId) => {
    if (!new RegExp(`^/(?:video|note)/${targetId}/?$`).test(location.pathname)
      || location.hostname !== 'www.douyin.com') return [];
    const found: unknown[] = [];
    let visited = 0;
    const seen = new WeakSet<object>();
    const walk = (value: unknown, depth = 0): void => {
      if (++visited > 3000 || depth > 12 || !value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      const object = value as Record<string, unknown>;
      if (String(object.aweme_id || object.awemeId || object.item_id || '') === targetId) found.push(value);
      for (const child of Object.values(value).slice(0, 200)) walk(child, depth + 1);
    };
    walk((window as Window & { _ROUTER_DATA?: unknown })._ROUTER_DATA);
    for (const script of Array.from(document.querySelectorAll('script#RENDER_DATA, script#__NEXT_DATA__, script[type="application/json"]')).slice(0, 10)) {
      const text = script.textContent || '';
      if (text.length > 2_000_000) continue;
      try { walk(JSON.parse(text)); }
      catch { try { walk(JSON.parse(decodeURIComponent(text))); } catch { /* 不是作品状态。 */ } }
    }
    return found.slice(0, 8);
  }, videoId).catch(() => []);
}

interface Options {
  normalize: (value: unknown, rank: number) => PlatformAccountItem | null;
  cancelled: () => boolean;
  onProgress: (message: string) => void;
  onActivePage?: (page: Page | null) => void;
  showPage?: (page: Page) => Promise<void>;
  onNeedsAction?: (message: string) => void;
  timeoutMs?: number;
  verificationTimeoutMs?: number;
}

function isTargetPage(page: Page, videoId: string): boolean {
  try {
    const url = new URL(page.url());
    return url.protocol === 'https:' && url.hostname === 'www.douyin.com'
      && new RegExp(`^/(?:video|note)/${videoId}/?$`).test(url.pathname);
  } catch { return false; }
}

async function needsVerification(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    if (!/(?:^|\.)douyin\.com$/.test(location.hostname)) return false;
    if (/\/(?:passport|login|verify)(?:\/|$)/.test(location.pathname)
      || new URLSearchParams(location.search).get('showLogin') === 'true') return true;
    const visible = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    if (Array.from(document.querySelectorAll('#captcha_container, .captcha_verify_container, [class*="captcha-verify"], [id*="verify-bar"]')).some(visible)) return true;
    return Array.from(document.querySelectorAll('[role="dialog"], [class*="verify"], [class*="captcha"]'))
      .some((element) => visible(element) && /安全验证|请完成.*验证|拖动滑块|登录后.*(?:查看|继续)|扫码登录/.test(element.textContent || ''));
  }).catch(() => false);
}

/** 在已有登录会话里按 ID 读取详情；不扫描账号列表，不构造签名请求。 */
export async function collectTargetedDouyinMedia(context: BrowserContext, videoIds: string[], options: Options) {
  const ids = [...new Set(videoIds)];
  const results = new Map<string, PlatformAccountItem>();
  let next = 0;
  let checked = 0;
  let firstShown = false;
  let activePage: Page | null = null;
  let verificationPage: Page | null = null;
  const livePages = new Set<Page>();
  const show = async (page: Page) => {
    activePage = page;
    options.onActivePage?.(page);
    await (options.showPage ? options.showPage(page) : page.bringToFront()).catch(() => undefined);
  };
  const worker = async () => {
    while (next < ids.length && !options.cancelled()) {
      const rank = next++;
      const videoId = ids[rank];
      let page: Page | undefined;
      let network: CDPSession | undefined;
      let deadline = Date.now() + (options.timeoutMs || 12_000);
      let accepting = true;
      let verificationStarted = false;
      let verificationAnnounced = false;
      const accept = (records: unknown[]) => {
        if (!accepting || options.cancelled() || !page || !isTargetPage(page, videoId)) return;
        for (const raw of records) {
          const mediaUrl = targetedDouyinMediaUrl(raw);
          const item = options.normalize(raw, rank);
          if (mediaUrl && item?.videoId === videoId) {
            results.set(videoId, { ...item, ephemeralMediaUrl: mediaUrl });
            break;
          }
        }
      };
      const onResponse = (response: Response) => {
        let url: URL;
        try { url = new URL(response.url()); } catch { return; }
        if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com'
          || !/^\/aweme\/v1\/web\/aweme\/detail\/?$/.test(url.pathname) || !response.ok()) return;
        void response.json().then((payload) => accept(findTargetedDouyinRecords(payload, videoId))).catch(() => undefined);
      };
      try {
        page = await context.newPage();
        livePages.add(page);
        if (options.cancelled()) continue;
        page.on('response', onResponse);
        // 详情缓存同样可能带着过期地址，强制观察本轮官方网络返回。
        network = await context.newCDPSession(page);
        await network.send('Network.enable');
        await network.send('Network.setCacheDisabled', { cacheDisabled: true });
        await network.send('Network.setBypassServiceWorker', { bypass: true });
        options.onProgress(`正在更新指定视频播放地址 · 已检查 ${checked}/${ids.length} · 已取得 ${results.size}`);
        if (!firstShown) { firstShown = true; await show(page); }
        await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'commit', timeout: Math.min(10_000, options.timeoutMs || 12_000) }).catch(() => undefined);
        let lastRead = 0;
        while (!options.cancelled() && !results.has(videoId) && !page.isClosed() && Date.now() < deadline) {
          if (Date.now() - lastRead >= 500) {
            lastRead = Date.now();
            accept(await readPageRecords(page, videoId));
            if (!results.has(videoId) && await needsVerification(page)) {
              if (!verificationStarted) {
                verificationStarted = true;
                deadline = Date.now() + (options.verificationTimeoutMs || 60_000);
              }
              // 多个详情同时遇到验证时依次提示，避免三个标签轮流抢前台。
              if (!verificationAnnounced && (!verificationPage || verificationPage === page)) {
                verificationPage = page;
                verificationAnnounced = true;
                await show(page);
                options.onNeedsAction?.('请在已前置的抖音详情页完成登录或安全验证，完成后自动继续；本次最多等待 60 秒，可随时取消');
              }
            } else if (verificationStarted && !isTargetPage(page, videoId)) {
              // 登录后返回首页时继续打开同一条目标详情，不改变资料范围。
              await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'commit', timeout: Math.min(10_000, Math.max(1, deadline - Date.now())) }).catch(() => undefined);
            }
          }
          if (!results.has(videoId)) await page.waitForTimeout(150).catch(() => undefined);
        }
      } catch {
        // 单页关闭、导航或浏览器协议异常只影响本条；等待其它 worker 完整清理后再返回。
      } finally {
        accepting = false;
        page?.off('response', onResponse);
        await network?.detach().catch(() => undefined);
        if (page) {
          livePages.delete(page);
          if (verificationPage === page) verificationPage = null;
          if (activePage === page) {
            activePage = [...livePages].find((candidate) => !candidate.isClosed()) || null;
            options.onActivePage?.(activePage);
          }
          await page.close().catch(() => undefined);
        }
        checked += 1;
        if (!options.cancelled()) options.onProgress(`指定视频播放地址已检查 ${checked}/${ids.length} · 已取得 ${results.size}`);
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.min(3, ids.length) }, worker));
  options.onActivePage?.(null);
  const items = ids.flatMap((id) => results.has(id) ? [results.get(id)!] : []);
  return { items, urls: items.map((item) => item.sourceUrl), coverage: 'partial' as const, orderReliable: false,
    warning: `仅更新指定视频播放地址：已取得 ${items.length}/${ids.length} 条${items.length < ids.length ? '；其余作品暂未返回可读取的视频资源' : ''}` };
}
