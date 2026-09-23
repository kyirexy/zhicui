import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchIsolatedPlatformBrowser, parseWindowsDefaultBrowser, platformBrowserArgs } from '../dist/platform-browser.js';
import { PlatformAccountConnector } from '../dist/platform-account.js';

assert.equal(parseWindowsDefaultBrowser('    ProgId    REG_SZ    MSEdgeHTM\r\n'), 'msedge');
assert.equal(parseWindowsDefaultBrowser('    ProgId    REG_SZ    ChromeHTML\r\n'), 'chrome');
assert.equal(parseWindowsDefaultBrowser('    ProgId    REG_SZ    ChromeHTML.some-profile\r\n'), 'chrome');
assert.equal(parseWindowsDefaultBrowser('    ProgId    REG_SZ    FirefoxURL-abc\r\n'), undefined);
assert.equal(parseWindowsDefaultBrowser('    SomeOtherValue    REG_SZ    MSEdgeHTM\r\n'), undefined);
for (const background of [true, false]) {
  const args = platformBrowserArgs(background);
  assert.ok(args.includes(background ? '--start-minimized' : '--start-maximized'));
  for (const arg of ['--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']) {
    assert.ok(args.includes(arg), '切回知萃后同步不能被后台节流');
  }
  assert.ok(!args.some((arg) => /user-data-dir|profile-directory|remote-debugging-port|disable-web-security/.test(arg)));
}

const directory = await mkdtemp(join(tmpdir(), 'zhicui-browser-selection-'));
const calls = [];
const launch = async (profile, options) => {
  assert.ok(resolve(profile).startsWith(`${resolve(directory)}${sep}`), '只允许测试自己的隔离资料目录');
  calls.push({ profile, options });
  await mkdir(profile, { recursive: true });
  return { fixture: true };
};
try {
  const fresh = join(directory, 'fresh-account');
  let result = await launchIsolatedPlatformBrowser(fresh, false, { launch, preferred: async () => 'msedge' });
  assert.equal(result.browser, 'msedge', '新隔离会话优先系统默认 Edge');
  assert.equal(calls.at(-1).profile, fresh, '不得转到个人浏览器目录');
  assert.equal(calls.at(-1).options.headless, false);
  assert.equal(calls.at(-1).options.acceptDownloads, false);
  assert.deepEqual(JSON.parse(await readFile(join(fresh, 'ZhicuiBrowser.json'), 'utf8')), { browser: 'msedge' });

  result = await launchIsolatedPlatformBrowser(fresh, true, { launch, preferred: async () => {
    assert.fail('已有会话不应重复读取系统浏览器偏好拖慢同步');
  } });
  assert.equal(result.browser, 'msedge', '改变系统默认浏览器后不能切换已登录会话的浏览器');
  assert.ok(calls.at(-1).options.args.includes('--start-minimized'));
  let pinnedAttempts = 0;
  await assert.rejects(launchIsolatedPlatformBrowser(fresh, false, {
    launch: async () => { pinnedAttempts += 1; throw new Error('已选浏览器无法启动'); }, preferred: async () => 'chrome',
  }), /已选浏览器无法启动/);
  assert.equal(pinnedAttempts, 1, '已固定浏览器不能因暂时启动错误静默改用另一个程序读取Cookie');

  const legacy = join(directory, 'legacy-account');
  await mkdir(legacy);
  await writeFile(join(legacy, 'Local State'), '{}');
  result = await launchIsolatedPlatformBrowser(legacy, false, { launch, preferred: async () => 'msedge' });
  assert.equal(result.browser, 'chrome', '升级前资料沿用原 Chrome 优先行为');

  const fallback = join(directory, 'fresh-fallback');
  const attempted = [];
  result = await launchIsolatedPlatformBrowser(fallback, false, {
    preferred: async () => 'msedge',
    launch: async (profile, options) => {
      attempted.push(options.channel);
      if (options.channel === 'msedge') throw new Error('Executable does not exist');
      return launch(profile, options);
    },
  });
  assert.deepEqual(attempted, ['msedge', 'chrome']);
  assert.equal(result.browser, 'chrome', '新会话默认浏览器不可用时允许受支持浏览器兜底');
} finally {
  const target = resolve(directory);
  assert.ok(target.startsWith(`${resolve(tmpdir())}${sep}zhicui-browser-selection-`));
  await rm(target, { recursive: true, force: true });
}

// 真实连接器交互分支：刚启动时没有标签也必须创建并前置；失败提示不能被 collecting 立即覆盖。
for (const focusFails of [false, true]) {
  const statuses = [];
  let created = 0;
  let focused = 0;
  let closed = 0;
  const pages = [];
  const page = { isClosed: () => false, bringToFront: async () => {
    focused += 1;
    if (focusFails) throw new Error('系统暂未允许前置窗口');
  } };
  const context = {
    pages: () => pages,
    newPage: async () => { created += 1; pages.push(page); return page; },
    cookies: async () => [{ name: 'sessionid', value: 'fixture', domain: '.douyin.com' }],
    close: async () => { closed += 1; },
  };
  const connector = new PlatformAccountConnector(() => 'unused-browser-fixture', (status) => statuses.push(status));
  connector.profilePath = async () => 'unused-browser-fixture';
  connector.actionLocks = { acquire: async () => ({ release: async () => {} }) };
  connector.launchBrowser = async (_profile, background) => {
    assert.equal(background, false, 'interactive:true 不能请求最小化启动');
    return { context, browser: 'msedge' };
  };
  connector.collectDouyin = async () => {
    assert.equal(connector.activeBrowser, 'msedge', 'Edge 恢复阶段不得被标记为 Chrome');
    assert.equal(statuses.at(-1).stage, focusFails ? 'needs-action' : 'collecting');
    connector.activeTargetPage = page;
    return { urls: ['https://www.douyin.com/video/7123456789012345678'], coverage: 'complete', orderReliable: true };
  };
  const result = await connector.collect({ platform: 'douyin', profileKey: 'isolated-account', mode: 'like', limit: 1, interactive: true });
  assert.equal(result.success, true);
  assert.equal(created, 1);
  assert.equal(focused, 1);
  assert.equal(closed, 1);
  assert.equal(connector.activeTargetPage, null, '一轮采集结束必须清理详情页引用');
  if (focusFails) assert.match(statuses.find((status) => status.stage === 'needs-action').message, /从任务栏切换到本次窗口/);
}

// 多标签定向读取：前置正在等待验证的详情页，不能停留在最初的空白页。
{
  const focused = [];
  let detailClosed = false;
  const blank = { isClosed: () => false, bringToFront: async () => { focused.push('blank'); } };
  const detail = { isClosed: () => detailClosed, bringToFront: async () => { focused.push('detail'); } };
  const unrelated = { isClosed: () => false, bringToFront: async () => { assert.fail('旧账号的详情页不得被前置'); } };
  const connector = new PlatformAccountConnector(() => 'unused-focus-fixture', () => {});
  connector.running = true;
  connector.activePlatform = 'douyin';
  connector.activeProfileKey = 'current-profile';
  connector.activeContext = { pages: () => [blank, detail] };
  connector.activeTargetPage = detail;
  assert.equal((await connector.focus({ platform: 'douyin', profileKey: 'other-profile' })).success, false);
  assert.deepEqual(focused, []);
  assert.equal((await connector.focus({ platform: 'douyin', profileKey: 'current-profile' })).success, true);
  assert.deepEqual(focused, ['detail']);
  detailClosed = true;
  assert.equal((await connector.focus({ platform: 'douyin', profileKey: 'current-profile' })).success, true);
  assert.deepEqual(focused, ['detail', 'blank'], '详情标签关闭后安全回到当前会话仍存在的页');
  connector.activeTargetPage = unrelated;
  assert.equal((await connector.focus({ platform: 'douyin', profileKey: 'current-profile' })).success, true);
  assert.deepEqual(focused, ['detail', 'blank', 'blank'], '不能前置不属于当前上下文的旧详情页引用');
}

console.log('浏览器默认选择、登录隔离、窗口前置和后台采集节流验证通过');
