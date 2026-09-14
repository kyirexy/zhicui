import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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
let recovery = null;
const metadataRequests = [];
const startedAt = Date.now();
const launchDurationsMs = [];
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
let current='post';const loaded={};window.fixtureAllowed=${!requireUserAction};
async function load(mode,cursor=0){
 if(!window.fixtureAllowed)return;
 const path=mode==='collect'?'listcollection':mode==='like'?'favorite':'post';
 const key=mode==='collect'?'cursor':'max_cursor';
 const data=await fetch('/aweme/v1/web/aweme/'+path+'/?sec_user_id=FIXTURE_SELF&'+key+'='+cursor).then(r=>r.json());
 const panel=document.getElementById(mode);if(cursor===0)panel.innerHTML='';
 for(const item of data.aweme_list){const a=document.createElement('a');a.className='card';a.style.display='block';a.href='/video/'+item.aweme_id;a.textContent=item.desc;panel.append(a)}
 loaded[mode]={cursor:data[key],hasMore:data.has_more,busy:false};
}
window.selectFixtureMode=async mode=>{current=mode;for(const [key,id]of Object.entries(ids)){document.getElementById(id).setAttribute('aria-selected',String(key===mode));document.getElementById(key).style.display=key===mode?'block':'none'}await load(mode)};
for(const [mode,id]of Object.entries(ids)){document.getElementById(id).onclick=()=>window.selectFixtureMode(mode);document.getElementById(mode).onscroll=()=>{const state=loaded[mode];if(state?.hasMore&&!state.busy){state.busy=true;void load(mode,state.cursor)}}}
void load('post');
</script>`;

const connector = new PlatformAccountConnector(() => join(directory, 'profiles'), (status) => {
  statuses.push({ stage: status.stage, mode: status.mode, code: status.code, elapsedMs: Date.now() - startedAt });
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
  contexts.push(context);
  context.once('close', () => { closed += 1; });
  await context.addCookies([{ name: 'sessionid', value: 'fixture-only', domain: '.douyin.com', path: '/', secure: true }]);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'www.douyin.com') { await route.abort(); return; }
    if (url.pathname === '/user/self') {
      documents += 1;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html.replace('window.fixtureAllowed=true', `window.fixtureAllowed=${!requireUserAction}`) });
      return;
    }
    if (!url.pathname.startsWith('/aweme/v1/web/aweme/')) { await route.abort(); return; }
    const mode = url.pathname.includes('listcollection') ? 'collect' : url.pathname.includes('favorite') ? 'like' : 'post';
    const cursor = Number(url.searchParams.get(mode === 'collect' ? 'cursor' : 'max_cursor'));
    metadataRequests.push({ mode, cursor });
    const start = mode === 'like' ? 79100 + cursor * 2 : mode === 'collect' ? 79200 : 79300;
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
  assert.equal(first.success, true, first.error);
  assert.deepEqual(first.items.map((item) => item.videoId), ['79100', '79101', '79102']);
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
  console.log(JSON.stringify({ status: 'passed', browser: contexts[0].browser()?.version(),
    launches, closed, acquisitions, releases, documents, metadataRequests, batchElapsedMs, launchDurationsMs, statuses,
    recoveryUsedExistingWindow: true, userSessionsRead: false, realPlatformRequests: 0 }));
} finally {
  await connector.cancel();
  for (const context of contexts) await context.close().catch(() => undefined);
  const resolved = resolve(directory);
  assert.ok(resolved.startsWith(resolve(tmpdir()) + sep) && resolved.includes('zhicui-douyin-flow-'));
  await rm(resolved, { recursive: true, force: true, maxRetries: 4 });
}
