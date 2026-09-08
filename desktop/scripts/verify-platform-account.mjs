import assert from 'node:assert/strict';
import {
  boundedPlatformUrls,
  collectBilibiliSource,
  DouyinSourcePages,
  hasPlatformAuthCookie,
  isDouyinSourceResponseUrl,
  mergeDouyinItem,
  normalizeDouyinRecord,
  readDouyinMetadataPayload,
  readDouyinSourceRecords,
  requestBilibiliJson,
} from '../dist/platform-account.js';
import {
  validatePlatformAccountCollectRequest,
  validatePlatformAccountRequest,
} from '../dist/security.js';

assert.deepEqual(
  validatePlatformAccountRequest({
    platform: 'bilibili',
    profileKey: 'user_123-safe',
  }),
  { platform: 'bilibili', profileKey: 'user_123-safe' },
);

const normalizedDouyin = normalizeDouyinRecord({
  aweme_id: '7672579366093622537',
  desc: '来自接口的真实作品标题',
  create_time: 1787817600,
  author: { nickname: '真实作者' },
  video: {
    duration: 23000,
    cover: { url_list: ['https://p3.douyinpic.com/cover.jpg'] },
    play_addr: { url_list: ['https://v3-web.douyinvod.com/video.mp4?token=short-lived'] },
  },
}, 0);
assert.equal(normalizedDouyin?.title, '来自接口的真实作品标题');
assert.equal(normalizedDouyin?.authorName, '真实作者');
assert.equal(normalizedDouyin?.durationSeconds, 23);
assert.equal(
  normalizedDouyin?.ephemeralMediaUrl,
  'https://v3-web.douyinvod.com/video.mp4?token=short-lived',
);

const asyncHeaderPayload = await readDouyinMetadataPayload({
  url: () => 'https://www.douyin.com/aweme/v1/web/aweme/detail/',
  allHeaders: async () => ({ 'content-type': 'application/json; charset=utf-8' }),
  json: async () => ({ aweme_detail: { aweme_id: '7672579366093622537' } }),
});
assert.equal(asyncHeaderPayload?.aweme_detail?.aweme_id, '7672579366093622537');

assert.equal(
  isDouyinSourceResponseUrl(
    'https://www.douyin.com/aweme/v1/web/aweme/favorite/?cursor=0',
    'like',
  ),
  true,
);
assert.equal(
  isDouyinSourceResponseUrl(
    'https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=author',
    'like',
  ),
  false,
);
assert.equal(
  isDouyinSourceResponseUrl(
    'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=0',
    'collect',
  ),
  true,
);
assert.equal(
  isDouyinSourceResponseUrl(
    'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=1',
    'post',
  ),
  false,
);

const wrongModePayload = await readDouyinMetadataPayload({
  url: () => 'https://www.douyin.com/aweme/v1/web/aweme/post/?cursor=0',
  allHeaders: async () => ({ 'content-type': 'application/json' }),
  json: async () => ({ aweme_list: [{ aweme_id: 'post-id' }] }),
}, 'like');
assert.equal(wrongModePayload, null);

assert.deepEqual(
  readDouyinSourceRecords({
    aweme_list: [{ aweme_id: 'favorite-id' }],
    recommendations: { aweme_list: [{ aweme_id: 'unrelated-id' }] },
  }),
  [{ aweme_id: 'favorite-id' }],
);

const mergedItems = new Map();
mergeDouyinItem(mergedItems, {
  videoId: '7672579366093622537',
  sourceUrl: 'https://www.douyin.com/video/7672579366093622537',
  title: 'DOM 中的真实标题',
  caption: 'DOM 中的真实标题',
  authorName: '',
  coverUrl: 'https://p3.douyinpic.com/dom-cover.jpg',
  publishedAt: '',
  durationSeconds: 0,
  sourceRank: 0,
}, 50);
mergeDouyinItem(mergedItems, {
  videoId: '7672579366093622537',
  sourceUrl: 'https://www.douyin.com/video/7672579366093622537',
  title: '抖音作品',
  caption: '',
  authorName: '接口作者',
  coverUrl: '',
  publishedAt: '2026-08-27T00:00:00.000Z',
  durationSeconds: 25,
  sourceRank: 1,
  ephemeralMediaUrl: 'https://v3-web.douyinvod.com/video.mp4?token=temporary',
}, 50);
assert.deepEqual(mergedItems.get('7672579366093622537'), {
  videoId: '7672579366093622537',
  sourceUrl: 'https://www.douyin.com/video/7672579366093622537',
  title: 'DOM 中的真实标题',
  caption: 'DOM 中的真实标题',
  authorName: '接口作者',
  coverUrl: 'https://p3.douyinpic.com/dom-cover.jpg',
  publishedAt: '2026-08-27T00:00:00.000Z',
  durationSeconds: 25,
  sourceRank: 0,
  ephemeralMediaUrl: 'https://v3-web.douyinvod.com/video.mp4?token=temporary',
});

assert.throws(
  () => validatePlatformAccountRequest({
    platform: 'bilibili',
    profileKey: '../escape',
  }),
  /会话标识无效/,
);

assert.deepEqual(
  validatePlatformAccountCollectRequest({
    platform: 'douyin',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 100,
  }),
  {
    platform: 'douyin',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 100,
  },
);

assert.throws(
  () => validatePlatformAccountCollectRequest({
    platform: 'bilibili',
    profileKey: 'user_123-safe',
    mode: 'post',
    limit: 20,
  }),
  /不支持同步自己的作品/,
);

assert.throws(
  () => validatePlatformAccountCollectRequest({
    platform: 'xiaohongshu',
    profileKey: 'user_123-safe',
    mode: 'collect',
    limit: 101,
  }),
  /1–100/,
);

assert.equal(
  hasPlatformAuthCookie('bilibili', [
    { name: 'SESSDATA', value: 'secret', domain: '.bilibili.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('bilibili', [
    { name: 'SESSDATA', value: 'secret', domain: '.example.com' },
  ]),
  false,
);
assert.equal(
  hasPlatformAuthCookie('xiaohongshu', [
    { name: 'web_session', value: 'secret', domain: '.xiaohongshu.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('douyin', [
    { name: 'sessionid_ss', value: 'secret', domain: '.douyin.com' },
  ]),
  true,
);
assert.equal(
  hasPlatformAuthCookie('douyin', [
    { name: 'sessionid_ss', value: 'secret', domain: '.example.com' },
  ]),
  false,
);

assert.deepEqual(
  boundedPlatformUrls('bilibili', [
    'https://www.bilibili.com/video/BV1abc123?spm_id_from=333',
    'https://www.bilibili.com/video/BV1abc123',
    'https://example.com/video/BV1bad',
    'https://www.bilibili.com/video/BV2def456',
  ], 10),
  [
    'https://www.bilibili.com/video/BV1abc123',
    'https://www.bilibili.com/video/BV2def456',
  ],
);

assert.deepEqual(
  boundedPlatformUrls('xiaohongshu', [
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=token&foo=drop',
    'https://www.xiaohongshu.com/explore/abc123?xsec_token=token',
    'https://www.xiaohongshu.com/explore/def456?xsec_source=pc_user',
  ], 1),
  ['https://www.xiaohongshu.com/explore/abc123?xsec_token=token'],
);

assert.deepEqual(
  boundedPlatformUrls('douyin', [
    'https://www.douyin.com/video/7672579366093622537?from_tab_name=main',
    'https://www.douyin.com/video/7672579366093622537',
    'https://example.com/video/123456789',
    'https://www.douyin.com/user/example',
    'https://www.douyin.com/video/7672579366093622538',
  ], 100),
  [
    'https://www.douyin.com/video/7672579366093622537',
    'https://www.douyin.com/video/7672579366093622538',
  ],
);

// 抖音后页先完成、重复 ID、内嵌相关作品、缺页和重复游标均不能改变来源顺序。
const aweme = (id, created = 1) => ({ aweme_id: String(id), desc: `作品${id}`, create_time: created });
const douyinPageUrl = (cursor) => `https://www.douyin.com/aweme/v1/web/aweme/favorite/?max_cursor=${cursor}`;
const sourcePages = new DouyinSourcePages();
sourcePages.add(douyinPageUrl(90), {
  aweme_list: [aweme(10002, 999), aweme(10003, 500)], has_more: 0, max_cursor: 0,
}, 2);
assert.equal(sourcePages.snapshot(100).urls.length, 0, '缺少首屏，后页不能被误当作第 0 名');
sourcePages.add(douyinPageUrl(0), {
  aweme_list: [{ ...aweme(10001, 1), related: aweme(99999, 99999) }, aweme(10002, 999)],
  has_more: 1, max_cursor: 90,
}, 1);
const orderedDouyin = sourcePages.snapshot(100);
assert.deepEqual(orderedDouyin.items.map((item) => item.videoId), ['10001', '10002', '10003']);
assert.deepEqual(orderedDouyin.items.map((item) => item.sourceRank), [0, 1, 2]);
assert.equal(orderedDouyin.coverage, 'complete');
assert.equal(orderedDouyin.orderReliable, true);
assert.equal(sourcePages.snapshot(2).coverage, 'limited');
sourcePages.add(douyinPageUrl(0), { aweme_list: [aweme(10000)], has_more: false }, 0);
assert.equal(sourcePages.snapshot(100).items[0].videoId, '10001', '旧响应不能覆盖较新的同游标响应');

const missingPage = new DouyinSourcePages();
missingPage.add(douyinPageUrl(0), { aweme_list: [aweme(10001)], has_more: 1, max_cursor: 90 }, 1);
missingPage.add(douyinPageUrl(80), { aweme_list: [aweme(10003)], has_more: 0 }, 3);
assert.equal(missingPage.snapshot(10).coverage, 'partial');
assert.deepEqual(missingPage.snapshot(10).items.map((item) => item.videoId), ['10001']);
missingPage.add(douyinPageUrl(90), { aweme_list: [aweme(10002)], has_more: 1, max_cursor: 90 }, 2);
assert.equal(missingPage.snapshot(10).coverage, 'partial', '重复游标不能被标成完整');

const emptyPage = new DouyinSourcePages();
assert.equal(emptyPage.add(douyinPageUrl(0), { status_code: 9, aweme_list: [], has_more: 0 }, 0), false);
assert.equal(emptyPage.add(douyinPageUrl(0), {
  aweme_list: [], data: { aweme_list: [aweme(99999)] }, has_more: 0,
}, 1), true);
assert.equal(emptyPage.snapshot(10).coverage, 'complete');
assert.equal(emptyPage.snapshot(10).urls.length, 0, '真实空列表不能降级为内嵌其他列表');
const collectionCursors = new DouyinSourcePages();
collectionCursors.add('https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=0', {
  aweme_list: [aweme(10001)], cursor: 8, max_cursor: 0, has_more: true,
}, 1);
collectionCursors.add('https://www.douyin.com/aweme/v1/web/aweme/listcollection/?cursor=8', {
  aweme_list: [aweme(10002)], cursor: 0, max_cursor: 0, has_more: false,
}, 2);
assert.equal(collectionCursors.snapshot(10).coverage, 'complete', '使用本接口的 cursor 而不是其他接口的 max_cursor');
assert.equal(collectionCursors.snapshot(10).urls.length, 2);
assert.equal(normalizeDouyinRecord(aweme(10001), 0).ephemeralMediaUrl, undefined, '图文缺少视频地址不能无限递归');
const refreshedPages = new DouyinSourcePages();
refreshedPages.begin(douyinPageUrl(0), 0);
refreshedPages.add(douyinPageUrl(0), { aweme_list: [aweme(10001)], max_cursor: 9, has_more: true }, 0);
refreshedPages.begin(douyinPageUrl(9), 1);
refreshedPages.add(douyinPageUrl(9), { aweme_list: [aweme(10002)], has_more: false }, 1);
assert.equal(refreshedPages.snapshot(10).coverage, 'complete');
refreshedPages.begin(douyinPageUrl(0), 2);
assert.equal(refreshedPages.snapshot(10).orderReliable, false, '刷新失败不能复用旧首屏的完整标志');
refreshedPages.add(douyinPageUrl(0), { aweme_list: [aweme(10003)], max_cursor: 9, has_more: true }, 2);
assert.equal(refreshedPages.snapshot(10).coverage, 'partial', '新首屏不能拼接旧一轮后页后报告完整');
assert.equal(refreshedPages.add(douyinPageUrl(9), { aweme_list: [aweme(10002)], has_more: false }, 1), false);
const malformedDouyinPage = new DouyinSourcePages();
malformedDouyinPage.add(douyinPageUrl(0), { aweme_list: [aweme(10001), { removed: true }], has_more: false }, 0);
assert.equal(malformedDouyinPage.snapshot(10).coverage, 'partial', '丢失成员身份时禁止完整快照清理');

const bilibiliUrl = (id) => `https://www.bilibili.com/video/BV${id}`;
const liked = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  return { list: { vlist: [
    { bvid: 'BVoldPublished', created: 1 },
    { bvid: 'BVnewPublished', created: 99999999 },
    { bvid: 'BVoldPublished', created: 1 },
  ] }, has_more: false };
}, 'like', 10);
assert.deepEqual(liked.urls, [bilibiliUrl('oldPublished'), bilibiliUrl('newPublished')]);
assert.equal(liked.coverage, 'complete');
const ambiguousLikeEnd = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  return new URL(url).searchParams.get('pn') === '1' ? { list: [{ bvid: 'BVfirst' }] } : { list: [] };
}, 'like', 10);
assert.equal(ambiguousLikeEnd.coverage, 'partial', '短页和未知空页不是 has_more=false 证据');
const malformedLikeEnd = await collectBilibiliSource(async (url) => (
  url.endsWith('/nav') ? { mid: 123 } : { list: [{ bvid: 'BVfirst' }, { removed: true }], has_more: false }
), 'like', 10);
assert.equal(malformedLikeEnd.coverage, 'partial');
const confirmedEmptyLikes = await collectBilibiliSource(async (url) => (
  url.endsWith('/nav') ? { mid: 123 } : { list: [], has_more: false }
), 'like', 10);
assert.equal(confirmedEmptyLikes.coverage, 'complete');
assert.deepEqual(confirmedEmptyLikes.urls, []);

const requests = [];
const firstLikes = Array.from({ length: 50 }, (_, index) => ({ bvid: `BVlike${index}`, created: index }));
const pagedLikes = await collectBilibiliSource(async (url) => {
  requests.push(url);
  if (url.endsWith('/nav')) return { mid: 123 };
  return new URL(url).searchParams.get('pn') === '1'
    ? { list: firstLikes, has_more: true }
    : { list: [{ bvid: 'BVlike49' }, { bvid: 'BVlike50' }], has_more: false };
}, 'like', 100);
assert.equal(pagedLikes.urls.length, 51);
assert.equal(pagedLikes.urls[50], bilibiliUrl('like50'));
assert.equal(requests.length, 3);
assert.equal(pagedLikes.coverage, 'complete');
const repeatedLikes = await collectBilibiliSource(async (url) => (
  url.endsWith('/nav') ? { mid: 123 } : { list: firstLikes, has_more: true }
), 'like', 100);
assert.equal(repeatedLikes.coverage, 'partial');
assert.match(repeatedLikes.warning, /重复分页/);
const interruptedLikes = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (new URL(url).searchParams.get('pn') === '1') return { list: firstLikes, has_more: true };
  throw new Error('网络中断');
}, 'like', 100);
assert.equal(interruptedLikes.coverage, 'partial');
assert.equal(interruptedLikes.urls.length, 50);

// 最新收藏在后一个收藏夹时也必须入选；同视频多夹只出现一次。
const folderRequests = [];
const favorites = await collectBilibiliSource(async (url) => {
  folderRequests.push(url);
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ media_id: 11, fid: 0 }, { id: 22 }] };
  const params = new URL(url).searchParams;
  assert.equal(params.get('order'), 'mtime');
  if (params.get('media_id') === '11') return {
    medias: [{ bvid: 'BVshared', fav_time: 80 }, { bvid: 'BVfirstFolder', fav_time: 20, pubtime: 99999 }], has_more: false,
  };
  return { medias: [{ bvid: 'BVlatest', fav_time: 100 }, { bvid: 'BVshared', fav_time: 90 }], has_more: false };
}, 'collect', 2);
assert.deepEqual(favorites.urls, [bilibiliUrl('latest'), bilibiliUrl('shared')]);
assert.equal(favorites.coverage, 'limited');
assert.equal(folderRequests.filter((url) => url.includes('resource/list')).length, 2);

let activeRequests = 0;
let peakRequests = 0;
const manyFolders = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: Array.from({ length: 5 }, (_, index) => ({ id: index + 1 })) };
  activeRequests += 1;
  peakRequests = Math.max(peakRequests, activeRequests);
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeRequests -= 1;
  const id = Number(new URL(url).searchParams.get('media_id'));
  return { medias: [{ bvid: `BVfolder${id}`, fav_time: id }], has_more: false };
}, 'collect', 10);
assert.equal(peakRequests, 2, '最多两个只读分页并行');
assert.deepEqual(manyFolders.urls, [5, 4, 3, 2, 1].map((id) => bilibiliUrl(`folder${id}`)));
assert.equal(manyFolders.coverage, 'complete');

const lazyPages = [];
const lazyFavorites = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ id: 1 }, { id: 2 }] };
  const params = new URL(url).searchParams;
  const folder = params.get('media_id');
  const page = params.get('pn');
  lazyPages.push(`${folder}:${page}`);
  if (folder === '2') return { medias: [{ bvid: 'BVolder', fav_time: 1 }], has_more: false };
  return page === '1'
    ? { medias: [{ bvid: 'BVnewest', fav_time: 100 }], has_more: true }
    : { medias: [{ bvid: 'BVnext', fav_time: 90 }], has_more: false };
}, 'collect', 2);
assert.deepEqual(lazyFavorites.urls, [bilibiliUrl('newest'), bilibiliUrl('next')]);
assert.deepEqual(lazyPages.sort(), ['1:1', '1:2', '2:1']);
const interruptedFavorites = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ id: 1 }, { id: 2 }] };
  const params = new URL(url).searchParams;
  if (params.get('media_id') === '2') return { medias: [{ bvid: 'BVolder', fav_time: 1 }], has_more: false };
  if (params.get('pn') === '1') return { medias: [{ bvid: 'BVnewest', fav_time: 100 }], has_more: true };
  throw new Error('网络中断');
}, 'collect', 10);
assert.equal(interruptedFavorites.coverage, 'partial');
assert.deepEqual(interruptedFavorites.urls, [bilibiliUrl('newest')], '一个夹缺页后不能把另一个夹的旧条目当作紧邻下一条');

const unknownFavTime = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ id: 1 }, { id: 2 }] };
  return { medias: [{ bvid: `BV${new URL(url).searchParams.get('media_id')}`, pubtime: 999999 }], has_more: false };
}, 'collect', 10);
assert.equal(unknownFavTime.orderReliable, false);
assert.match(unknownFavTime.warning, /缺少收藏时间/);
const ambiguousFavoriteEnd = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ id: 1 }] };
  return new URL(url).searchParams.get('pn') === '1'
    ? { medias: [{ bvid: 'BVfirst', fav_time: 1 }] } : { medias: [] };
}, 'collect', 10);
assert.equal(ambiguousFavoriteEnd.coverage, 'partial');
const malformedFavoriteEnd = await collectBilibiliSource(async (url) => {
  if (url.endsWith('/nav')) return { mid: 123 };
  if (url.includes('list-all')) return { list: [{ id: 1 }] };
  return { medias: [{ bvid: 'BVfirst', fav_time: 1 }, { removed: true }], has_more: false };
}, 'collect', 10);
assert.equal(malformedFavoriteEnd.coverage, 'partial');
await assert.rejects(() => collectBilibiliSource(async (url) => (
  url.endsWith('/nav') ? { mid: 123 } : { unexpected: 'not a list' }
), 'like', 10), /格式异常/);

// 502/超时才有限退避重试；鉴权和平台风控拒绝不重试，每页 body 都释放。
let attempts = 0;
let disposed = 0;
const delays = [];
const response = (status, payload) => ({
  ok: () => status === 200, status: () => status,
  json: async () => payload,
  dispose: async () => { disposed += 1; },
});
const retried = await requestBilibiliJson({ request: { get: async () => {
  attempts += 1;
  return attempts === 1 ? response(502, {}) : response(200, { code: 0, data: { list: [] } });
} } }, 'https://api.bilibili.com/x/test', () => false, async (ms) => { delays.push(ms); });
assert.deepEqual(retried, { list: [] });
assert.equal(attempts, 2);
assert.equal(disposed, 2);
assert.deepEqual(delays, [600]);
attempts = 0;
await assert.rejects(() => requestBilibiliJson({ request: { get: async () => {
  attempts += 1;
  return response(429, {});
} } }, 'https://api.bilibili.com/x/test', () => false, async () => {}), /429/);
assert.equal(attempts, 1);
attempts = 0;
await assert.rejects(() => requestBilibiliJson({ request: { get: async () => {
  attempts += 1;
  return response(200, { code: -352, message: '请完成验证' });
} } }, 'https://api.bilibili.com/x/test', () => false, async () => {}), /验证/);
assert.equal(attempts, 1);
attempts = 0;
const timeoutDelays = [];
await assert.rejects(() => requestBilibiliJson({ request: { get: async () => {
  attempts += 1;
  throw new Error('ETIMEDOUT');
} } }, 'https://api.bilibili.com/x/test', () => false, async (ms) => { timeoutDelays.push(ms); }), /ETIMEDOUT/);
assert.equal(attempts, 3);
assert.deepEqual(timeoutDelays, [600, 1200]);
attempts = 0;
await assert.rejects(() => requestBilibiliJson({ request: { get: async () => {
  attempts += 1;
  return response(200, { code: 0, data: {} });
} } }, 'https://api.bilibili.com/x/test', () => true, async () => {}), /取消/);
assert.equal(attempts, 0);

console.log('platform-account verification passed (source order, coverage, pagination, bounded retries)');
