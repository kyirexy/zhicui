import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function load(path) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(code, { exports, URL, Error, setTimeout });
  return exports;
}
const { collectTargetedDouyinMedia, targetedDouyinMediaUrl, findTargetedDouyinRecords } = load('../src/douyin-targeted-media.ts');
const { validatePlatformAccountCollectRequest } = load('../src/security.ts');
const id = (suffix) => `76725793660936225${suffix}`;
const media = (videoId, address = 'play_addr') => ({ aweme_id: videoId, desc: '指定视频',
  video: { [address]: { url_list: [`https://v3-web.douyinvod.com/${videoId}.mp4`] } } });

const request = { platform: 'douyin', profileKey: 'profile-a', mode: 'like', limit: 100 };
assert.deepEqual(Array.from(validatePlatformAccountCollectRequest({ ...request, targetVideoIds: [id('01'), id('01')] }).targetVideoIds), [id('01')]);
for (const targetVideoIds of [[], ['../escape'], ['123'], [12345], '12345', Array(101).fill(id('01'))]) {
  assert.throws(() => validatePlatformAccountCollectRequest({ ...request, targetVideoIds }), /定向播放地址/);
}
assert.throws(() => validatePlatformAccountCollectRequest({ ...request, platform: 'bilibili', targetVideoIds: [id('01')] }), /定向播放地址/);
assert.throws(() => validatePlatformAccountCollectRequest({ ...request, limit: 1, targetVideoIds: [id('01'), id('02')] }), /定向播放地址/);

for (const field of ['play_addr', 'play_addr_h264', 'download_addr', 'playAddr']) {
  assert.match(targetedDouyinMediaUrl(media(id('01'), field)), /douyinvod\.com/);
}
assert.match(targetedDouyinMediaUrl({ video: { bit_rate: [{ play_addr: { url_list: ['http://v3-web.douyinvod.com/bitrate.mp4'] } }] } }), /^https:/);
assert.equal(targetedDouyinMediaUrl({ video: { play_addr: { url_list: ['https://untrusted.invalid/v.mp4', 'https://v3-web.douyinvod.com/valid.mp4'] } } }), 'https://v3-web.douyinvod.com/valid.mp4');
assert.equal(targetedDouyinMediaUrl({ video: { play_addr: { url_list: ['https://www.douyin.com/aweme/v1/play/', 'https://v3-web.douyinvod.com/direct.mp4'] } } }), 'https://v3-web.douyinvod.com/direct.mp4');
assert.equal(targetedDouyinMediaUrl({ video: { playAddr: [{ src: 'https://v3-web.douyinvod.com/ssr.mp4' }] } }), 'https://v3-web.douyinvod.com/ssr.mp4');
assert.equal(targetedDouyinMediaUrl({ video: { playAddr: { urlList: ['https://v3-web.douyinvod.com/list.mp4'] } } }), 'https://v3-web.douyinvod.com/list.mp4');
for (const value of ['https://douyinvod.com.evil.invalid/a.mp4', 'https://user:secret@v3-web.douyinvod.com/a.mp4', 'https://v3-web.douyinvod.com:8443/a.mp4', 'https://v3-web.douyinvod.com/a.mp4#fragment']) {
  assert.equal(targetedDouyinMediaUrl({ video: { play_addr: { url_list: [value] } } }), '');
}
assert.equal(targetedDouyinMediaUrl({ aweme_id: id('01'), images: [{}], music: { play_url: { url_list: ['https://p3.douyinvod.com/song.mp3'] } } }), '', '不能把图文配乐当视频口述');
assert.equal(findTargetedDouyinRecords({ aweme_detail: media(id('01')), recommendations: [media(id('02'))] }, id('01')).length, 1);

function harness(scenarios, onGoto = () => {}, failures = {}) {
  const pages = [];
  const commands = [];
  let active = 0;
  let peak = 0;
  let detached = 0;
  let created = 0;
  const fronted = [];
  const context = {
    async newPage() {
      if (++created === failures.newPageAt) throw new Error('单页创建失败');
      active += 1; peak = Math.max(peak, active);
      const handlers = new Map();
      let closed = false;
      let targetId;
      let scenario;
      let currentUrl;
      const page = {
        url: () => currentUrl || 'about:blank',
        bringToFront: async () => { fronted.push(page); },
        on(event, listener) { handlers.set(event, listener); },
        off(event, listener) { if (handlers.get(event) === listener) handlers.delete(event); },
        async goto(url) {
          currentUrl = url;
          targetId = url.split('/').at(-1);
          scenario = scenarios.get(targetId) || {};
          onGoto(targetId);
          if (scenario.redirect) currentUrl = scenario.redirect;
          if (scenario.payload) handlers.get('response')?.({
            url: () => scenario.responseUrl || 'https://www.douyin.com/aweme/v1/web/aweme/detail/',
            ok: () => scenario.status === undefined || scenario.status === 200,
            json: async () => scenario.payload,
          });
        },
        async evaluate(fn, videoId) {
          const location = new URL(currentUrl);
          return runInNewContext(`(${fn.toString()})(targetId)`, {
            location, URLSearchParams, targetId: videoId, window: { _ROUTER_DATA: scenario?.state },
            getComputedStyle: () => ({ visibility: 'visible' }),
            document: { querySelectorAll: (selector) => selector.includes('script') ? scenario?.scripts || []
              : scenario?.challenge ? [{ getBoundingClientRect: () => ({ width: 100, height: 100 }), textContent: '请完成安全验证' }] : [] },
          });
        },
        async waitForTimeout() { await new Promise((resolve) => setTimeout(resolve, 1)); },
        isClosed: () => closed,
        async close() { if (!closed) active -= 1; closed = true; },
      };
      pages.push({ page, handlers, closed: () => closed });
      return page;
    },
    async newCDPSession(page) {
      if (pages[failures.cdpPageAt - 1]?.page === page) throw new Error('单页协议失败');
      return { send: async (method, args) => commands.push({ method, args }), detach: async () => { detached++; } };
    },
  };
  const normalize = (raw, rank) => ({ videoId: raw.aweme_id || raw.awemeId,
    sourceUrl: `https://www.douyin.com/video/${raw.aweme_id || raw.awemeId}`, title: raw.desc || '',
    caption: raw.desc || '', authorName: '', coverUrl: '', publishedAt: '', durationSeconds: 0, sourceRank: rank });
  return { context, normalize, pages, commands, fronted, peak: () => peak, detached: () => detached };
}

{
  const scenarios = new Map([
    [id('01'), { payload: { aweme_detail: media(id('01')), unrelated: media(id('99')) } }],
    [id('02'), { state: { loaderData: { detail: media(id('02'), 'play_addr_h264') } } }],
    [id('03'), { scripts: [{ textContent: encodeURIComponent(JSON.stringify({ item: media(id('03')) })) }] }],
    [id('04'), { payload: { aweme_detail: media(id('99')) } }],
    [id('05'), { payload: { aweme_detail: media(id('05')) }, status: 404 }],
    [id('06'), { state: { item: media(id('06')) }, payload: { aweme_detail: media(id('06')) }, redirect: 'https://www.douyin.com/?showLogin=true' }],
    [id('07'), { payload: { aweme_detail: media(id('07')) }, responseUrl: 'https://untrusted.invalid/aweme/v1/web/aweme/detail/' }],
  ]);
  const h = harness(scenarios);
  const messages = [];
  const result = await collectTargetedDouyinMedia(h.context, [...scenarios.keys()], { normalize: h.normalize, cancelled: () => false,
    onProgress: (message) => messages.push(message), timeoutMs: 80, verificationTimeoutMs: 80 });
  assert.deepEqual(Array.from(result.items, (item) => item.videoId), [id('01'), id('02'), id('03')]);
  assert.equal(result.coverage, 'partial');
  assert.equal(result.orderReliable, false, '定向读取不是账号全量列表，不能更新来源日期或证明列表清理');
  assert.match(result.warning, /3\/7/);
  assert.doesNotMatch(result.warning, /无音频/);
  assert.ok(messages.at(-1).includes('已检查 7/7'));
  assert.ok(h.peak() <= 3);
  assert.equal(h.pages.length, 7);
  assert.ok(h.pages.every((entry) => entry.closed() && entry.handlers.size === 0));
  assert.equal(h.detached(), 7);
  assert.equal(h.commands.filter((entry) => entry.method === 'Network.setCacheDisabled' && entry.args.cacheDisabled).length, 7);
  assert.equal(h.commands.filter((entry) => entry.method === 'Network.setBypassServiceWorker' && entry.args.bypass).length, 7);
}

{
  let cancelled = false;
  const h = harness(new Map([[id('01'), { payload: { aweme_detail: media(id('01')) } }]]), () => { cancelled = true; });
  const result = await collectTargetedDouyinMedia(h.context, [id('01')], { normalize: h.normalize, cancelled: () => cancelled,
    onProgress() {}, timeoutMs: 80 });
  assert.equal(result.items.length, 0, '取消后的迟到响应不能作为成功结果');
  assert.ok(h.pages.every((entry) => entry.closed() && entry.handlers.size === 0));
}

{
  const scenarios = new Map([[id('01'), { challenge: true }]]);
  const h = harness(scenarios);
  const active = [];
  let actions = 0;
  const result = await collectTargetedDouyinMedia(h.context, [id('01')], { normalize: h.normalize, cancelled: () => false,
    onProgress() {}, onActivePage: (page) => active.push(page), timeoutMs: 80, verificationTimeoutMs: 800,
    onNeedsAction(message) {
      assert.match(message, /60 秒.*取消/);
      assert.equal(h.pages[0].closed(), false, '验证时保留实际详情页');
      actions++;
      scenarios.get(id('01')).challenge = false;
      scenarios.get(id('01')).state = { item: media(id('01')) };
    } });
  assert.equal(actions, 1);
  assert.equal(result.items.length, 1, '验证完成后自动继续读取本条目标');
  assert.equal(h.fronted.length, 2, '初次详情前置一次，验证再前置当前详情');
  assert.equal(active.at(-1), null);
  assert.ok(h.pages.every((entry) => entry.closed() && entry.handlers.size === 0));
}

{
  const h = harness(new Map([[id('01'), { challenge: true }]]));
  let cancelled = false;
  const result = await collectTargetedDouyinMedia(h.context, [id('01')], { normalize: h.normalize, cancelled: () => cancelled,
    onProgress() {}, onNeedsAction: () => { cancelled = true; }, timeoutMs: 80, verificationTimeoutMs: 800 });
  assert.equal(result.items.length, 0);
  assert.ok(h.pages.every((entry) => entry.closed()));
}

{
  const h = harness(new Map([[id('01'), { challenge: true }]]));
  const started = Date.now();
  let actions = 0;
  const result = await collectTargetedDouyinMedia(h.context, [id('01')], { normalize: h.normalize, cancelled: () => false,
    onProgress() {}, onNeedsAction: () => { actions++; }, timeoutMs: 20, verificationTimeoutMs: 60 });
  assert.equal(actions, 1);
  assert.equal(result.items.length, 0);
  assert.ok(Date.now() - started >= 50 && Date.now() - started < 2000, '验证等待有界，不能死循环');
  assert.ok(h.pages.every((entry) => entry.closed()));
}

for (const failures of [{ newPageAt: 1 }, { cdpPageAt: 1 }]) {
  const scenarios = new Map([id('01'), id('02'), id('03'), id('04')].map((videoId) => [videoId, { payload: { aweme_detail: media(videoId) } }]));
  const h = harness(scenarios, () => {}, failures);
  const result = await collectTargetedDouyinMedia(h.context, [...scenarios.keys()], { normalize: h.normalize, cancelled: () => false,
    onProgress() {}, timeoutMs: 80 });
  assert.equal(result.items.length, 3, '单页异常不能提前释放整个批次或抛弃其它目标');
  assert.ok(h.pages.every((entry) => entry.closed() && entry.handlers.size === 0));
  assert.ok(h.fronted.length <= 1, '无验证时只前置一次，不按视频反复抢焦点');
}

console.log('定向抖音媒体读取验证通过：合同、可信视频 URL、精确 ID、详情网络/内嵌状态、部分失败、取消、三路并发和资源清理');
