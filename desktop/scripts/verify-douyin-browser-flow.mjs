import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { PlatformAccountConnector, showPlatformAccountPage } from '../dist/platform-account.js';

// 独立 Chrome 资料目录和固定页面响应；不读取用户 Cookie，不访问真实平台接口。
const directory = await mkdtemp(join(tmpdir(), 'zhicui-douyin-flow-'));
const contexts = [];
const statuses = [];
let launches = 0;
let closed = 0;
let acquisitions = 0;
let releases = 0;
let documents = 0;
let requireUserAction = false;
let canonicalizePage = false;
let refreshLikeOnce = false;
let freshLikeHeadRequests = 0;
let recovery = null;
const metadataRequests = [];
const navigationTrace = [];
const startedAt = Date.now();
const launchDurationsMs = [];
const trace = (event, value) => { if (process.env.ZHICUI_FIXTURE_TRACE === '1') console.error(JSON.stringify({ event, value, elapsedMs: Date.now() - startedAt })); };
// 路由夹具若意外漏接或发生重定向，真实平台域名也不能被解析/连接。
const originalLaunchPersistentContext = chromium.launchPersistentContext.bind(chromium);
chromium.launchPersistentContext = (profile, options) => originalLaunchPersistentContext(profile, {
  ...options, args: [...(options?.args || []), '--host-resolver-rules=MAP * ~NOTFOUND', '--no-proxy-server'],
});
const html = `<!doctype html><meta charset="utf-8"><title>知萃独立同步验收夹具</title>
<style>body{font:16px sans-serif}button{padding:15px}.panel{height:360px;overflow:auto}.card{height:500px}</style>
<button id="semiTabpost" role="tab" aria-controls="post" aria-selected="true">作品</button>
<button id="semiTablike" role="tab" aria-controls="like" aria-selected="false">喜欢</button>
<button id="semiTabfavorite_collection" role="tab" aria-controls="collect" aria-selected="false">收藏</button>
<div class="panel" id="post" role="tabpanel" aria-labelledby="semiTabpost"></div>
<div class="panel" id="like" role="tabpanel" aria-labelledby="semiTablike" style="display:none"></div>
<div class="panel" id="collect" role="tabpanel" aria-labelledby="semiTabfavorite_collection" style="display:none"></div>
<script>
const ids={post:'semiTabpost',like:'semiTablike',collect:'semiTabfavorite_collection'};
let current='post';const loaded={};window.fixtureAllowed=${!requireUserAction};window.fixtureCanonical=false;window.fixtureRefresh=false;
async function load(mode,cursor=0){
 if(!window.fixtureAllowed)return;
 const path=mode==='collect'?'listcollection':mode==='like'?'favorite':'post';
 const key=mode==='collect'?'cursor':'max_cursor';
 const data=await fetch('/aweme/v1/web/aweme/'+path+'/?sec_user_id=FIXTURE_SELF&'+key+'='+cursor).then(r=>r.json());
 const panel=document.getElementById(mode);if(cursor===0)panel.innerHTML='';
 for(const item of data.aweme_list){const a=document.createElement('a');a.className='card';a.style.display='block';a.href='/video/'+item.aweme_id;a.textContent=item.desc;panel.append(a)}
 loaded[mode]={cursor:data[key],hasMore:data.has_more,busy:false};
 if(mode==='post'&&window.fixtureCanonical)history.replaceState(null,'','/user/FIXTURE_SELF');
 if(mode==='like'&&cursor===0&&window.fixtureRefresh&&!sessionStorage.getItem('fixture-refreshed')){sessionStorage.setItem('fixture-refreshed','yes');location.reload()}
}
window.selectFixtureMode=async mode=>{current=mode;for(const [key,id]of Object.entries(ids)){document.getElementById(id).setAttribute('aria-selected',String(key===mode));document.getElementById(key).style.display=key===mode?'block':'none'}await load(mode)};
for(const [mode,id]of Object.entries(ids)){document.getElementById(id).onclick=()=>window.selectFixtureMode(mode);document.getElementById(mode).onscroll=()=>{const state=loaded[mode];if(state?.hasMore&&!state.busy){state.busy=true;void load(mode,state.cursor)}}}
void load('post');
</script>`;

const connector = new PlatformAccountConnector(() => join(directory, 'profiles'), (status) => {
  statuses.push({ stage: status.stage, mode: status.mode, code: status.code, elapsedMs: Date.now() - startedAt });
  trace('status', statuses.at(-1));
  if (status.stage === 'needs-action' && requireUserAction && !recovery) {
    recovery = (async () => {
      const focused = await connector.focus({ platform: 'douyin', profileKey: 'fixture-profile' });
      assert.equal(focused.success, true);
      await contexts.at(-1).pages()[0].evaluate(async () => {
        window.fixtureAllowed = true;
        await window.selectFixtureMode('like');
      });
    })();
  }
});
const launch = connector.launchBrowser.bind(connector);
connector.launchBrowser = async (...args) => {
  launches += 1;
  const started = Date.now();
  const launched = await launch(...args);
  launchDurationsMs.push(Date.now() - started);
  const context = launched.context;
  const close = context.close.bind(context);
  context.close = async (...args) => { trace('close-start', launches); try { return await close(...args); } finally { trace('close-end', launches); } };
  context.on('request', (request) => {
    if (request.isNavigationRequest()) navigationTrace.push({ event: 'request', path: new URL(request.url()).pathname,
      redirected: Boolean(request.redirectedFrom()) });
  });
  for (const page of context.pages()) page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigationTrace.push({ event: 'commit', path: new URL(frame.url()).pathname });
    trace('frame', navigationTrace.at(-1));
  });
  contexts.push(context);
  context.once('close', () => { closed += 1; });
  await context.addCookies([{ name: 'sessionid', value: 'fixture-only', domain: '.douyin.com', path: '/', secure: true }]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.douyin.com') { await route.abort(); return; }
    if (url.pathname === '/user/self' || (canonicalizePage && url.pathname === '/user/FIXTURE_SELF')) {
      documents += 1;
      trace('document', url.pathname);
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html
        .replace('window.fixtureAllowed=true', `window.fixtureAllowed=${!requireUserAction}`)
        .replace('window.fixtureCanonical=false', `window.fixtureCanonical=${canonicalizePage}`)
        .replace('window.fixtureRefresh=false', `window.fixtureRefresh=${refreshLikeOnce}`) });
      return;
    }
    if (!url.pathname.startsWith('/aweme/v1/web/aweme/')) { await route.abort(); return; }
    const mode = url.pathname.includes('listcollection') ? 'collect' : url.pathname.includes('favorite') ? 'like' : 'post';
    const cursor = Number(url.searchParams.get(mode === 'collect' ? 'cursor' : 'max_cursor'));
    metadataRequests.push({ mode, cursor });
    trace('metadata', metadataRequests.at(-1));
    if (refreshLikeOnce && mode === 'like' && cursor === 0) freshLikeHeadRequests += 1;
    const start = mode === 'like' ? (refreshLikeOnce && freshLikeHeadRequests > 1 ? 79400 : 79100) + cursor * 2 : mode === 'collect' ? 79200 : 79300;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ status_code: 0,
      aweme_list: [start, start + 1].map((id) => ({ aweme_id: String(id), desc: `验收作品${id}`, create_time: 1 })),
      [mode === 'collect' ? 'cursor' : 'max_cursor']: cursor + 1, has_more: mode === 'like' && cursor === 0,
    }) });
  });
  return launched;
};
const acquire = connector.actionLocks.acquire.bind(connector.actionLocks);
connector.actionLocks.acquire = async (...args) => {
  acquisitions += 1;
  const lease = await acquire(...args);
  return { key: lease.key, release: async () => { releases += 1; await lease.release(); } };
};

try {
  const started = Date.now();
  const request = { platform: 'douyin', profileKey: 'fixture-profile', mode: 'like', limit: 3,
    sessionKey: 'fixture-session-0000001', keepSessionOpen: true };
  const first = await connector.collect(request);
  assert.equal(first.success, true, JSON.stringify({ error: first.error, navigationTrace, metadataRequests }));
  assert.deepEqual(first.items.map((item) => item.videoId), ['79100', '79101', '79102']);
  assert.equal(first.diagnostics.document_commit_count, 1);
  assert.equal(first.diagnostics.fresh_document_committed, true);
  assert.equal(first.diagnostics.page_count, 2);
  assert.deepEqual(first.diagnostics.request_methods, ['GET']);
  assert.equal(first.coverage, 'limited');
  assert.equal(closed, 0);
  assert.equal(releases, 0);
  const page = contexts[0].pages()[0];
  const session = await contexts[0].newCDPSession(page);
  const state = await session.send('Browser.getWindowForTarget');
  await session.send('Browser.setWindowBounds', { windowId: state.windowId, bounds: { windowState: 'minimized' } });
  await showPlatformAccountPage(page);
  assert.notEqual((await session.send('Browser.getWindowBounds', { windowId: state.windowId })).bounds.windowState, 'minimized');
  await session.detach();
  const second = await connector.collect({ ...request, mode: 'collect', keepSessionOpen: false });
  assert.equal(second.success, true, second.error);
  assert.deepEqual(second.items.map((item) => item.videoId), ['79200', '79201']);
  assert.equal(second.diagnostics.document_commit_count, 1);
  assert.equal(second.diagnostics.endpoint_path, '/aweme/v1/web/aweme/listcollection/');
  assert.equal(second.coverage, 'complete');
  assert.equal(launches, 1, '两来源必须复用一个真实 Chrome 进程/窗口');
  assert.equal(acquisitions, 1);
  assert.equal(releases, 1);
  assert.equal(closed, 1);
  const batchElapsedMs = Date.now() - started;

  requireUserAction = true;
  const resumed = await connector.collect({ ...request, sessionKey: 'fixture-session-0000002', keepSessionOpen: false });
  if (recovery) await recovery;
  assert.equal(resumed.success, true, resumed.error);
  assert.deepEqual(resumed.items.map((item) => item.videoId), ['79100', '79101', '79102']);
  assert.ok(statuses.some((status) => status.stage === 'needs-action'));
  assert.equal(launches, 2, '验证恢复期间只能前置已有窗口，不打开替代浏览器');
  assert.equal(closed, 2);
  assert.equal(acquisitions, 2);
  assert.equal(releases, 2);

  requireUserAction = false;
  canonicalizePage = true;
  refreshLikeOnce = true;
  const refreshed = await connector.collect({ ...request, sessionKey: 'fixture-session-0000003', keepSessionOpen: false });
  assert.equal(refreshed.success, true, JSON.stringify({ error: refreshed.error, navigationTrace, metadataRequests }));
  assert.deepEqual(refreshed.items.map((item) => item.videoId), ['79400', '79401', '79402'], '刷新后只交付新文档的最新首屏/分页');
  assert.equal(refreshed.diagnostics.document_commit_count, 2, 'SPA规范化URL不增加文档数，实际刷新才增加');
  assert.deepEqual(refreshed.diagnostics.first_video_ids, ['79400', '79401', '79402']);
  assert.equal(launches, 3);
  assert.equal(closed, 3);
  assert.equal(acquisitions, 3);
  assert.equal(releases, 3);

  console.log(JSON.stringify({ status: 'passed', browser: contexts[0].browser()?.version(),
    launches, closed, acquisitions, releases, documents, metadataRequests, navigationTrace, batchElapsedMs, launchDurationsMs, statuses,
    recoveryUsedExistingWindow: true, canonicalAndRefreshVerified: true, platformDnsBlocked: true, userSessionsRead: false, realPlatformRequests: 0 }));
} finally {
  await connector.cancel();
  for (const context of contexts) await context.close().catch(() => undefined);
  chromium.launchPersistentContext = originalLaunchPersistentContext;
  const resolved = resolve(directory);
  assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('zhicui-douyin-flow-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 4 });
}
