import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';
import { prepareDouyinSourcePage } from '../dist/platform-account.js';

// 真实 Chrome + 独立本地页面。不用 route（它会自动关闭缓存而掩盖缺陷），不读取用户资料。
let version = 1;
const hits = { get: 0, post: 0, worker: 0 };
const server = createServer((request, response) => {
  if (['/get-list', '/post-list', '/worker-list'].includes(request.url)) {
    hits[request.url.slice(1).replace('-list', '')] += 1;
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' });
    response.end(JSON.stringify({ version }));
    return;
  }
  if (request.url === '/worker.js') {
    response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
    response.end(`self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{if(new URL(event.request.url).pathname==='/worker-list')event.respondWith((async()=>{
const cache=await caches.open('fixture-source');const saved=await cache.match(event.request);if(saved)return saved;
const response=await fetch(event.request);await cache.put(event.request,response.clone());return response;})());});`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`<title>知萃缓存回归夹具</title><script>
window.readFixture=()=>Promise.all([fetch('/get-list'),fetch('/post-list',{method:'POST',body:'cursor=0&count=30'}),fetch('/worker-list')].map(async r=>(await (await r).json()).version));
</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${origin}/user/self`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/worker.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  const initial = await page.evaluate(() => window.readFixture());
  assert.deepEqual(initial, [1, 1, 1]);
  version = 2;
  await page.goto(`${origin}/user/self`);
  const stale = await page.evaluate(() => window.readFixture());
  assert.deepEqual(stale, [1, 2, 1], '仅 goto 并不保证 GET / Service Worker 列表是最新的；POST 的正常网络结果应独立保留');
  const release = await prepareDouyinSourcePage(context, page);
  try {
    version = 3;
    await page.goto(`${origin}/user/self`);
    const fresh = await page.evaluate(() => window.readFixture());
    assert.deepEqual(fresh, [3, 3, 3], '采集期间 GET、POST、Service Worker 列表均从网络刷新');
    assert.deepEqual(hits, { get: 2, post: 3, worker: 2 });
    console.log(JSON.stringify({ status: 'passed', browser: browser.version(), initial, stale, fresh, hits,
      userSessionsRead: false, realPlatformRequests: 0 }));
  } finally { await release(); }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
