import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chromium,
  type BrowserContext,
  type Page,
  type Response,
} from 'playwright-core';
import type {
  PlatformAccountCollectRequest,
  PlatformAccountItem,
  PlatformAccountProvider,
  PlatformAccountRequest,
  PlatformAccountResult,
  PlatformAccountSourceMode,
  PlatformAccountStatus,
} from './contract';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const XHS_PROFILE_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 1200;
const MAX_BILIBILI_FOLDERS = 20;
const MAX_XHS_SCROLLS = 8;
const MAX_DOUYIN_SCROLLS = 36;
const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';
const XHS_LOGIN_URL = 'https://www.xiaohongshu.com/explore';
const DOUYIN_LOGIN_URL = 'https://www.douyin.com/?showLogin=true';
const DOUYIN_PROFILE_URL = 'https://www.douyin.com/user/self?from_tab_name=main';

type SupportedBrowser = 'chrome' | 'msedge';
type StatusListener = (status: PlatformAccountStatus) => void;

interface PlatformCookie {
  name: string;
  value: string;
  domain: string;
}

interface RankedUrl {
  url: string;
  rank: number;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (/^https:\/\//i.test(raw)) return raw;
    if (/^http:\/\//i.test(raw)) return `https://${raw.slice('http://'.length)}`;
    if (/^\/\//.test(raw)) return `https:${raw}`;
    return '';
  }
  const payload = record(value);
  for (const candidate of list(payload.url_list)) {
    const url = firstUrl(candidate);
    if (url) return url;
  }
  return firstUrl(payload.url || payload.uri);
}

function firstUrlOf(...values: unknown[]): string {
  for (const value of values) {
    const url = firstUrl(value);
    if (url) return url;
  }
  return '';
}

function firstDouyinMediaUrl(video: Record<string, unknown>): string {
  for (const candidate of [
    video.play_addr,
    video.play_addr_h264,
    video.download_addr,
  ]) {
    const url = firstUrl(candidate);
    if (url) return url;
  }
  for (const bitrate of list(video.bit_rate)) {
    const url = firstUrl(record(bitrate).play_addr);
    if (url) return url;
  }
  return '';
}

function douyinItemQuality(item: PlatformAccountItem): number {
  return (
    (item.ephemeralMediaUrl ? 16 : 0)
    + (item.authorName ? 8 : 0)
    + (item.coverUrl ? 4 : 0)
    + (item.publishedAt ? 4 : 0)
    + (item.durationSeconds > 0 ? 4 : 0)
    + (item.caption && item.caption !== '抖音作品' ? 2 : 0)
    + (item.title && item.title !== '抖音作品' ? 1 : 0)
  );
}

export function mergeDouyinItem(
  target: Map<string, PlatformAccountItem>,
  item: PlatformAccountItem,
  limit: number,
): void {
  const existing = target.get(item.videoId);
  if (!existing) {
    if (target.size < limit) target.set(item.videoId, item);
    return;
  }
  const merged: PlatformAccountItem = {
    ...existing,
    ...item,
    title: item.title && item.title !== '抖音作品' ? item.title : existing.title,
    caption: item.caption || existing.caption,
    authorName: item.authorName || existing.authorName,
    coverUrl: item.coverUrl || existing.coverUrl,
    publishedAt: item.publishedAt || existing.publishedAt,
    durationSeconds: item.durationSeconds > 0
      ? item.durationSeconds
      : existing.durationSeconds,
    ephemeralMediaUrl: item.ephemeralMediaUrl || existing.ephemeralMediaUrl,
    sourceRank: existing.sourceRank,
  };
  if (douyinItemQuality(merged) <= douyinItemQuality(existing)) return;
  target.set(item.videoId, merged);
}

type DouyinResponse = Pick<Response, 'url' | 'allHeaders' | 'json'>;

export async function readDouyinMetadataPayload(
  response: DouyinResponse,
): Promise<unknown | null> {
  const url = response.url();
  if (!/douyin\.com/i.test(url) || !/(aweme|favorite|collection|post|user|feed|detail|like)/i.test(url)) {
    return null;
  }
  try {
    const headers = await response.allHeaders();
    const contentType = String(headers['content-type'] || '');
    if (contentType && !/(?:json|javascript)/i.test(contentType)) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export function normalizeDouyinRecord(
  value: unknown,
  sourceRank: number,
): PlatformAccountItem | null {
  const payload = record(value);
  const videoId = firstText(payload.aweme_id, payload.awemeId, payload.item_id);
  if (!/^\d{5,32}$/.test(videoId)) return null;
  const sourceUrl = normalizeDouyinUrl(`https://www.douyin.com/video/${videoId}`);
  if (!sourceUrl) return null;
  const author = record(payload.author);
  const video = record(payload.video);
  const share = record(payload.share_info);
  const caption = firstText(payload.desc, payload.caption).slice(0, 20_000);
  const title = firstText(
    payload.title,
    share.share_title,
    caption,
    '抖音作品',
  ).slice(0, 500);
  const createdAt = numeric(payload.create_time || payload.createTime);
  const rawDuration = numeric(video.duration || payload.duration);
  return {
    videoId,
    sourceUrl,
    title,
    caption,
    authorName: firstText(author.nickname, author.unique_id, payload.author_name).slice(0, 200),
    coverUrl: firstUrlOf(
      video.cover,
      video.origin_cover,
      video.dynamic_cover,
      payload.cover,
    ).slice(0, 2048),
    publishedAt: createdAt > 0 ? new Date(createdAt * 1000).toISOString() : '',
    durationSeconds: rawDuration > 1000
      ? Math.round(rawDuration / 1000)
      : Math.round(rawDuration),
    sourceRank,
    ephemeralMediaUrl: firstDouyinMediaUrl(video).slice(0, 8192) || undefined,
  };
}

function publicError(platform: PlatformAccountProvider, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  if (/Executable doesn't exist|launchPersistentContext/i.test(detail)) {
    return '未找到可用的 Chrome 或 Edge，请安装浏览器后重试';
  }
  if (/Target page, context or browser has been closed/i.test(detail)) {
    return '登录或同步窗口已关闭';
  }
  const sanitized = detail
    .split(/\r?\n/, 1)[0]
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[本机路径]')
    .replace(/(SESSDATA|DedeUserID|web_session|cookie)\s*[=:]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .slice(0, 180);
  return sanitized || (platform === 'bilibili'
    ? 'B站账号操作失败，请重新登录后重试'
    : platform === 'douyin'
      ? '抖音账号操作失败，请重新登录后重试'
      : '小红书账号操作失败，请重新登录后重试');
}

function normalizeDouyinUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'https://www.douyin.com');
    if (!/(^|\.)douyin\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/video\/(\d{5,32})\/?$/);
    return match ? `https://www.douyin.com/video/${match[1]}` : null;
  } catch {
    return null;
  }
}

function normalizeBilibiliUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'https://www.bilibili.com');
    if (!/(^|\.)bilibili\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/\/video\/(BV[A-Za-z0-9]+|av\d+)/i);
    return match ? `https://www.bilibili.com/video/${match[1]}` : null;
  } catch {
    return null;
  }
}

function normalizeXhsUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl, 'https://www.xiaohongshu.com');
    if (!/(^|\.)xiaohongshu\.com$/i.test(parsed.hostname)) return null;
    const supported = [
      /^\/explore\/[A-Za-z0-9]+/i,
      /^\/discovery\/item\/[A-Za-z0-9]+/i,
      /^\/user\/profile\/[^/]+\/[A-Za-z0-9]+/i,
    ].some((pattern) => pattern.test(parsed.pathname));
    if (!supported) return null;
    const clean = new URL(`https://www.xiaohongshu.com${parsed.pathname}`);
    for (const key of ['xsec_token', 'xsec_source']) {
      const value = parsed.searchParams.get(key);
      if (value) clean.searchParams.set(key, value);
    }
    return clean.toString();
  } catch {
    return null;
  }
}

export function boundedPlatformUrls(
  platform: PlatformAccountProvider,
  values: string[],
  limit: number,
): string[] {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 1));
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = platform === 'bilibili'
      ? normalizeBilibiliUrl(value)
      : platform === 'douyin'
        ? normalizeDouyinUrl(value)
        : normalizeXhsUrl(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= boundedLimit) break;
  }
  return result;
}

export function hasPlatformAuthCookie(
  platform: PlatformAccountProvider,
  cookies: PlatformCookie[],
): boolean {
  const expectedNames = platform === 'bilibili'
    ? new Set(['SESSDATA', 'DedeUserID'])
    : platform === 'douyin'
      ? new Set(['sessionid', 'sessionid_ss'])
      : new Set(['web_session']);
  const expectedDomain = platform === 'bilibili'
    ? 'bilibili.com'
    : platform === 'douyin'
      ? 'douyin.com'
      : 'xiaohongshu.com';
  return cookies.some((cookie) => {
    const domain = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    return (
      (domain === expectedDomain || domain.endsWith(`.${expectedDomain}`))
      && expectedNames.has(String(cookie.name || ''))
      && Boolean(cookie.value)
    );
  });
}

export class PlatformAccountConnector {
  private activeContext: BrowserContext | null = null;
  private activePlatform: PlatformAccountProvider = 'bilibili';
  private cancelled = false;
  private running = false;

  constructor(
    private readonly baseDirectory: () => string,
    private readonly notify: StatusListener,
  ) {}

  async login(request: PlatformAccountRequest): Promise<PlatformAccountResult> {
    return this.runExclusive(request.platform, async () => {
      const profilePath = await this.profilePath(request);
      this.notifyStatus(request.platform, 'starting', '正在打开本机浏览器…');
      const launched = await this.launchBrowser(profilePath);
      this.activeContext = launched.context;
      const page = launched.context.pages()[0] || await launched.context.newPage();
      const loginUrl = request.platform === 'bilibili'
        ? BILIBILI_LOGIN_URL
        : request.platform === 'douyin'
          ? DOUYIN_LOGIN_URL
          : XHS_LOGIN_URL;
      await page.goto(loginUrl, { waitUntil: 'commit', timeout: 20_000 })
        .catch(() => undefined);
      await page.bringToFront().catch(() => undefined);
      this.notifyStatus(
        request.platform,
        'browser-open',
        request.platform === 'bilibili'
          ? '请在 B站官方页面完成扫码或账号登录'
          : request.platform === 'douyin'
            ? '请在抖音官方页面完成扫码或账号登录'
            : '请在小红书官方页面完成登录',
        launched.browser,
      );

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (!this.cancelled && Date.now() < deadline) {
        if (hasPlatformAuthCookie(request.platform, await launched.context.cookies())) {
          this.notifyStatus(
            request.platform,
            'success',
            request.platform === 'bilibili'
              ? 'B站连接成功'
              : request.platform === 'douyin'
                ? '抖音本机登录已保存'
                : '小红书连接成功',
            launched.browser,
          );
          return {
            success: true,
            connected: true,
            platform: request.platform,
          };
        }
        await wait(POLL_INTERVAL_MS);
      }
      if (this.cancelled) {
        return { success: false, cancelled: true, platform: request.platform };
      }
      throw new Error('登录等待超时，请重新发起登录');
    });
  }

  async collect(
    request: PlatformAccountCollectRequest,
  ): Promise<PlatformAccountResult> {
    return this.runExclusive(request.platform, async () => {
      const profilePath = await this.profilePath(request);
      this.notifyStatus(request.platform, 'starting', '正在读取本机登录会话…');
      const launched = await this.launchBrowser(
        profilePath,
        request.platform === 'douyin',
      );
      this.activeContext = launched.context;
      if (!hasPlatformAuthCookie(request.platform, await launched.context.cookies())) {
        throw new Error('账号登录已失效，请先重新登录');
      }
      this.notifyStatus(
        request.platform,
        'collecting',
        request.mode === 'collect'
          ? '正在读取最近收藏…'
          : request.mode === 'post'
            ? '正在读取最近发布的作品…'
            : '正在读取最近喜欢…',
        launched.browser,
      );
      const douyinItems = request.platform === 'douyin'
        ? await this.collectDouyin(launched.context, request.mode, request.limit)
        : [];
      const urls = request.platform === 'bilibili'
        ? await this.collectBilibili(launched.context, request.mode, request.limit)
        : request.platform === 'xiaohongshu'
          ? await this.collectXiaohongshu(launched.context, request.mode, request.limit)
          : douyinItems.map((item) => item.sourceUrl);
      if (this.cancelled) {
        return { success: false, cancelled: true, platform: request.platform };
      }
      if (urls.length === 0) {
        throw new Error(request.platform === 'bilibili'
          ? '没有读取到可同步的 B站作品，请确认账号列表可见'
          : request.platform === 'douyin'
            ? '没有读取到作品；若抖音出现验证，请在官方窗口完成后再重试'
            : '没有读取到可同步的小红书作品，请确认已进入自己的主页和对应标签');
      }
      this.notifyStatus(
        request.platform,
        'success',
        `已读取 ${urls.length} 条${request.mode === 'collect' ? '收藏' : request.mode === 'post' ? '自己的' : '喜欢'}作品`,
        launched.browser,
      );
      return {
        success: true,
        connected: true,
        platform: request.platform,
        urls,
        items: douyinItems.length > 0 ? douyinItems : undefined,
        count: urls.length,
      };
    });
  }

  async cancel(): Promise<PlatformAccountResult> {
    this.cancelled = true;
    const platform = this.activePlatform;
    const context = this.activeContext;
    if (context) await context.close().catch(() => undefined);
    this.notifyStatus(platform, 'cancelled', '已取消平台账号操作');
    return { success: false, cancelled: true, platform };
  }

  async disconnect(request: PlatformAccountRequest): Promise<PlatformAccountResult> {
    if (this.running) {
      return {
        success: false,
        platform: request.platform,
        error: '请先取消正在进行的平台账号操作',
      };
    }
    const profilePath = await this.profilePath(request, false);
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    this.notifyStatus(request.platform, 'disconnected', '本机平台登录已断开');
    return { success: true, connected: false, platform: request.platform };
  }

  private async runExclusive(
    platform: PlatformAccountProvider,
    action: () => Promise<PlatformAccountResult>,
  ): Promise<PlatformAccountResult> {
    if (this.running) {
      return { success: false, platform, error: '已有平台账号操作正在进行' };
    }
    this.running = true;
    this.cancelled = false;
    this.activePlatform = platform;
    try {
      return await action();
    } catch (error) {
      if (this.cancelled) {
        return { success: false, cancelled: true, platform };
      }
      const message = publicError(platform, error);
      this.notifyStatus(platform, 'error', message);
      return { success: false, platform, error: message };
    } finally {
      const context = this.activeContext;
      this.activeContext = null;
      if (context) await context.close().catch(() => undefined);
      this.running = false;
    }
  }

  private async profilePath(
    request: PlatformAccountRequest,
    create = true,
  ): Promise<string> {
    const userHash = createHash('sha256').update(request.profileKey).digest('hex');
    const base = this.baseDirectory();
    if (create) await mkdir(base, { recursive: true });
    return join(base, userHash, request.platform);
  }

  private async launchBrowser(
    profilePath: string,
    background = false,
  ): Promise<{ context: BrowserContext; browser: SupportedBrowser }> {
    let lastError: unknown;
    for (const browser of ['chrome', 'msedge'] as const) {
      try {
        const context = await chromium.launchPersistentContext(profilePath, {
          channel: browser,
          headless: false,
          locale: 'zh-CN',
          viewport: null,
          acceptDownloads: false,
          args: [
            background ? '--start-minimized' : '--start-maximized',
            '--disable-background-mode',
            '--no-first-run',
            '--no-default-browser-check',
          ],
        });
        return { context, browser };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('未找到可用浏览器');
  }

  private notifyStatus(
    platform: PlatformAccountProvider,
    stage: PlatformAccountStatus['stage'],
    message: string,
    browser?: SupportedBrowser,
  ): void {
    this.notify({ platform, stage, message, browser });
  }

  private async requestBilibili(
    context: BrowserContext,
    url: string,
  ): Promise<Record<string, unknown>> {
    const response = await context.request.get(url, {
      timeout: 20_000,
      headers: { Referer: 'https://space.bilibili.com/' },
    });
    if (!response.ok()) throw new Error(`B站账号接口暂不可用（${response.status()}）`);
    const payload = record(await response.json());
    if (numeric(payload.code) !== 0) {
      const message = String(payload.message || payload.msg || '账号接口拒绝请求');
      throw new Error(`B站${message.slice(0, 80)}`);
    }
    return record(payload.data);
  }

  private async collectBilibili(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<string[]> {
    const nav = await this.requestBilibili(
      context,
      'https://api.bilibili.com/x/web-interface/nav',
    );
    const mid = numeric(nav.mid);
    if (!mid) throw new Error('B站登录状态无效，请重新登录');
    const ranked: RankedUrl[] = [];
    // like 接口单页最多 50，收藏接口单页最多 20；超过单页上限时分页拉取。
    const pageSize = mode === 'like' ? 50 : 20;
    const pageCap = Math.ceil(limit / pageSize);
    if (mode === 'like') {
      for (let page = 1; page <= pageCap && ranked.length < limit && !this.cancelled; page += 1) {
        const data = await this.requestBilibili(
          context,
          `https://api.bilibili.com/x/space/like/video?vmid=${mid}&pn=${page}&ps=${pageSize}`,
        );
        const videos = list(record(data.list).vlist);
        for (const value of videos) {
          const video = record(value);
          const bvid = String(video.bvid || '').trim();
          if (!bvid) continue;
          ranked.push({
            url: `https://www.bilibili.com/video/${bvid}`,
            rank: numeric(video.created || video.pubdate),
          });
        }
        if (videos.length < pageSize) break;
      }
    } else {
      const foldersData = await this.requestBilibili(
        context,
        `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
      );
      const folders = list(foldersData.list).slice(0, MAX_BILIBILI_FOLDERS);
      for (const value of folders) {
        if (this.cancelled || ranked.length >= limit) break;
        const folder = record(value);
        // B站默认收藏夹的 fid 为 0，id/fid 可能缺省或为 0；media_id 才是取资源列表所需的字段。
        // 不能因为 fid === 0 就跳过，否则仅使用默认收藏夹的账号会一个作品都读不到。
        const mediaId = numeric(folder.media_id ?? folder.id ?? folder.fid);
        if (!Number.isFinite(mediaId)) continue;
        for (let page = 1; page <= pageCap && ranked.length < limit; page += 1) {
          const folderData = await this.requestBilibili(
            context,
            `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${mediaId}&pn=${page}&ps=${pageSize}&keyword=&order=mtime&type=0&tid=0&platform=web`,
          );
          const medias = list(folderData.medias);
          for (const mediaValue of medias) {
            const media = record(mediaValue);
            const bvid = String(media.bvid || '').trim();
            if (!bvid) continue;
            ranked.push({
              url: `https://www.bilibili.com/video/${bvid}`,
              rank: numeric(media.fav_time || media.ctime || media.pubtime),
            });
          }
          if (medias.length < pageSize) break;
        }
      }
    }
    ranked.sort((left, right) => right.rank - left.rank);
    return boundedPlatformUrls('bilibili', ranked.map((item) => item.url), limit);
  }

  private async collectXiaohongshu(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<string[]> {
    let page = context.pages()[0] || await context.newPage();
    await page.goto(XHS_LOGIN_URL, { waitUntil: 'commit', timeout: 20_000 })
      .catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    this.notifyStatus(
      'xiaohongshu',
      'waiting',
      `请在打开的小红书页面进入“我”的个人主页，随后选择${mode === 'collect' ? '收藏' : '点赞'}；知萃只读取页面可见内容`,
    );

    const deadline = Date.now() + XHS_PROFILE_TIMEOUT_MS;
    while (!this.cancelled && Date.now() < deadline) {
      page = this.latestPage(context, page);
      if (/xiaohongshu\.com\/user\/profile\//i.test(page.url())) {
        const ownProfile = await this.hasOwnXhsProfileMarker(page);
        if (!ownProfile) {
          throw new Error('请进入你自己的小红书个人主页后再同步');
        }
        break;
      }
      await wait(POLL_INTERVAL_MS);
    }
    if (this.cancelled) return [];
    if (!/xiaohongshu\.com\/user\/profile\//i.test(page.url())) {
      throw new Error('等待个人主页超时，请重新同步并在浏览器中进入“我”的主页');
    }

    await this.selectXhsTab(page, mode);
    const collected: string[] = [];
    let unchangedRounds = 0;
    for (let index = 0; index < MAX_XHS_SCROLLS && collected.length < limit; index += 1) {
      if (this.cancelled) break;
      const hrefs = await page.locator(
        'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/user/profile/"]',
      ).evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).href));
      const next = boundedPlatformUrls('xiaohongshu', [...collected, ...hrefs], limit);
      unchangedRounds = next.length === collected.length ? unchangedRounds + 1 : 0;
      collected.splice(0, collected.length, ...next);
      if (collected.length >= limit || unchangedRounds >= 3) break;
      await page.evaluate(() => {
        window.scrollBy({ top: Math.max(window.innerHeight * 0.85, 640), behavior: 'instant' });
      });
      await page.waitForTimeout(900);
    }
    return collected;
  }

  private collectDouyinRecords(
    value: unknown,
    target: Map<string, PlatformAccountItem>,
    limit: number,
    depth = 0,
  ): void {
    // Even after the visible card list reaches the requested limit, keep
    // walking bounded response payloads so richer author/cover/media records
    // can upgrade those same IDs. mergeDouyinItem still refuses new IDs once
    // the limit is full.
    if (depth > 7) return;
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 500)) {
        this.collectDouyinRecords(entry, target, limit, depth + 1);
      }
      return;
    }
    const payload = record(value);
    if (Object.keys(payload).length === 0) return;
    const item = normalizeDouyinRecord(payload, target.size);
    if (item) mergeDouyinItem(target, item, limit);
    for (const entry of Object.values(payload)) {
      if (typeof entry !== 'object' || entry === null) continue;
      this.collectDouyinRecords(entry, target, limit, depth + 1);
    }
  }

  private async collectVisibleDouyinCards(
    page: Page,
    target: Map<string, PlatformAccountItem>,
    limit: number,
  ): Promise<void> {
    const values = await page.locator('a[href*="/video/"]:visible').evaluateAll(
      (anchors) => anchors.slice(0, 300).map((node) => {
        const anchor = node as HTMLAnchorElement;
        const image = anchor.querySelector('img') as HTMLImageElement | null;
        const ownText = (anchor.textContent || '').trim();
        return {
          href: anchor.href,
          text: ownText.length <= 500 ? ownText : '',
          image: image?.currentSrc || image?.src || '',
          imageAlt: image?.alt || '',
          ariaLabel: anchor.getAttribute('aria-label') || anchor.title || '',
        };
      }),
    ).catch(() => [] as Array<{
      href: string;
      text: string;
      image: string;
      imageAlt: string;
      ariaLabel: string;
    }>);
    for (const value of values) {
      if (target.size >= limit) break;
      const sourceUrl = normalizeDouyinUrl(value.href);
      const match = sourceUrl?.match(/\/video\/(\d{5,32})$/);
      if (!sourceUrl || !match) continue;
      const caption = firstText(value.imageAlt, value.ariaLabel, value.text).slice(0, 500);
      mergeDouyinItem(target, {
        videoId: match[1],
        sourceUrl,
        title: firstText(value.imageAlt, value.ariaLabel, value.text, '抖音作品').slice(0, 500),
        caption,
        authorName: '',
        coverUrl: /^https:\/\//i.test(value.image) ? value.image.slice(0, 2048) : '',
        publishedAt: '',
        durationSeconds: 0,
        sourceRank: target.size,
      }, limit);
    }
  }

  private async selectDouyinTab(
    page: Page,
    platform: PlatformAccountProvider,
    mode: PlatformAccountSourceMode,
    browser: SupportedBrowser,
  ): Promise<void> {
    const label = mode === 'collect' ? '收藏' : mode === 'post' ? '作品' : '喜欢';
    const clickVisibleTab = async (): Promise<boolean> => {
      const matches = page.getByText(label, { exact: true });
      const count = Math.min(await matches.count().catch(() => 0), 16);
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        if (await candidate.click({ timeout: 2500 }).then(() => true).catch(() => false)) {
          await page.waitForTimeout(900);
          return true;
        }
      }
      return false;
    };

    const backgroundDeadline = Date.now() + 15_000;
    while (!this.cancelled && Date.now() < backgroundDeadline) {
      if (await clickVisibleTab()) return;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
    this.notifyStatus(
      platform,
      'needs-action',
      `抖音需要你确认官方页面；完成验证并进入“${label}”后会继续`,
      browser,
    );
    await page.bringToFront().catch(() => undefined);
    const actionDeadline = Date.now() + XHS_PROFILE_TIMEOUT_MS;
    while (!this.cancelled && Date.now() < actionDeadline) {
      if (await clickVisibleTab()) return;
      await page.waitForTimeout(POLL_INTERVAL_MS);
    }
    if (!this.cancelled) {
      throw new Error(`没有找到抖音“${label}”列表，请确认当前是本人主页并完成官方验证`);
    }
  }

  private async collectDouyin(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<PlatformAccountItem[]> {
    const page = context.pages()[0] || await context.newPage();
    const items = new Map<string, PlatformAccountItem>();
    const pending = new Set<Promise<void>>();
    const onResponse = (response: Response): void => {
      const work = readDouyinMetadataPayload(response)
        .then((payload) => {
          if (payload !== null) this.collectDouyinRecords(payload, items, limit);
        })
        .then(() => undefined);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    page.on('response', onResponse);
    try {
      await page.goto(DOUYIN_PROFILE_URL, { waitUntil: 'commit', timeout: 25_000 })
        .catch(() => undefined);
      const browser = context.browser()?.browserType().name() === 'chromium'
        ? 'chrome'
        : 'msedge';
      await this.selectDouyinTab(page, 'douyin', mode, browser);
      let unchangedRounds = 0;
      for (let index = 0; index < MAX_DOUYIN_SCROLLS && items.size < limit; index += 1) {
        if (this.cancelled) break;
        const before = items.size;
        await this.collectVisibleDouyinCards(page, items, limit);
        await Promise.allSettled([...pending]);
        unchangedRounds = items.size === before ? unchangedRounds + 1 : 0;
        if (items.size >= limit || unchangedRounds >= 5) break;
        await page.evaluate(() => {
          window.scrollBy({
            top: Math.max(window.innerHeight * 0.88, 720),
            behavior: 'instant',
          });
        }).catch(() => undefined);
        await page.waitForTimeout(850);
      }
      await Promise.allSettled([...pending]);
    } finally {
      page.off('response', onResponse);
    }
    return [...items.values()]
      .slice(0, limit)
      .map((item, sourceRank) => ({ ...item, sourceRank }));
  }

  private latestPage(context: BrowserContext, fallback: Page): Page {
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    return pages[pages.length - 1] || fallback;
  }

  private async hasOwnXhsProfileMarker(page: Page): Promise<boolean> {
    for (const label of ['编辑资料', '编辑个人资料']) {
      const marker = page.getByText(label, { exact: false }).first();
      if (await marker.isVisible().catch(() => false)) return true;
    }
    return false;
  }

  private async selectXhsTab(
    page: Page,
    mode: PlatformAccountSourceMode,
  ): Promise<void> {
    const labels = mode === 'collect' ? ['收藏'] : ['点赞', '赞过', '喜欢'];
    for (const label of labels) {
      const matches = page.getByText(label, { exact: true });
      const count = Math.min(await matches.count(), 8);
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;
        await candidate.click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(1000);
        return;
      }
    }
    throw new Error(`当前个人主页没有找到“${mode === 'collect' ? '收藏' : '点赞'}”标签`);
  }
}
