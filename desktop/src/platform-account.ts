import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BrowserContext,
  type Frame,
  type Page,
  type Request,
  type Response,
} from 'playwright-core';
import { launchIsolatedPlatformBrowser } from './platform-browser';
import { collectTargetedDouyinMedia } from './douyin-targeted-media';
import type {
  PlatformAccountCaptureDiagnostics,
  PlatformAccountCollectRequest,
  PlatformAccountItem,
  PlatformAccountProvider,
  PlatformAccountRequest,
  PlatformAccountResult,
  PlatformAccountSourceMode,
  PlatformAccountStatus,
  PlatformAccountSyncCancelRequest,
} from './contract';
import {
  CrossProcessActionLock,
  type DesktopActionLease,
  LocalActionBusyError,
  localPlatformLockKey,
  normalizeLocalPlatformResult,
  platformSessionPath,
} from './desktop-core';

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const XHS_PROFILE_TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 1200;
const MAX_BILIBILI_FOLDERS = 100;
const MAX_XHS_SCROLLS = 8;
const MAX_DOUYIN_SCROLLS = 36;
const BILIBILI_LOGIN_URL = 'https://passport.bilibili.com/login';
const XHS_LOGIN_URL = 'https://www.xiaohongshu.com/explore';
const DOUYIN_LOGIN_URL = 'https://www.douyin.com/?showLogin=true';
const DOUYIN_PROFILE_URL = 'https://www.douyin.com/user/self?from_tab_name=main';
const DOUYIN_SOURCE_TAB_QUERY: Record<PlatformAccountSourceMode, string> = {
  like: 'like',
  collect: 'favorite_collection',
  post: 'post',
};
const DOUYIN_SOURCE_FIRST_PAGE_REQUIRED = 'DOUYIN_SOURCE_FIRST_PAGE_REQUIRED';
const DOUYIN_SOURCE_ACTION_TIMEOUT_MS = 120_000;
const DOUYIN_SESSION_IDLE_TIMEOUT_MS = 30_000;

interface RetainedDouyinSession {
  context: BrowserContext;
  browser: SupportedBrowser;
  profileKey: string;
  sessionKey: string;
  lease: DesktopActionLease;
  timer?: ReturnType<typeof setTimeout>;
}

class PlatformAccountActionError extends Error {
  constructor(message: string, readonly code: string, readonly mode: PlatformAccountSourceMode) {
    super(message);
  }
}
const DOUYIN_SOURCE_RESPONSE_PATHS: Record<PlatformAccountSourceMode, RegExp> = {
  like: /^\/aweme\/v1\/web\/aweme\/favorite\/?$/i,
  collect: /^\/aweme\/v1\/web\/aweme\/listcollection\/?$/i,
  post: /^\/aweme\/v1\/web\/aweme\/post\/?$/i,
};
const DOUYIN_SOURCE_TAB_IDS: Record<PlatformAccountSourceMode, string> = {
  like: 'semiTablike', collect: 'semiTabfavorite_collection', post: 'semiTabpost',
};
const DOUYIN_SOURCE_ENDPOINT_PATHS: Record<PlatformAccountSourceMode, PlatformAccountCaptureDiagnostics['endpoint_path']> = {
  like: '/aweme/v1/web/aweme/favorite/',
  collect: '/aweme/v1/web/aweme/listcollection/',
  post: '/aweme/v1/web/aweme/post/',
};

type SupportedBrowser = 'chrome' | 'msedge';
type StatusListener = (status: PlatformAccountStatus) => void;

interface PlatformCookie {
  name: string;
  value: string;
  domain: string;
}

export interface PlatformSourceCollection {
  urls: string[];
  items?: PlatformAccountItem[];
  coverage: 'complete' | 'limited' | 'partial';
  orderReliable: boolean;
  warning?: string;
  diagnostics?: PlatformAccountCaptureDiagnostics;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function boundedWindowAction(action: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([action, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('显示官方窗口超时，请从任务栏切换到本次窗口')), 4000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 显式恢复最小化窗口并激活标签；保留最大化等用户窗口状态。 */
export async function showPlatformAccountPage(page: Page): Promise<void> {
  await boundedWindowAction((async () => {
    const context = page.context?.();
    const session = context?.newCDPSession ? await context.newCDPSession(page).catch(() => null) : null;
    try {
      if (session) {
        try {
          const state = await session.send('Browser.getWindowForTarget');
          if (state.bounds.windowState === 'minimized') {
            await session.send('Browser.setWindowBounds', { windowId: state.windowId, bounds: { windowState: 'normal' } });
          }
        } catch { /* 浏览器不支持窗口状态指令时，仍尝试激活当前标签。 */ }
      }
      await page.bringToFront();
    } finally {
      if (session) await session.detach().catch(() => undefined);
    }
  })());
}

/** 本轮列表从官网重新读取；持久登录资料保留，HTTP/Service Worker 缓存不作为新首屏。 */
export async function prepareDouyinSourcePage(
  context: BrowserContext,
  page: Page,
  onDocumentCommitted?: (url: string) => void,
): Promise<() => Promise<void>> {
  const session = await context.newCDPSession(page);
  let removeDocumentListener = (): void => {};
  try {
    await session.send('Network.enable');
    await session.send('Network.setCacheDisabled', { cacheDisabled: true });
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    if (onDocumentCommitted) {
      await session.send('Page.enable');
      const initial = (await session.send('Page.getFrameTree')).frameTree.frame;
      let loaderId = initial.loaderId;
      const onFrame = ({ frame, type }: { frame: { id: string; parentId?: string; loaderId: string; url: string; unreachableUrl?: string }; type?: string }): void => {
        if (type === 'BackForwardCacheRestore' || frame.unreachableUrl || frame.parentId
          || frame.id !== initial.id || !frame.loaderId || frame.loaderId === loaderId) return;
        loaderId = frame.loaderId;
        onDocumentCommitted(frame.url);
      };
      // PW framenavigated 也包含 hash/history 同文档导航；只有新 loader 的 CDP 事件证明新主文档。
      session.on('Page.frameNavigated', onFrame);
      removeDocumentListener = () => { session.off('Page.frameNavigated', onFrame); };
    }
  } catch (error) {
    removeDocumentListener();
    await session.detach().catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    removeDocumentListener();
    await session.detach().catch(() => undefined);
  };
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

function firstUrl(value: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (typeof value === 'string') {
    const raw = value.trim();
    if (/^https:\/\//i.test(raw)) return raw;
    if (/^http:\/\//i.test(raw)) return `https://${raw.slice('http://'.length)}`;
    if (/^\/\//.test(raw)) return `https:${raw}`;
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  const payload = record(value);
  for (const candidate of list(payload.url_list)) {
    const url = firstUrl(candidate, depth + 1);
    if (url) return url;
  }
  return firstUrl(payload.url || payload.uri, depth + 1);
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

export function isDouyinSourceResponseUrl(
  value: string,
  mode: PlatformAccountSourceMode,
): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    // www-hj 等护航域不代表本人官方列表，不能拿它的响应确认来源顺序。
    if (url.protocol !== 'https:' || !['www.douyin.com', 'douyin.com'].includes(hostname)) return false;
    return DOUYIN_SOURCE_RESPONSE_PATHS[mode].test(url.pathname);
  } catch {
    return false;
  }
}

export function readDouyinSourceRecords(value: unknown): unknown[] {
  const payload = record(value);
  if (Array.isArray(payload.aweme_list)) return payload.aweme_list;
  return list(record(payload.data).aweme_list);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}

interface DouyinSourcePage {
  requestCursor: string;
  nextCursor: string | null;
  hasMore: boolean | undefined;
  items: PlatformAccountItem[];
  malformedItems: boolean;
}
type DouyinPageMap = Map<string, { sequence: number; page: DouyinSourcePage | null }>;

function douyinCursorKeys(url: URL): string[] {
  // 收藏用 cursor；喜欢/作品用 max_cursor。辅助游标可能同时存在且固定为 0。
  return DOUYIN_SOURCE_RESPONSE_PATHS.collect.test(url.pathname)
    ? ['cursor', 'max_cursor', 'min_cursor']
    : ['max_cursor', 'cursor', 'min_cursor'];
}

export interface DouyinSourceRequest {
  url: string;
  method?: string;
  postData?: string | null;
}

function douyinRequestCursor(request: DouyinSourceRequest): string | null {
  const url = new URL(request.url);
  let body: Record<string, unknown> = {};
  if (request.method?.toUpperCase() === 'POST' && request.postData) {
    try { body = record(JSON.parse(request.postData)); } catch {
      body = Object.fromEntries(new URLSearchParams(request.postData));
    }
  }
  const normalize = (value: unknown): string | null => {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
    const text = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return /^\d{1,32}$/.test(text) ? text.replace(/^0+(?=\d)/, '') : null;
  };
  for (const key of douyinCursorKeys(url)) {
    const inBody = Object.hasOwn(body, key);
    const inQuery = url.searchParams.has(key);
    if (!inBody && !inQuery) continue;
    const cursor = normalize(inBody ? body[key] : url.searchParams.get(key));
    if (inBody && inQuery && cursor !== normalize(url.searchParams.get(key))) return null;
    return cursor;
  }
  // 未采集到游标意味着页次未知，绝不能把滚动后的 POST 后页默认为首屏。
  return null;
}

/** 按官方游标链接组织页，不能把网络完成顺序或作品发布时间当作收藏顺序。 */
export class DouyinSourcePages {
  private pages: DouyinPageMap = new Map();
  private generationStart = -1;
  private previousGeneration: { start: number; pages: DouyinPageMap } | undefined;

  begin(input: string | DouyinSourceRequest, sequence: number): void {
    const cursor = douyinRequestCursor(typeof input === 'string' ? { url: input } : input);
    if (cursor === null) return;
    if (cursor === '0' && sequence > this.generationStart) {
      // 官网滚动时也会自动重发首屏；两轮分别保存，绝不把页混入另一轮。
      this.previousGeneration = { start: this.generationStart, pages: this.pages };
      this.pages = new Map();
      this.generationStart = sequence;
    }
    const previous = this.pages.get(cursor);
    if (!previous || previous.sequence <= sequence) this.pages.set(cursor, { sequence, page: null });
  }

  add(input: string | DouyinSourceRequest, value: unknown, sequence: number): boolean {
    const previousGeneration = sequence < this.generationStart;
    const pages = previousGeneration
      ? this.previousGeneration && sequence >= this.previousGeneration.start ? this.previousGeneration.pages : undefined
      : this.pages;
    if (!pages) return false;
    const request = typeof input === 'string' ? { url: input } : input;
    const requestCursor = douyinRequestCursor(request);
    if (requestCursor === null) return false;
    const payload = record(value);
    const data = Array.isArray(payload.aweme_list) ? payload : record(payload.data);
    if (!Array.isArray(data.aweme_list)) return false;
    if (payload.status_code !== undefined && payload.status_code !== 0 && payload.status_code !== '0') return false;
    const parsedUrl = new URL(request.url);
    const cursorValue = douyinCursorKeys(parsedUrl).map((key) => data[key])
      .find((value) => value !== undefined && value !== null);
    const normalized = data.aweme_list.map((entry, index) => {
      try { return normalizeDouyinRecord(entry, index); } catch { return null; }
    });
    const firstUnknown = normalized.findIndex((item) => item === null);
    const page: DouyinSourcePage = {
      requestCursor,
      nextCursor: cursorValue === undefined || cursorValue === null ? null : String(cursorValue),
      hasMore: optionalBoolean(data.has_more ?? data.hasMore),
      // 只取官方列表中连续可确认身份的前缀，不能跨过缺口后压缩排名。
      items: (firstUnknown < 0 ? normalized : normalized.slice(0, firstUnknown))
        .filter((item): item is PlatformAccountItem => item !== null),
      malformedItems: firstUnknown >= 0,
    };
    const previous = pages.get(requestCursor);
    if (!previous || previous.sequence <= sequence) pages.set(requestCursor, { sequence, page });
    return !previousGeneration;
  }

  diagnosticSummary(): Pick<PlatformAccountCaptureDiagnostics, 'first_page_cursor' | 'page_count'> {
    return {
      first_page_cursor: this.pages.get('0')?.page ? '0' : null,
      page_count: Math.min(1000, [...this.pages.values()].filter((entry) => entry.page !== null).length),
    };
  }

  snapshot(limit: number): PlatformSourceCollection {
    const current = this.snapshotPages(this.pages, limit);
    if (current.coverage !== 'partial' || !this.previousGeneration) return current;
    const first = this.pages.get('0')?.page;
    const previousFirst = this.previousGeneration.pages.get('0')?.page;
    const signature = (page: DouyinSourcePage): string => JSON.stringify([
      page.items.map((item) => item.videoId), page.nextCursor, page.hasMore, page.malformedItems,
    ]);
    const confirmed = (page: DouyinSourcePage): boolean => !page.malformedItems && page.hasMore !== undefined
      && (page.hasMore === false || Boolean(page.nextCursor && /^\d+$/.test(page.nextCursor)));
    // 最新首屏必须已确认，而且双方所有已返回的重叠页都相同。
    // 仅选用上一轮自身完整满足 N 的独立页链，不用旧页补新轮缺口。
    if (!first || !confirmed(first) || !previousFirst || signature(first) !== signature(previousFirst)) return current;
    for (const [cursor, entry] of this.pages) {
      if (!entry.page) continue;
      const previousPage = this.previousGeneration.pages.get(cursor)?.page;
      if (!confirmed(entry.page) || !previousPage || signature(entry.page) !== signature(previousPage)) return current;
    }
    if ([...this.previousGeneration.pages.values()].some((entry) => entry.page && !confirmed(entry.page))) return current;
    const previous = this.snapshotPages(this.previousGeneration.pages, limit);
    return previous.coverage !== 'partial' && (previous.items?.length || 0) >= limit ? previous : current;
  }

  private snapshotPages(pages: DouyinPageMap, limit: number): PlatformSourceCollection {
    const items = new Map<string, PlatformAccountItem>();
    const visited = new Set<string>();
    let cursor = '0';
    let ended = false;
    let malformedItems = false;
    while (!visited.has(cursor)) {
      visited.add(cursor);
      const page = pages.get(cursor)?.page;
      if (!page) break;
      for (const item of page.items) mergeDouyinItem(items, item, limit + 1);
      // 所需前 N 条已确认时，范围外的失效占位不影响本次前缀；也不能宣称全量完成。
      if (page.malformedItems) {
        malformedItems = items.size < limit;
        break;
      }
      if (page.hasMore === false) {
        ended = true;
        break;
      }
      if (items.size >= limit || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const values = [...items.values()].slice(0, limit)
      .map((item, sourceRank) => ({ ...item, sourceRank }));
    const coverage = malformedItems ? 'partial' : ended && items.size <= limit ? 'complete'
      : items.size >= limit ? 'limited' : 'partial';
    return {
      urls: values.map((item) => item.sourceUrl),
      items: values,
      coverage,
      orderReliable: Boolean(pages.get('0')?.page),
      warning: coverage === 'partial'
        ? values.length
          ? `已按官方顺序读取前 ${values.length} 条，其余作品本次未读取；历史资料保留`
          : '官方列表暂未返回可确认顺序的作品；历史资料保留'
        : coverage === 'limited' ? `本次读取前 ${limit} 条，未扫描全部作品` : undefined,
    };
  }
}

/** 在浏览器内执行：只沿目标标签的可见内容区寻找滚动容器，不使用页脚推荐链接。 */
export function scrollDouyinSourcePanel(input: { tabId: string; reset: boolean }): boolean {
  const tab = document.getElementById(input.tabId);
  if (!tab || tab.getAttribute('role') !== 'tab' || tab.getAttribute('aria-selected') !== 'true') return false;
  const visible = (element: Element): boolean => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && element.getAttribute('aria-hidden') !== 'true' && rect.width > 0 && rect.height > 0;
  };
  if (!visible(tab)) return false;
  const activePanel = (element: Element): boolean => {
    const style = getComputedStyle(element);
    // 官方 pane 实际只有零尺寸动画占位，卡片位于兄弟内容区。
    // 用精确 tab 的 aria 关联和活动状态定位共同滚动祖先，不能要求 pane 内必须存在视频链接。
    return element.getAttribute('role') === 'tabpanel' && element.getAttribute('aria-hidden') !== 'true'
      && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const controlledId = tab.getAttribute('aria-controls');
  const controlled = controlledId ? document.getElementById(controlledId) : null;
  const panel = controlled && activePanel(controlled)
    ? controlled
    : Array.from(document.querySelectorAll('[role="tabpanel"]'))
      .find((element) => element.getAttribute('aria-labelledby') === input.tabId && activePanel(element));
  if (!panel) return false;
  let target: Element | null = panel;
  while (target) {
    const style = getComputedStyle(target);
    if (/(auto|scroll)/.test(style.overflowY) && target.scrollHeight > target.clientHeight + 8) break;
    if (target === document.scrollingElement && target.scrollHeight > target.clientHeight + 8) break;
    target = target.parentElement;
  }
  if (!target) return false;
  const previousTop = target.scrollTop;
  if (input.reset) target.scrollTo({ top: 0, behavior: 'instant' });
  else target.scrollBy({ top: Math.max(target.clientHeight * 0.88, 720), behavior: 'instant' });
  return input.reset || target.scrollTop !== previousTop;
}

export function readBilibiliLikeRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const data = record(value);
  if (Array.isArray(data.list)) return data.list;
  return list(record(data.list).vlist);
}

type BilibiliRequest = (url: string) => Promise<unknown>;

export async function requestBilibiliJson(
  context: Pick<BrowserContext, 'request'>,
  url: string,
  cancelled: () => boolean = () => false,
  delay: (milliseconds: number) => Promise<void> = wait,
): Promise<unknown> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (cancelled()) throw new Error('同步已取消');
    let response;
    try {
      response = await context.request.get(url, {
        timeout: 15_000,
        headers: { Referer: 'https://space.bilibili.com/' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < 2 && /Timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message)) {
        await delay(600 * (2 ** attempt));
        continue;
      }
      throw error;
    }
    if (!response.ok()) {
      const status = response.status();
      await response.dispose();
      // 仅重试短暂网络/网关错误，不重试登录失败、429 或平台验证限制。
      if (attempt < 2 && [500, 502, 503, 504].includes(status)) {
        await delay(600 * (2 ** attempt));
        continue;
      }
      throw new Error(`B站账号接口暂不可用（${status}）`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = record(await response.json());
    } finally {
      // Playwright 的 APIResponse 默认缓存整个 body；逐页释放以限制同步内存。
      await response.dispose();
    }
    if (payload.code === undefined) throw new Error('B站账号接口返回格式异常，请稍后重试');
    if (payload.code !== 0 && payload.code !== '0') {
      const message = String(payload.message || payload.msg || '账号接口拒绝请求');
      throw new Error(`B站${message.slice(0, 80)}`);
    }
    return payload.data;
  }
  throw new Error('B站账号接口暂不可用，请稍后重试');
}

/** 点赞保留接口原序；多收藏夹按收藏时间归并，绝不使用视频发布时间补排序。 */
export async function collectBilibiliSource(
  request: BilibiliRequest,
  mode: PlatformAccountSourceMode,
  limit: number,
  cancelled: () => boolean = () => false,
): Promise<PlatformSourceCollection> {
  const nav = record(await request('https://api.bilibili.com/x/web-interface/nav'));
  const mid = numeric(nav.mid);
  if (!mid || nav.isLogin === false) throw new Error('B站登录状态无效，请重新登录');
  const urls: string[] = [];
  const seen = new Set<string>();
  let malformedItems = false;
  const append = (value: unknown): boolean => {
    const bvid = firstText(record(value).bvid);
    const url = bvid ? normalizeBilibiliUrl(`https://www.bilibili.com/video/${bvid}`) : null;
    if (!url) { malformedItems = true; return false; }
    if (seen.has(url)) return false;
    seen.add(url);
    urls.push(url);
    return true;
  };
  if (mode === 'like') {
    const fingerprints = new Set<string>();
    let ended = false;
    let warning = '';
    for (let page = 1; page <= Math.ceil(limit / 50) + 3 && urls.length < limit && !cancelled(); page += 1) {
      let data: unknown;
      try {
        data = await request(`https://api.bilibili.com/x/space/like/video?vmid=${mid}&pn=${page}&ps=50`);
      } catch (error) {
        if (!urls.length) throw error;
        warning = '后续点赞分页暂不可用，本次只读取了部分作品';
        break;
      }
      if (!Array.isArray(data) && !Array.isArray(record(data).list)
        && !Array.isArray(record(record(data).list).vlist)) {
        if (!urls.length) throw new Error('B站点赞分页格式异常，请稍后重试');
        warning = '后续点赞分页格式异常，本次只读取了部分作品';
        break;
      }
      const videos = readBilibiliLikeRecords(data);
      const fingerprint = JSON.stringify(videos.map((entry) => firstText(record(entry).bvid)));
      if (videos.length && fingerprints.has(fingerprint)) {
        warning = '平台返回了重复分页，本次只读取了部分作品';
        break;
      }
      fingerprints.add(fingerprint);
      for (const value of videos) append(value);
      const hasMore = optionalBoolean(record(data).has_more ?? record(data).hasMore);
      if (hasMore === false) {
        ended = true;
        break;
      }
      // 未声明 has_more 的短页不能证明完整：平台实际页大小可能低于请求值。
      if (videos.length === 0) break;
    }
    const coverage = warning || malformedItems ? 'partial'
      : ended && urls.length <= limit ? 'complete' : urls.length >= limit ? 'limited' : 'partial';
    return {
      urls: urls.slice(0, limit), coverage, orderReliable: true,
      warning: warning || (coverage === 'limited' ? `本次读取前 ${limit} 条，未扫描全部作品`
        : coverage === 'partial' ? '点赞分页尚未完整读取，请稍后重试' : undefined),
    };
  }

  const foldersData = record(await request(`https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`));
  if (!Array.isArray(foldersData.list)) throw new Error('B站收藏夹列表格式异常，请稍后重试');
  const allFolders = list(foldersData.list);
  const folders = allFolders.slice(0, MAX_BILIBILI_FOLDERS).map((value, index) => ({
    id: numeric(record(value).media_id ?? record(value).id ?? record(value).fid),
    index, page: 0, offset: 0, items: [] as unknown[], ended: false, confirmedEnd: false,
    fingerprints: new Set<string>(),
  }));
  let warning = allFolders.length > MAX_BILIBILI_FOLDERS ? '收藏夹数量超过本次读取上限，尚未覆盖全部收藏夹' : '';
  let orderReliable = !warning;
  let missingFavoriteTime = false;
  const fetchPage = async (folder: typeof folders[number]): Promise<void> => {
    if (cancelled() || folder.ended) return;
    if (folder.id <= 0) throw new Error('B站收藏夹缺少有效的资源 ID，请重试');
    if (folder.page >= Math.ceil(limit / 20) + 3) {
      warning = '收藏分页达到本次安全上限，尚未读取完整';
      folder.ended = true;
      return;
    }
    const data = record(await request(`https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&pn=${folder.page + 1}&ps=20&keyword=&order=mtime&type=0&tid=0&platform=web`));
    if (!Array.isArray(data.medias) && data.medias !== null) throw new Error('B站收藏分页格式异常，请稍后重试');
    const medias = list(data.medias);
    const fingerprint = JSON.stringify(medias.map((entry) => firstText(record(entry).bvid)));
    if (medias.length && folder.fingerprints.has(fingerprint)) {
      warning = '平台返回了重复收藏分页，本次只读取了部分作品';
      folder.ended = true;
      return;
    }
    folder.fingerprints.add(fingerprint);
    folder.page += 1;
    folder.items = medias;
    folder.offset = 0;
    const hasMore = optionalBoolean(data.has_more ?? data.hasMore);
    folder.confirmedEnd = hasMore === false;
    folder.ended = folder.confirmedEnd || medias.length === 0;
    if (medias.some((media) => !firstText(record(media).bvid))) malformedItems = true;
    if (folders.length > 1 && medias.some((media) => numeric(record(media).fav_time) <= 0)) {
      orderReliable = false;
      missingFavoriteTime = true;
    }
  };
  // 两个只读请求并行预取各收藏夹首屏。后续仅推进归并用到的夹，避免完整扫描每个夹。
  let nextFolder = 0;
  let firstScreenError: unknown;
  await Promise.all([0, 1].map(async () => {
    while (nextFolder < folders.length && !cancelled() && !firstScreenError) {
      try {
        await fetchPage(folders[nextFolder++]);
      } catch (error) {
        firstScreenError = error;
      }
    }
  }));
  if (firstScreenError) throw firstScreenError;
  while (urls.length < limit && !cancelled()) {
    const candidates = folders.filter((folder) => folder.offset < folder.items.length);
    if (!candidates.length) break;
    candidates.sort((left, right) => (
      numeric(record(right.items[right.offset]).fav_time) - numeric(record(left.items[left.offset]).fav_time)
      || left.index - right.index
    ));
    const folder = candidates[0];
    append(folder.items[folder.offset++]);
    if (folder.offset >= folder.items.length && !folder.ended && urls.length < limit) {
      try {
        await fetchPage(folder);
      } catch (error) {
        // 缺失任意夹的下一页后，其他夹的条目不再保证是全局下一条，因此在此停止。
        if (!urls.length) throw error;
        warning = '后续收藏分页暂不可用，本次只读取了部分作品';
        break;
      }
    }
  }
  const ended = folders.every((folder) => folder.confirmedEnd && folder.offset >= folder.items.length);
  const coverage = warning || malformedItems ? 'partial' : ended ? 'complete' : urls.length >= limit ? 'limited' : 'partial';
  return {
    urls: urls.slice(0, limit), coverage, orderReliable,
    warning: [warning, missingFavoriteTime ? '部分作品缺少收藏时间，跨收藏夹顺序暂无法完整校准' : '',
      coverage === 'limited' ? `本次读取前 ${limit} 条，未扫描全部作品`
        : coverage === 'partial' && !warning ? '收藏分页尚未完整读取，请稍后重试' : ''].filter(Boolean).join('；') || undefined,
  };
}

export async function readDouyinMetadataPayload(
  response: DouyinResponse,
  expectedMode?: PlatformAccountSourceMode,
): Promise<unknown | null> {
  const url = response.url();
  const accepted = expectedMode
    ? isDouyinSourceResponseUrl(url, expectedMode)
    : /douyin\.com/i.test(url) && /(aweme|favorite|collection|post|user|feed|detail|like)/i.test(url);
  if (!accepted) {
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
  private activeProfileKey = '';
  private activeSessionKey: string | undefined;
  private activeOperation: symbol | undefined;
  private activeMode: PlatformAccountSourceMode | undefined;
  private activeFocus: Promise<void> | null = null;
  private activeTargetPage: Page | null = null;
  private activeBrowser: SupportedBrowser = 'chrome';
  private restoredBrowser: { context: BrowserContext; browser: SupportedBrowser } | null = null;
  private retainedSession: RetainedDouyinSession | null = null;
  private closingSession: Promise<void> | null = null;
  private cancelled = false;
  private running = false;

  constructor(
    private readonly baseDirectory: () => string,
    private readonly notify: StatusListener,
    private readonly actionLocks = new CrossProcessActionLock(
      () => join(baseDirectory(), '..', 'platform-action-locks'),
    ),
  ) {}

  async login(request: PlatformAccountRequest): Promise<PlatformAccountResult> {
    return this.runExclusive(request, async () => {
      const profilePath = await this.profilePath(request);
      this.notifyStatus(request.platform, 'starting', '正在打开本机浏览器…');
      const launched = await this.launchBrowser(profilePath);
      this.activeContext = launched.context;
      this.activeBrowser = launched.browser;
      const page = launched.context.pages()[0] || await launched.context.newPage();
      const loginUrl = request.platform === 'bilibili'
        ? BILIBILI_LOGIN_URL
        : request.platform === 'douyin'
          ? DOUYIN_LOGIN_URL
          : XHS_LOGIN_URL;
      await page.goto(loginUrl, { waitUntil: 'commit', timeout: 20_000 })
        .catch(() => undefined);
      await showPlatformAccountPage(page).catch(() => undefined);
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
    return this.runExclusive(request, async () => {
      this.activeMode = request.mode;
      const profilePath = await this.profilePath(request);
      if (this.cancelled) return { success: false, cancelled: true, platform: request.platform };
      this.notifyStatus(request.platform, 'starting', '正在读取本机登录会话…');
      const launched = this.restoredBrowser || await this.launchBrowser(
        profilePath,
        request.platform === 'douyin' && !request.interactive,
      );
      this.restoredBrowser = null;
      this.activeBrowser = launched.browser;
      this.activeContext = launched.context;
      if (this.cancelled) return { success: false, cancelled: true, platform: request.platform };
      let windowNeedsAttention = false;
      if (request.interactive) {
        const page = launched.context.pages().find((candidate) => !candidate.isClosed?.()) || await launched.context.newPage();
        await showPlatformAccountPage(page).catch(() => { windowNeedsAttention = true; });
      }
      if (!hasPlatformAuthCookie(request.platform, await launched.context.cookies())) {
        throw new Error('账号登录已失效，请先重新登录');
      }
      this.notifyStatus(
        request.platform,
        'collecting',
        request.platform === 'douyin'
          ? request.targetVideoIds?.length ? '正在按指定视频更新播放地址…' : request.mode === 'collect'
            ? '正在自动打开抖音收藏并读取…'
            : request.mode === 'post'
              ? '正在自动打开抖音作品并读取…'
              : '正在自动打开抖音喜欢并读取…'
          : request.mode === 'collect'
            ? '正在读取最近收藏…'
            : request.mode === 'post'
              ? '正在读取最近发布的作品…'
              : '正在读取最近喜欢…',
        launched.browser,
      );
      if (windowNeedsAttention) {
        this.notifyStatus(request.platform, 'needs-action',
          '官方同步窗口已打开，请从任务栏切换到本次窗口查看；读取成功后会自动继续', launched.browser);
      }
      const collection = request.platform === 'douyin'
        ? request.targetVideoIds?.length
          ? await collectTargetedDouyinMedia(launched.context, request.targetVideoIds, {
            normalize: normalizeDouyinRecord, cancelled: () => this.cancelled,
            onProgress: (message) => this.notifyStatus('douyin', 'collecting', message, launched.browser),
            onActivePage: (page) => { this.activeTargetPage = page; },
            showPage: showPlatformAccountPage,
            onNeedsAction: (message) => this.notifyStatus('douyin', 'needs-action', message, launched.browser, 'DOUYIN_MEDIA_VERIFICATION_REQUIRED'),
          })
          : await this.collectDouyin(launched.context, request.mode, request.limit)
        : request.platform === 'bilibili'
        ? await this.collectBilibili(launched.context, request.mode, request.limit)
        : {
          urls: await this.collectXiaohongshu(launched.context, request.mode, request.limit),
          coverage: 'partial' as const,
          orderReliable: false,
          warning: '本次仅读取官方页面可见作品，未确认全部分页',
        };
      const { urls } = collection;
      if (this.cancelled) {
        return { success: false, cancelled: true, platform: request.platform };
      }
      if (urls.length === 0) {
        if (request.targetVideoIds?.length) {
          throw new Error('暂未取得指定作品的有效播放地址，请在官方窗口确认作品可播放或完成验证，再重试解析');
        }
        throw new Error(request.platform === 'bilibili'
          ? '没有读取到可同步的 B站作品，请确认账号列表可见'
          : request.platform === 'douyin'
            ? '没有读取到作品；若抖音出现验证，请在官方窗口完成后再重试'
            : '没有读取到可同步的小红书作品，请确认已进入自己的主页和对应标签');
      }
      this.notifyStatus(
        request.platform,
        'success',
        collection.warning || `已读取 ${urls.length} 条${request.mode === 'collect' ? '收藏' : request.mode === 'post' ? '自己的' : '喜欢'}作品`,
        launched.browser,
      );
      return {
        success: true,
        connected: true,
        platform: request.platform,
        mode: request.mode,
        ...collection,
        count: urls.length,
      };
    }, { sessionKey: request.sessionKey, keepSessionOpen: request.keepSessionOpen });
  }

  async cancel(request?: PlatformAccountSyncCancelRequest): Promise<PlatformAccountResult> {
    const sessionKey = request?.sessionKey;
    const scoped = request !== undefined;
    const activeMatches = this.running && (!scoped || (Boolean(sessionKey) && this.activeSessionKey === sessionKey));
    const retained = this.retainedSession;
    const retainedMatches = retained && (!scoped || (Boolean(sessionKey) && retained.sessionKey === sessionKey));
    if (scoped && !activeMatches && !retainedMatches) {
      return { success: false, platform: 'douyin', code: 'LOCAL_ACTION_NOT_FOUND', error: '本轮同步已经结束' };
    }
    const operation = this.activeOperation;
    const platform = activeMatches ? this.activePlatform : retainedMatches ? 'douyin' : this.activePlatform;
    const context = activeMatches ? this.activeContext : null;
    // 保留窗口可能属于上一批次；取消它时不能修改正在启动的新批次的取消状态。
    if (!scoped || activeMatches) this.cancelled = true;
    // 在第一个 await 前锁定并移出旧保留会话；后续清理绝不能读取新批次的会话。
    const closingRetained = retainedMatches ? this.closeRetainedSession(retained) : Promise.resolve();
    if (context) await context.close().catch(() => undefined);
    await closingRetained;
    // 关闭旧窗口期间可能开始了另一批次，旧取消事件不能污染其状态。
    if (this.activeOperation === operation && (!this.running || activeMatches)) {
      this.notifyStatus(platform, 'cancelled', '已取消平台账号操作');
    }
    return { success: false, cancelled: true, platform };
  }

  /** 只前置当前账号的现有操作窗口；不打开新会话，也不重新发起同步。 */
  async focus(request: PlatformAccountRequest): Promise<PlatformAccountResult> {
    const context = this.activeContext;
    if (!this.running || this.cancelled || !context
      || request.platform !== this.activePlatform || request.profileKey !== this.activeProfileKey) {
      return { success: false, platform: request.platform, code: 'LOCAL_ACTION_NOT_FOUND', error: '当前账号没有正在等待的官方窗口，请重新同步' };
    }
    const pages = context.pages();
    const target = this.activeTargetPage;
    const page = target && pages.includes(target) && !target.isClosed()
      ? target : pages.find((candidate) => !candidate.isClosed());
    if (!page) return { success: false, platform: request.platform, code: 'LOCAL_ACTION_NOT_FOUND', error: '官方窗口已关闭，请重新同步' };
    const focused = this.activeFocus || showPlatformAccountPage(page);
    this.activeFocus = focused;
    try {
      await focused;
      return { success: true, platform: request.platform, mode: this.activeMode };
    } catch {
      return { success: false, platform: request.platform, code: 'LOCAL_ACTION_NOT_FOUND', error: '官方窗口已关闭，请重新同步' };
    } finally {
      if (this.activeFocus === focused) this.activeFocus = null;
    }
  }

  async disconnect(request: PlatformAccountRequest): Promise<PlatformAccountResult> {
    return this.runExclusive(request, async () => {
      const profilePath = await this.profilePath(request, false);
      await rm(profilePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      this.notifyStatus(request.platform, 'disconnected', '本机平台登录已断开');
      return { success: true, connected: false, platform: request.platform };
    });
  }

  private async runExclusive(
    request: PlatformAccountRequest,
    action: () => Promise<PlatformAccountResult>,
    batch: { sessionKey?: string; keepSessionOpen?: boolean } = {},
  ): Promise<PlatformAccountResult> {
    const platform = request.platform;
    if (this.running) {
      return {
        success: false,
        platform,
        code: 'LOCAL_ACTION_BUSY',
        error: '已有平台账号操作正在进行',
      };
    }
    // 在任何 await 前占有本进程操作，防止两个账号同时通过 running 检查。
    this.running = true;
    this.cancelled = false;
    this.activePlatform = platform;
    this.activeProfileKey = request.profileKey;
    this.activeSessionKey = batch.sessionKey;
    this.activeOperation = Symbol();
    this.activeMode = undefined;
    this.activeTargetPage = null;
    let lease: DesktopActionLease | null = null;
    let result: PlatformAccountResult | null = null;
    try {
      if (this.closingSession) await this.closingSession;
      const retained = this.retainedSession;
      if (retained) {
        if (platform === 'douyin' && batch.sessionKey && retained.sessionKey === batch.sessionKey
          && retained.profileKey === request.profileKey
          && retained.context.pages().some((page) => !page.isClosed?.())) {
          clearTimeout(retained.timer);
          this.retainedSession = null;
          lease = retained.lease;
          this.restoredBrowser = { context: retained.context, browser: retained.browser };
          this.activeContext = retained.context;
        } else {
          await this.closeRetainedSession(retained);
        }
      }
      if (!lease) lease = await this.actionLocks.acquire(localPlatformLockKey(request.profileKey, platform));
      if (this.cancelled) return { success: false, cancelled: true, platform };
      result = normalizeLocalPlatformResult(platform, await action());
      return result;
    } catch (error) {
      if (this.cancelled) {
        return { success: false, cancelled: true, platform };
      }
      if (error instanceof LocalActionBusyError) return { success: false, platform, code: error.code, error: error.message };
      const message = publicError(platform, error);
      const code = error instanceof PlatformAccountActionError ? error.code
        : platform === 'douyin' && this.activeMode ? 'DOUYIN_SOURCE_CAPTURE_FAILED' : undefined;
      const mode = error instanceof PlatformAccountActionError ? error.mode : this.activeMode;
      this.notifyStatus(platform, 'error', message, undefined, code);
      return { success: false, platform, error: message, code, mode };
    } finally {
      const context = this.activeContext;
      this.activeContext = null;
      this.activeTargetPage = null;
      // 前置窗口与首屏完成可能同时发生，不能在窗口恢复操作尚未结束时关掉同一会话。
      if (this.activeFocus) await this.activeFocus.catch(() => undefined);
      if (context && lease && !this.cancelled && platform === 'douyin' && batch.sessionKey
        && batch.keepSessionOpen && result?.success && result.orderReliable === true
        && context.pages().some((page) => !page.isClosed?.())) {
        this.retainDouyinSession({ context, browser: this.activeBrowser, profileKey: request.profileKey,
          sessionKey: batch.sessionKey, lease });
        lease = null;
      } else if (context) {
        await context.close().catch(() => undefined);
      }
      if (lease) await lease.release().catch(() => undefined);
      this.running = false;
      this.activeProfileKey = '';
      this.activeSessionKey = undefined;
      this.activeMode = undefined;
      this.restoredBrowser = null;
    }
  }

  private retainDouyinSession(session: RetainedDouyinSession): void {
    this.retainedSession = session;
    session.timer = setTimeout(() => {
      if (this.retainedSession === session) void this.closeRetainedSession(session);
    }, DOUYIN_SESSION_IDLE_TIMEOUT_MS);
    session.timer.unref?.();
    session.context.once?.('close', () => {
      if (this.retainedSession === session) void this.closeRetainedSession(session);
    });
  }

  private async closeRetainedSession(session = this.retainedSession): Promise<void> {
    if (!session || this.retainedSession !== session) {
      if (this.closingSession) await this.closingSession;
      return;
    }
    this.retainedSession = null;
    clearTimeout(session.timer);
    const closing = (async () => {
      try { await session.context.close().catch(() => undefined); }
      finally { await session.lease.release().catch(() => undefined); }
    })();
    this.closingSession = closing;
    try { await closing; }
    finally { if (this.closingSession === closing) this.closingSession = null; }
  }

  private async profilePath(
    request: PlatformAccountRequest,
    create = true,
  ): Promise<string> {
    const base = this.baseDirectory();
    if (create) await mkdir(base, { recursive: true });
    return platformSessionPath(base, request.profileKey, request.platform);
  }

  private async launchBrowser(
    profilePath: string,
    background = false,
  ): Promise<{ context: BrowserContext; browser: SupportedBrowser }> {
    return launchIsolatedPlatformBrowser(profilePath, background);
  }

  private notifyStatus(
    platform: PlatformAccountProvider,
    stage: PlatformAccountStatus['stage'],
    message: string,
    browser?: SupportedBrowser,
    code?: string,
  ): void {
    this.notify({ platform, stage, message, browser, code, mode: this.activeMode });
  }

  private async requestBilibili(
    context: BrowserContext,
    url: string,
  ): Promise<unknown> {
    return requestBilibiliJson(context, url, () => this.cancelled);
  }

  private async collectBilibili(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<PlatformSourceCollection> {
    return collectBilibiliSource(
      (url) => this.requestBilibili(context, url), mode, limit, () => this.cancelled,
    );
  }

  private async collectXiaohongshu(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<string[]> {
    let page = context.pages()[0] || await context.newPage();
    await page.goto(XHS_LOGIN_URL, { waitUntil: 'commit', timeout: 20_000 })
      .catch(() => undefined);
    await showPlatformAccountPage(page).catch(() => undefined);
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

  private async selectDouyinTab(
    page: Page,
    platform: PlatformAccountProvider,
    mode: PlatformAccountSourceMode,
    browser: SupportedBrowser,
    assertContext?: () => void,
  ): Promise<void> {
    const label = mode === 'collect' ? '收藏' : mode === 'post' ? '作品' : '喜欢';
    // 抖音不同版本会在水合前后改变 role，甚至短暂移除固定 id。
    // 组合定位器可以复用官方固定 id，同时兼容可访问名称和文本定位。
    const tabCandidates = page.locator([
      `#${DOUYIN_SOURCE_TAB_IDS[mode]}`,
      `[role="tab"][aria-label="${label}"]`,
      `[role="tab"]:has-text("${label}")`,
    ].join(', '));
    // Playwright 提供 first()，测试替身和旧版桥接也可能直接返回单个定位器。
    const tab = typeof (tabCandidates as any).first === 'function'
      ? tabCandidates.first()
      : tabCandidates;
    let stableProfile = '';
    let readySince = 0;
    let selectedSince = 0;
    let clickAttempts = 0;
    let lastClickAt = 0;
    // 页面加载与标签选择分开计时，慢加载不能耗尽尚未开始的点击预算。
    const profileDeadline = Date.now() + 30_000;
    let selectionDeadline = 0;
    const confirmTab = async (allowClick: boolean): Promise<boolean> => {
      assertContext?.();
      let profile = '';
      try {
        const url = new URL(page.url());
        // 本人主页可以一直保留 /user/self，不能把是否跳转 secuid 当成已登录依据。
        if (url.protocol === 'https:' && url.hostname === 'www.douyin.com' && /^\/user\/[^/]+\/?$/.test(url.pathname)) profile = url.pathname;
      } catch { /* 等待官方本人主页加载。 */ }
      if (!profile || !await tab.isVisible().catch(() => false)) {
        readySince = selectedSince = 0;
        return false;
      }
      if (profile !== stableProfile) {
        stableProfile = profile;
        readySince = selectedSince = 0;
      }
      readySince ||= Date.now();
      if (Date.now() - readySince < 600) return false;
      selectionDeadline ||= Date.now() + 15_000;
      const ariaSelected = await tab.getAttribute('aria-selected').catch(() => null);
      const dataState = await tab.getAttribute('data-state').catch(() => null);
      const className = await tab.getAttribute('class').catch(() => null);
      const selected = ariaSelected === 'true'
        || dataState === 'active'
        || /active|selected|current/i.test(String(className || ''));
      if (selected) {
        selectedSince ||= Date.now();
        return Date.now() - selectedSince >= 600;
      }
      selectedSince = 0;
      // 官网水合期间点击可能无效；仅在仍未选中时有限重试，不能重复触发已选中的首屏。
      if (allowClick && clickAttempts < 3 && (clickAttempts === 0 || Date.now() - lastClickAt >= 2_000)) {
        clickAttempts += 1;
        await tab.click({ timeout: 3500, force: true }).catch(() => undefined);
        lastClickAt = Date.now();
        selectionDeadline = Math.max(selectionDeadline, lastClickAt + 1_500);
      }
      return false;
    };

    while (!this.cancelled && Date.now() < (selectionDeadline || profileDeadline)) {
      if (await confirmTab(true)) return;
      await page.waitForTimeout(200);
    }
    this.notifyStatus(
      platform,
      'needs-action',
      `抖音官方页面尚未就绪；请确认已进入本人主页，如有验证请完成，随后会继续读取“${label}”`,
      browser,
      DOUYIN_SOURCE_FIRST_PAGE_REQUIRED,
    );
    await showPlatformAccountPage(page).catch(() => undefined);
    const actionDeadline = Date.now() + XHS_PROFILE_TIMEOUT_MS;
    while (!this.cancelled && Date.now() < actionDeadline) {
      if (await confirmTab(true)) return;
      await page.waitForTimeout(200);
    }
    if (!this.cancelled) {
      throw new PlatformAccountActionError(`没有找到抖音“${label}”列表，请在官方窗口完成验证后重新同步；已有资料和顺序已保留`, DOUYIN_SOURCE_FIRST_PAGE_REQUIRED, mode);
    }
  }

  private async collectDouyin(
    context: BrowserContext,
    mode: PlatformAccountSourceMode,
    limit: number,
  ): Promise<PlatformSourceCollection> {
    const captureStartedAt = new Date().toISOString();
    const page = context.pages()[0] || await context.newPage();
    let releaseFreshness = async (): Promise<void> => {};
    let pages = new DouyinSourcePages();
    const pending = new Set<Promise<void>>();
    const requestSequences = new WeakMap<Request, { sequence: number; source: DouyinSourceRequest; documentEpoch: number }>();
    const activeRequests = new Set<Request>();
    let nextRequestSequence = 0;
    let lastRequestAt = Date.now();
    let responseRevision = 0;
    let ownProfileSeen = false;
    let ownAccount: string | null = null;
    let profileChanged = false;
    let documentEpoch = 0;
    let documentNavigationPending = true;
    const observedMethods = new Set<'GET' | 'POST'>();
    const readProfile = (value: string): string | null => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'www.douyin.com'
          && /^\/user\/[^/]+\/?$/.test(url.pathname) ? url.pathname.replace(/\/$/, '') : null;
      } catch { return null; }
    };
    const checkProfile = (value = page.url()): boolean => {
      // 复用窗口的旧 /user/self 不能证明本轮已加载；只在实际主文档提交后绑定。
      if (documentEpoch === 0) return !profileChanged;
      const profile = readProfile(value);
      // 从首次实际进入本人主页起保护，不留“等标签选完才绑定”的导航窗口。
      if (!ownProfileSeen) {
        if (profile === '/user/self') ownProfileSeen = true;
        return !profileChanged;
      }
      // /user/self 可以规范化为真实本人 ID，但必须有官方请求给出的账号证据。
      if (!profile || (profile !== '/user/self'
        && (!ownAccount || profile !== `/user/${ownAccount}`))) profileChanged = true;
      return !profileChanged;
    };
    const assertProfile = (): void => {
      if (page.isClosed?.()) throw new Error('登录或同步窗口已关闭');
      if (!checkProfile()) throw new Error('同步期间离开了本人抖音主页或切换了账号，本次结果未保存；请重新同步');
    };
    const browser = this.activeBrowser;
    let recoveryDeadline = 0;
    const ensureOfficialFirstPage = async (): Promise<void> => {
      if (this.cancelled || pages.snapshot(limit).orderReliable) return;
      // 标签选中并不等于首屏成功。先等正常网络返回，再保留同一监听会话供用户验证。
      const automaticDeadline = Date.now() + 10_000;
      while (!this.cancelled && Date.now() < automaticDeadline) {
        assertProfile();
        if (pages.snapshot(limit).orderReliable) return;
        await wait(200);
      }
      if (this.cancelled) return;
      const label = mode === 'collect' ? '收藏' : mode === 'post' ? '作品' : '喜欢';
      recoveryDeadline ||= Date.now() + DOUYIN_SOURCE_ACTION_TIMEOUT_MS;
      this.notifyStatus('douyin', 'needs-action',
        `请查看已打开的抖音窗口：如有登录或验证提示请先完成，再确认本人主页的“${label}”已显示；列表仍为空白时，刷新页面并重新点击“${label}”。读取成功后会自动继续，已有资料和顺序已保留。`,
        browser, DOUYIN_SOURCE_FIRST_PAGE_REQUIRED);
      await showPlatformAccountPage(page).catch(() => undefined);
      while (!this.cancelled && Date.now() < recoveryDeadline) {
        assertProfile();
        if (pages.snapshot(limit).orderReliable) {
          this.notifyStatus('douyin', 'collecting', `已读取抖音“${label}”首屏，正在继续同步…`, browser);
          return;
        }
        await wait(200);
      }
      if (!this.cancelled) {
        throw new PlatformAccountActionError(
          `抖音“${label}”列表还未读取成功，请按引导重新同步；已有资料和顺序已保留`,
          DOUYIN_SOURCE_FIRST_PAGE_REQUIRED, mode);
      }
    };
    const onDocumentCommitted = (url: string): void => {
      documentEpoch += 1;
      documentNavigationPending = false;
      // 刷新后的首屏必须重新确认，旧文档中在途的响应不能补进新页链。
      pages = new DouyinSourcePages();
      activeRequests.clear();
      pending.clear();
      observedMethods.clear();
      checkProfile(url);
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame()) checkProfile(frame.url());
    };
    const onRequest = (request: Request): void => {
      if (request.isNavigationRequest?.() && request.frame() === page.mainFrame()) {
        documentNavigationPending = true;
        pages = new DouyinSourcePages();
        activeRequests.clear();
        pending.clear();
        return;
      }
      if (documentNavigationPending || documentEpoch === 0) return;
      if (!checkProfile() || !ownProfileSeen) return;
      // 收藏 POST 没有账号字段。只从本人主页实际发出的作品/喜欢请求绑定身份，不能从作品作者推断。
      if (isDouyinSourceResponseUrl(request.url(), 'post') || isDouyinSourceResponseUrl(request.url(), 'like')) {
        const account = new URL(request.url()).searchParams.get('sec_user_id');
        if (account) {
          if (ownAccount && ownAccount !== account) profileChanged = true;
          else ownAccount = account;
        }
      }
      if (profileChanged) return;
      if (!isDouyinSourceResponseUrl(request.url(), mode)) return;
      const sequence = nextRequestSequence++;
      const source = { url: request.url(), method: request.method(), postData: request.postData() };
      requestSequences.set(request, { sequence, source, documentEpoch });
      pages.begin(source, sequence);
      activeRequests.add(request);
      lastRequestAt = Date.now();
    };
    const onRequestSettled = (request: Request): void => { activeRequests.delete(request); };
    const onResponse = (response: Response): void => {
      if (documentNavigationPending) return;
      if (!checkProfile()) return;
      if (!isDouyinSourceResponseUrl(response.url(), mode)) return;
      const captured = requestSequences.get(response.request());
      // 导航前已在途、未观察到请求起点的响应不能假装属于本轮首页。
      if (!captured || captured.documentEpoch !== documentEpoch || !response.ok()) return;
      const work = readDouyinMetadataPayload(response, mode)
        .then((payload) => {
          if (payload === null || documentNavigationPending
            || captured.documentEpoch !== documentEpoch || !checkProfile()) return;
          if (pages.add(captured.source, payload, captured.sequence)) {
            const method = captured.source.method;
            if (method === 'GET' || method === 'POST') observedMethods.add(method);
            responseRevision += 1;
          }
        })
        .catch(() => undefined);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    try {
      releaseFreshness = await prepareDouyinSourcePage(context, page, onDocumentCommitted).catch(() => {
        throw new PlatformAccountActionError('暂时无法确认抖音最新列表，请重新同步；已有资料和顺序已保留', DOUYIN_SOURCE_FIRST_PAGE_REQUIRED, mode);
      });
      // 在导航前注册以捕获首屏；只接受目标分类的官方列表接口。
      page.on('request', onRequest);
      page.on('requestfinished', onRequestSettled);
      page.on('requestfailed', onRequestSettled);
      page.on('response', onResponse);
      page.on('framenavigated', onFrameNavigated);
      const navigationEpoch = documentEpoch;
      documentNavigationPending = true;
      pages = new DouyinSourcePages();
      const targetTab = DOUYIN_SOURCE_TAB_QUERY[mode];
      await page.goto(`${DOUYIN_PROFILE_URL}&showTab=${targetTab}`, { waitUntil: 'commit', timeout: 25_000 })
        .catch(() => undefined);
      const documentDeadline = Date.now() + 2000;
      while (!this.cancelled && documentEpoch === navigationEpoch && Date.now() < documentDeadline) await wait(50);
      if (documentEpoch === navigationEpoch) {
        throw new PlatformAccountActionError('抖音本人主页未重新加载，请重新同步；已有资料和顺序已保留', DOUYIN_SOURCE_FIRST_PAGE_REQUIRED, mode);
      }
      assertProfile();
      await this.selectDouyinTab(page, 'douyin', mode, browser, assertProfile);
      // 未实际见到 /user/self，或缺少本人官方请求证据时，不能用任意 /user/id 自证身份。
      if (!ownProfileSeen || !readProfile(page.url())) profileChanged = true;
      assertProfile();
      await ensureOfficialFirstPage();
      let sourceScrollReset = false;
      let unchangedRounds = 0;
      for (let index = 0; index < MAX_DOUYIN_SCROLLS; index += 1) {
        if (this.cancelled) break;
        assertProfile();
        // 不无限等待一个流式/挂起的响应；只观察官方页面，不主动伪造签名或翻页请求。
        await Promise.race([Promise.allSettled([...pending]), wait(1500)]);
        if (!sourceScrollReset) {
          sourceScrollReset = await page.evaluate(scrollDouyinSourcePanel, { tabId: DOUYIN_SOURCE_TAB_IDS[mode], reset: true })
            .catch(() => false);
        }
        const before = pages.snapshot(limit);
        if (before.coverage !== 'partial') break;
        const responseBeforeScroll = responseRevision;
        const scrollAdvanced = await page.evaluate(scrollDouyinSourcePanel, { tabId: DOUYIN_SOURCE_TAB_IDS[mode], reset: false })
          .catch(() => false);
        const responseDeadline = Date.now() + 2200;
        while (!this.cancelled && Date.now() < responseDeadline
          && responseRevision === responseBeforeScroll && pages.snapshot(limit).coverage === 'partial') {
          await wait(200);
        }
        const after = pages.snapshot(limit);
        // 长列表尚未滚到底时数量会暂时不变，不能把正常滚动误判为分页停滞。
        unchangedRounds = after.urls.length === before.urls.length && !scrollAdvanced ? unchangedRounds + 1 : 0;
        if (after.coverage !== 'partial'
          || (unchangedRounds >= 5 && (activeRequests.size === 0 || Date.now() - lastRequestAt > 20_000))) break;
      }
      await Promise.race([Promise.allSettled([...pending]), wait(1500)]);
      // 滚动中官网可能重新请求首屏；不能把新首屏尚未确认的结果当成功返回。
      await ensureOfficialFirstPage();
    } finally {
      page.off('response', onResponse);
      page.off('request', onRequest);
      page.off('requestfinished', onRequestSettled);
      page.off('requestfailed', onRequestSettled);
      page.off('framenavigated', onFrameNavigated);
      await releaseFreshness();
    }
    assertProfile();
    const result = pages.snapshot(limit);
    if (!result.orderReliable && !this.cancelled) {
      throw new PlatformAccountActionError('抖音列表首屏尚未确认，请按引导重新同步；已有资料和顺序已保留', DOUYIN_SOURCE_FIRST_PAGE_REQUIRED, mode);
    }
    // 只输出固定白名单。请求 URL/query/body、账号 ID、Cookie 和响应头都不能进入诊断。
    result.diagnostics = {
      version: 1,
      platform: 'douyin',
      mode,
      capture_started_at: captureStartedAt,
      capture_finished_at: new Date().toISOString(),
      fresh_document_committed: documentEpoch > 0 && !documentNavigationPending,
      document_commit_count: Math.min(1000, documentEpoch),
      http_cache_bypassed: true,
      service_worker_bypassed: true,
      endpoint_path: DOUYIN_SOURCE_ENDPOINT_PATHS[mode],
      request_methods: [...observedMethods].sort(),
      ...pages.diagnosticSummary(),
      first_video_ids: (result.items || []).map((item) => item.videoId).filter((id) => /^\d{5,32}$/.test(id)).slice(0, 3),
    };
    return result;
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
