import assert from 'node:assert/strict';
import {
  boundedPlatformUrls,
  collectBilibiliSource,
  DouyinSourcePages,
  PlatformAccountConnector,
  hasPlatformAuthCookie,
  isDouyinSourceResponseUrl,
  mergeDouyinItem,
  normalizeDouyinRecord,
  readDouyinMetadataPayload,
  readDouyinSourceRecords,
  requestBilibiliJson,
  scrollDouyinSourcePanel,
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
const mixedCollectionUrl = (cursor) => `https://www.douyin.com/aweme/v1/web/aweme/listcollection/?max_cursor=0&cursor=${cursor}&min_cursor=0`;
const mixedCollectionCursors = new DouyinSourcePages();
mixedCollectionCursors.begin(mixedCollectionUrl(0), 0);
mixedCollectionCursors.add(mixedCollectionUrl(0), {
  aweme_list: [aweme(10001)], cursor: 8, max_cursor: 0, has_more: true,
}, 0);
mixedCollectionCursors.begin(mixedCollectionUrl(8), 1);
assert.deepEqual(mixedCollectionCursors.snapshot(10).items.map((item) => item.videoId), ['10001'],
  '收藏后页携带 max_cursor=0 不能清空已确认首屏');
mixedCollectionCursors.add(mixedCollectionUrl(8), {
  aweme_list: [aweme(10002)], cursor: 0, max_cursor: 0, has_more: false,
}, 1);
assert.equal(mixedCollectionCursors.snapshot(10).coverage, 'complete');
assert.deepEqual(mixedCollectionCursors.snapshot(10).items.map((item) => item.videoId), ['10001', '10002']);
mixedCollectionCursors.begin(mixedCollectionUrl(0), 2);
assert.equal(mixedCollectionCursors.add(mixedCollectionUrl(8), {
  aweme_list: [aweme(10002)], has_more: false,
}, 1), false, '混合游标仍需拒绝上一轮晚到后页');
assert.equal(mixedCollectionCursors.snapshot(10).orderReliable, false);

for (const source of ['favorite', 'post']) {
  const mixedUrl = (cursor) => `https://www.douyin.com/aweme/v1/web/aweme/${source}/?cursor=0&max_cursor=${cursor}&min_cursor=0`;
  const mixedPages = new DouyinSourcePages();
  mixedPages.begin(mixedUrl(0), 0);
  mixedPages.add(mixedUrl(0), { aweme_list: [aweme(10001)], cursor: 0, max_cursor: 90, has_more: true }, 0);
  mixedPages.begin(mixedUrl(90), 1);
  mixedPages.add(mixedUrl(90), { aweme_list: [aweme(10002)], cursor: 0, max_cursor: 0, has_more: false }, 1);
  assert.equal(mixedPages.snapshot(10).coverage, 'complete', `${source} 仍使用 max_cursor`);
  assert.deepEqual(mixedPages.snapshot(10).items.map((item) => item.videoId), ['10001', '10002']);
}
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
// 现场喜欢列表在第三页在途时自动重发首屏；保留独立旧轮，不能混页或丢掉已读前 50 条。
const automaticRefresh = (lastFirst = Array.from({ length: 20 }, (_, i) => aweme(20000 + i))) => {
  const pages = new DouyinSourcePages();
  const response = (offset, next) => ({ aweme_list: Array.from({ length: 20 }, (_, i) => aweme(20000 + offset + i)), max_cursor: next, has_more: true });
  pages.begin(douyinPageUrl(0), 0);
  pages.add(douyinPageUrl(0), response(0, 90), 0);
  pages.begin(douyinPageUrl(90), 1);
  pages.add(douyinPageUrl(90), response(20, 80), 1);
  pages.begin(douyinPageUrl(80), 2);
  pages.begin(douyinPageUrl(0), 3);
  assert.equal(pages.snapshot(50).orderReliable, false, '重发首屏尚未返回时不能用旧轮代替');
  assert.equal(pages.add(douyinPageUrl(80), response(40, 70), 2), false, '晚到页仍归上一轮');
  pages.add(douyinPageUrl(0), { aweme_list: lastFirst, max_cursor: 90, has_more: true }, 3);
  return pages;
};
const identicalRefresh = automaticRefresh();
assert.deepEqual(identicalRefresh.snapshot(50).items.map(item => item.videoId), Array.from({ length: 50 }, (_, i) => String(20000 + i)));
assert.equal(identicalRefresh.snapshot(50).coverage, 'limited');
assert.equal(identicalRefresh.snapshot(70).items.length, 20, '上一轮不足 N 时不能跨轮补缺口');
const changedRefresh = automaticRefresh([aweme(99999), ...Array.from({ length: 19 }, (_, i) => aweme(20001 + i))]);
assert.equal(changedRefresh.snapshot(50).items.length, 20, '最新首屏变化后不能返回旧轮');
assert.equal(changedRefresh.snapshot(50).items[0].videoId, '99999');
changedRefresh.begin(douyinPageUrl(90), 4);
changedRefresh.add(douyinPageUrl(90), { aweme_list: Array.from({ length: 40 }, (_, i) => aweme(30000 + i)), max_cursor: 70, has_more: true }, 4);
assert.equal(changedRefresh.snapshot(50).coverage, 'limited');
assert.equal(changedRefresh.snapshot(50).items[20].videoId, '30000', '新轮自身满足 N 时始终使用新轮');
for (const headFields of [{ max_cursor: 90 }, { has_more: true }, { max_cursor: 90, has_more: undefined }]) {
  const pages = new DouyinSourcePages();
  const head = { aweme_list: [aweme(40000), aweme(40001)], ...headFields };
  pages.begin(douyinPageUrl(0), 0);
  pages.add(douyinPageUrl(0), head, 0);
  pages.begin(douyinPageUrl(90), 1);
  pages.add(douyinPageUrl(90), { aweme_list: [aweme(40002), aweme(40003)], max_cursor: 80, has_more: true }, 1);
  pages.begin(douyinPageUrl(0), 2);
  pages.add(douyinPageUrl(0), head, 2);
  assert.equal(pages.snapshot(3).items.length, 2, '未知 has_more/游标不能确认两轮等价');
}
const malformedRefresh = automaticRefresh([aweme(20000), { removed: true }]);
assert.equal(malformedRefresh.snapshot(50).items.length, 1, '最新首屏身份缺口不能回退旧轮');
identicalRefresh.begin(douyinPageUrl(90), 4);
identicalRefresh.add(douyinPageUrl(90), { aweme_list: [aweme(99998)], max_cursor: 80, has_more: true }, 4);
assert.equal(identicalRefresh.snapshot(50).items.length, 21, '首屏相同但后页变化也不能回退旧轮');
identicalRefresh.begin(douyinPageUrl(0), 5);
identicalRefresh.add(douyinPageUrl(0), { aweme_list: Array.from({ length: 20 }, (_, i) => aweme(20000 + i)), max_cursor: 90, has_more: true }, 5);
assert.equal(identicalRefresh.snapshot(50).items.length, 20, '只保留相邻两轮，不能搜索更老的完整列表');
const malformedDouyinPage = new DouyinSourcePages();
malformedDouyinPage.add(douyinPageUrl(0), { aweme_list: [aweme(10001), { removed: true }], has_more: false }, 0);
assert.equal(malformedDouyinPage.snapshot(10).coverage, 'partial', '丢失成员身份时禁止完整快照清理');
assert.equal(malformedDouyinPage.snapshot(1).coverage, 'limited', '范围外的失效项不妨碍可信前 N 条完成');
assert.equal(malformedDouyinPage.snapshot(1).orderReliable, true);
assert.doesNotMatch(malformedDouyinPage.snapshot(1).warning, /重试|未完整/);
assert.match(malformedDouyinPage.snapshot(10).warning, /已按官方顺序读取前 1 条/);
assert.doesNotMatch(malformedDouyinPage.snapshot(10).warning, /重试|未完整/);
const interruptedPrefix = new DouyinSourcePages();
interruptedPrefix.add(douyinPageUrl(0), {
  aweme_list: [aweme(10001), { removed: true }, aweme(10002)], max_cursor: 9, has_more: true,
}, 0);
interruptedPrefix.add(douyinPageUrl(9), { aweme_list: [aweme(10003)], has_more: false }, 1);
assert.deepEqual(interruptedPrefix.snapshot(10).items.map((item) => item.videoId), ['10001'],
  '不能越过无身份项，把后续作品伪装成连续的前几条');
assert.equal(interruptedPrefix.snapshot(10).coverage, 'partial');
assert.equal(interruptedPrefix.snapshot(10).orderReliable, true, '缺口之前的真实前缀仍可同步');
const unknownFirst = new DouyinSourcePages();
unknownFirst.add(douyinPageUrl(0), { aweme_list: [{ removed: true }, aweme(10001)], has_more: false }, 0);
assert.deepEqual(unknownFirst.snapshot(10).urls, []);
assert.equal(unknownFirst.snapshot(10).coverage, 'partial');
assert.doesNotMatch(unknownFirst.snapshot(10).warning, /已按官方顺序读取/);
const unknownEnd = new DouyinSourcePages();
unknownEnd.add(douyinPageUrl(0), { aweme_list: [aweme(10001)] }, 0);
assert.equal(unknownEnd.snapshot(10).coverage, 'partial', '可信短前缀不能冒充列表已结束');
assert.match(unknownEnd.snapshot(10).warning, /已按官方顺序读取前 1 条/);

// 2026-09-09 官方收藏请求结构：保留 POST 游标与页链模式，作品 ID 全部使用合成值。
const capturedCollectionPages = [
  { cursor: '0', next: 1786455691150973 },
  { cursor: '1786455691150973', next: 1785257438561061 },
  { cursor: '1785257438561061', next: 1783946015168741 },
  { cursor: '1783946015168741', next: 1781868714026829 },
].map((page, index) => ({ ...page, ids: Array.from({ length: 10 }, (_, offset) => String(7000000000000000000n + BigInt(index * 10 + offset))) }));
const capturedCollectionUrl = 'https://www.douyin.com/aweme/v1/web/aweme/listcollection/?device_platform=webapp';
for (const encoding of ['form', 'json']) {
  const pages = new DouyinSourcePages();
  const requests = capturedCollectionPages.map((entry) => ({
    url: capturedCollectionUrl, method: 'POST',
    postData: encoding === 'form'
      ? new URLSearchParams({ cursor: entry.cursor, count: '10' }).toString()
      : JSON.stringify({ cursor: entry.cursor, count: '10' }),
  }));
  requests.forEach((request, index) => pages.begin(request, index));
  for (const index of [3, 1, 0, 2]) {
    const captured = capturedCollectionPages[index];
    assert.equal(pages.add(requests[index], {
      status_code: 0, aweme_list: captured.ids.map((id) => aweme(id)), cursor: captured.next, has_more: 1,
    }, index), true);
  }
  const result = pages.snapshot(50);
  assert.deepEqual(result.items.map((item) => item.videoId), capturedCollectionPages.flatMap((entry) => entry.ids));
  assert.equal(result.items[30].sourceRank, 30, '第四页不能再冒充首屏 rank 0');
  assert.equal(result.coverage, 'partial', '四十条未达到五十且 has_more=1，不能冒充全部');
  assert.equal(result.orderReliable, true);
  assert.deepEqual(pages.snapshot(3).items.map((item) => item.videoId), capturedCollectionPages[0].ids.slice(0, 3));
  assert.equal(pages.snapshot(3).coverage, 'limited');
}
for (const request of [
  { url: capturedCollectionUrl, method: 'POST', postData: 'count=10' },
  { url: capturedCollectionUrl, method: 'POST', postData: 'cursor=undefined' },
  { url: capturedCollectionUrl, method: 'GET' },
  { url: `${capturedCollectionUrl}&cursor=0`, method: 'POST', postData: 'cursor=20' },
]) {
  const pages = new DouyinSourcePages();
  pages.begin(request, 0);
  assert.equal(pages.add(request, { aweme_list: [aweme('7000000000000000030')], cursor: 20, has_more: 1 }, 0), false);
  assert.equal(pages.snapshot(50).orderReliable, false, '未确认/矛盾游标不能默认为首屏');
}
assert.equal(isDouyinSourceResponseUrl('https://www-hj.douyin.com/aweme/v1/web/aweme/favorite/?max_cursor=0', 'like'), false);
assert.equal(isDouyinSourceResponseUrl('http://www.douyin.com/aweme/v1/web/aweme/favorite/?max_cursor=0', 'like'), false);

// 还原现场先出现普通“收藏”文字、后挂载真实 tab、选中状态短暂回落的时序。
for (const profilePath of ['self', 'test-profile']) {
  const originalNow = Date.now;
  let time = 1_000;
  let clickedAt = 0;
  let clicks = 0;
  Date.now = () => time;
  try {
    const connector = new PlatformAccountConnector(() => 'unused-test-profile', () => {});
    const page = {
      url: () => `https://www.douyin.com/user/${profilePath}`,
      locator: (selector) => {
        assert.equal(selector, '#semiTabfavorite_collection[role="tab"]');
        return {
          isVisible: async () => time >= 1_800,
          click: async () => { clicks += 1; clickedAt = time; },
          getAttribute: async () => clickedAt && time !== clickedAt + 400 ? 'true' : 'false',
        };
      },
      waitForTimeout: async (duration) => { time += duration; },
    };
    await connector.selectDouyinTab(page, 'douyin', 'collect', 'chrome');
    assert.equal(clicks, 1);
    assert.ok(clickedAt >= 2_400, '真实 tab 与本人主页稳定之后才点击');
    assert.ok(time >= clickedAt + 1_200, '短暂 selected=true 不能算完成');
  } finally { Date.now = originalNow; }
}
// 官网水合会吞掉首次真实 tab 点击，未选中时等待后重试，成功后不再点击。
for (const visibleAt of [1_000, 20_000]) {
  const originalNow = Date.now;
  let time = 1_000;
  const clickTimes = [];
  Date.now = () => time;
  try {
    const connector = new PlatformAccountConnector(() => 'unused-test-profile', () => assert.fail('慢加载尚在预算内，无须人工验证'));
    const page = {
      url: () => 'https://www.douyin.com/user/self',
      locator: () => ({
        isVisible: async () => time >= visibleAt,
        click: async () => { clickTimes.push(time); },
        getAttribute: async () => clickTimes.length >= 2 ? 'true' : 'false',
      }),
      waitForTimeout: async (duration) => { time += duration; },
    };
    await connector.selectDouyinTab(page, 'douyin', 'collect', 'chrome');
    assert.equal(clickTimes.length, 2);
    assert.ok(clickTimes[0] >= visibleAt + 600);
    assert.ok(clickTimes[1] - clickTimes[0] >= 2_000);
  } finally { Date.now = originalNow; }
}
{
  const originalNow = Date.now;
  let time = 1_000;
  let clicks = 0;
  Date.now = () => time;
  try {
    const connector = new PlatformAccountConnector(() => 'unused-test-profile', () => {});
    const page = {
      url: () => 'https://www.douyin.com/user/self',
      locator: () => ({ isVisible: async () => true, click: async () => { clicks += 1; }, getAttribute: async () => 'false' }),
      waitForTimeout: async (duration) => { time += duration; },
      bringToFront: async () => {},
    };
    await assert.rejects(connector.selectDouyinTab(page, 'douyin', 'collect', 'chrome'), /没有找到/);
    assert.equal(clicks, 3, '人工等待阶段也不能无限重试点击');
  } finally { Date.now = originalNow; }
}
{
  const originalDocument = globalThis.document;
  const originalStyle = globalThis.getComputedStyle;
  const attrs = { role: 'tab', 'aria-selected': 'true', 'aria-controls': 'collect-panel' };
  const calls = [];
  const route = {
    style: { overflowY: 'auto' }, clientHeight: 943, scrollHeight: 6789, scrollTop: 0, parentElement: null,
    scrollTo: (value) => { route.scrollTop = value.top; calls.push(['reset', value.top]); },
    scrollBy: (value) => { route.scrollTop = Math.min(route.scrollTop + value.top, route.scrollHeight - route.clientHeight); calls.push(['scroll', value.top]); },
  };
  const panel = {
    style: { display: 'block', visibility: 'visible' }, parentElement: route, clientHeight: 2000, scrollHeight: 2000,
    getAttribute: (name) => name === 'role' ? 'tabpanel' : null,
    getBoundingClientRect: () => ({ width: 1000, height: 2000 }),
    querySelectorAll: () => [],
  };
  const tab = {
    getAttribute: (name) => attrs[name] || null,
    style: { display: 'block', visibility: 'visible' },
    getBoundingClientRect: () => ({ width: 56, height: 52 }),
  };
  globalThis.document = {
    getElementById: (id) => id === 'semiTabfavorite_collection' ? tab : id === 'collect-panel' ? panel : null,
    querySelectorAll: (selector) => { assert.equal(selector, '[role="tabpanel"]'); return []; },
    scrollingElement: { scrollBy: () => assert.fail('不能滚动页脚/全页视频链接所在容器') },
  };
  globalThis.getComputedStyle = (element) => element.style;
  try {
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: true }), true);
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), true);
    assert.deepEqual(calls, [['reset', 0], ['scroll', 943 * 0.88]]);
    panel.getBoundingClientRect = () => ({ width: 0, height: 0 });
    panel.querySelectorAll = () => [];
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), true,
      '现场 active pane 只有零尺寸占位，仍沿精确 aria 关联定位共同滚动祖先');
    attrs['aria-selected'] = 'false';
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), false);
    attrs['aria-selected'] = 'true';
    panel.style.display = 'none';
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), false);
    assert.equal(calls.length, 3, '标签未选中/内容区隐藏时不能继续滚动');
    panel.style.display = 'block';
    route.scrollTop = 0;
    for (let index = 0; index < 6; index += 1) {
      assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), true,
        '长列表前六轮仍在前进，不能因为作品数量未增加就提前停止');
    }
    route.scrollTop = route.scrollHeight - route.clientHeight;
    assert.equal(scrollDouyinSourcePanel({ tabId: 'semiTabfavorite_collection', reset: false }), false,
      '到底且未新增内容时报告停滞，保留有限停止机制');
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = originalStyle;
  }
}

const bilibiliUrl = (id) => `https://www.bilibili.com/video/BV${id}`;
// 跑真实采集主循环，只替换官方页面和时钟：长列表第六次滚动才触发下一页。
for (const longList of [true, false]) {
  const originalNow = Date.now;
  const originalTimeout = globalThis.setTimeout;
  let time = 1_000;
  let scrolls = 0;
  let resets = 0;
  Date.now = () => time;
  globalThis.setTimeout = (callback, milliseconds, ...args) => originalTimeout(() => { time += Number(milliseconds) || 0; callback(...args); }, 0);
  try {
    const listeners = new Map();
    const emit = (name, value) => { for (const callback of listeners.get(name) || []) callback(value); };
    const respond = (cursor, payload) => {
      const request = { url: () => douyinPageUrl(cursor), method: () => 'GET', postData: () => null };
      emit('request', request);
      emit('response', {
        url: request.url, request: () => request, ok: () => true,
        allHeaders: async () => ({ 'content-type': 'application/json' }), json: async () => payload,
      });
      emit('requestfinished', request);
    };
    const page = {
      on: (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      off: (name, callback) => listeners.get(name)?.delete(callback),
      goto: async () => { respond(0, { aweme_list: [aweme(50000), aweme(50001)], max_cursor: 90, has_more: true }); },
      evaluate: async (_fn, input) => {
        if (input.reset) { resets += 1; return true; }
        scrolls += 1;
        if (longList && scrolls === 6) respond(90, { aweme_list: [aweme(50002), aweme(50003)], max_cursor: 80, has_more: true });
        return longList;
      },
    };
    const connector = new PlatformAccountConnector(() => 'unused-test-profile', () => {});
    connector.selectDouyinTab = async () => {};
    const result = await connector.collectDouyin({ pages: () => [page], browser: () => null }, 'like', 3);
    assert.equal(resets, 1, '初始化成功后不能反复复位滚动');
    assert.equal(scrolls, longList ? 6 : 5);
    assert.equal(result.coverage, longList ? 'limited' : 'partial');
    assert.equal(result.items.length, longList ? 3 : 2);
  } finally {
    Date.now = originalNow;
    globalThis.setTimeout = originalTimeout;
  }
}
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
