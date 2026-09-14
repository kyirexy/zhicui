import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { chromium } = createRequire(`${root}/desktop/package.json`)('playwright-core');
const base = process.env.AGENT_UI_BASE_URL || 'http://127.0.0.1:3016';
const output = process.env.AGENT_UI_OUTPUT || 'D:/6month/.codex-artifacts/agent-onboarding-20260914';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const errors = [];
const fixtureUser = { id: 'agent-ui-fixture', email: 'fixture@example.invalid', username: '接入验收', is_active: true, is_admin: false, email_verified: true, agent_profile_key: 'fixture-profile', created_at: '2026-09-01T00:00:00Z' };
const fixtureToken = `fixture.${Buffer.from(JSON.stringify({ sub: fixtureUser.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;

async function scenario(name, { disabled = false, desktop = true, legacy = false, resume = false, cancelRetry = false } = {}) {
  const context = await browser.newContext({ viewport: { width: desktop ? 1440 : 390, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  await context.addInitScript(({ desktop, legacy, disabled, resume, fixtureToken }) => {
    localStorage.setItem('zhicui_token', fixtureToken);
    const state = window.__agentFixture = { configured: resume, authorized: false, calls: [], listeners: new Set(), pending: null, copied: '', activeId: resume ? '90f2d2a8-9b24-4336-9ac5-3e5f10c587fc' : null, activeClient: resume ? 'claude' : 'codex' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { state.copied = value; } } });
    state.emit = event => state.listeners.forEach(listener => listener(event));
    state.finish = approve => {
      state.authorized = approve;
      state.emit({ client: state.activeClient, authorization_id: state.activeId, status: approve ? 'success' : 'error', message: approve ? '授权已完成' : '已拒绝授权' });
      state.pending?.({ success: approve, message: approve ? '授权已完成' : '已拒绝授权' });
      state.pending = null;
    };
    if (!desktop) {
      window.androidBridge = {};
      window.CapacitorCustomPlatform = { name: 'android' };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
      return;
    }
    const current = () => ({ client: 'codex', installed: true, configured: state.configured, managed: state.configured,
      authenticated: state.authorized, cloud_available: !disabled, mcp_healthy: state.authorized, ready: state.authorized && !disabled,
      code: disabled ? 'INTERFACE_DISABLED' : state.authorized ? 'READY' : 'AUTH_REQUIRED', message: '连接检查' });
    const target = {
      getRuntimeInfo: async () => ({ desktop: true, platform: 'win32', version: legacy ? '1.1.7' : '1.1.8', packaged: true, channel: 'beta', displayName: '知萃' }),
      getZhicuiSession: async () => null,
      getAgentIntegrationStatus: async () => ({ available: true, cli_available: true, clients: [current()],
        ...(legacy ? {} : { capabilities: { version: 2, supports_authorization: true, managed_updates: true }, setup_prompt: '请使用当前知萃客户端内置 CLI 接入，不要读取凭据。' }),
        ...(resume && !state.authorized ? { authorization: { client: 'claude', authorization_id: state.activeId, status: 'waiting', user_code: 'ZHC-TEST88', message: '等待确认' } } : {}) }),
      onAgentAuthorizationStatus: callback => { state.listeners.add(callback); return () => state.listeners.delete(callback); },
      runAgentIntegrationAction: async request => {
        state.calls.push(request);
        if (request.operation === 'setup') { state.configured = true; return { success: true, ...current() }; }
        if (request.operation === 'authorize') return new Promise(resolve => {
          state.pending = resolve; state.activeId = request.authorization_id; state.activeClient = request.client;
          setTimeout(() => state.emit({ client: request.client, authorization_id: request.authorization_id, status: 'waiting', user_code: 'ZHC-TEST88', message: '等待确认' }), 30);
        });
        if (request.operation === 'cancel_authorization') {
          state.emit({ client: request.client, authorization_id: request.authorization_id, status: 'cancelled', message: '已取消' });
          const previous = state.pending; state.pending = null; setTimeout(() => previous?.({ success: false, code: 'AUTHORIZATION_CANCELLED', message: '已取消' }), 250);
          return { success: true };
        }
        return { success: true, ...current() };
      },
    };
    window.zhicuiDesktop = new Proxy(target, { get(object, key) {
      if (key in object) return object[key];
      if (String(key).startsWith('on')) return () => () => {};
      return async () => ({ success: true, status: 'idle' });
    } });
  }, { desktop, legacy, disabled, resume, fixtureToken });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/agent-interface/')) {
        if (disabled) return route.fulfill({ status: 503, json: { status: 'failed', error: { code: 'INTERFACE_DISABLED', message: '尚未开放' }, data: null } });
        let data = { items: [] };
        if (url.pathname.endsWith('/capabilities')) data = { actions: [], scopes: [{ id: 'library:read', title: '读取资料', description: '查看视频资料' }], user_hash: 'fixture-profile' };
        if (url.pathname.endsWith('/auth/device/request')) data = { client_name: '知萃桌面连接', client_type: 'cli', scopes: ['library:read', 'ask:run', 'local:invoke'], expires_at: '2026-09-15T00:00:00Z' };
        if (url.pathname.endsWith('/auth/device/approve')) {
          const approve = route.request().postDataJSON().approve;
          data = { approved: approve, client_name: '知萃桌面连接' };
          setTimeout(() => page.evaluate(value => window.__agentFixture.finish(value), approve).catch(() => {}), 60);
        }
        return route.fulfill({ json: { status: 'succeeded', data, error: null } });
      }
      const data = url.pathname === '/api/auth/me' ? fixtureUser : url.pathname.includes('notes') ? { notes: [], total: 0 } : { items: [], enabled: false };
      return route.fulfill({ json: { success: true, data } });
    }
    if (url.origin !== new URL(base).origin && !['data:', 'blob:'].includes(url.protocol)) return route.abort();
    return route.continue();
  });
  await page.goto(`${base}/settings?section=agent`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByRole('heading', { name: '连接你的 AI Agent', exact: true }).waitFor();
  const panel = page.locator('section[aria-labelledby="quick-agent-title"]');
  if (!desktop) {
    await panel.getByRole('link', { name: '下载电脑客户端' }).waitFor();
    await panel.getByRole('button', { name: '复制给 Agent 的提示词' }).click();
    assert.match(await page.evaluate(() => window.__agentFixture.copied), /先检查当前会话/);
    assert.equal(await panel.locator('button', { hasText: '安装到' }).count(), 0);
  } else if (resume) {
    await page.getByRole('heading', { name: '确认连接权限' }).waitFor();
    await page.getByRole('button', { name: '允许连接', exact: true }).waitFor();
    await panel.getByRole('button', { name: '取消授权', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('device-authorization-title'));
    assert.equal(await page.evaluate(() => window.__agentFixture.calls.at(-1).client), 'claude');
    assert.ok(await page.evaluate(() => window.__agentFixture.calls.at(-1).authorization_id));
  } else {
    const install = panel.getByRole('button', { name: '安装到 Codex', exact: true });
    await install.waitFor();
    await install.click({ clickCount: 2 });
    if (disabled || legacy) {
      await page.waitForFunction(() => window.__agentFixture.calls.some(item => item.operation === 'setup'));
      await panel.getByText('连接已安装', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__agentFixture.calls.filter(item => item.operation === 'authorize').length), 0);
    } else {
      await page.getByRole('heading', { name: '确认连接权限' }).waitFor();
      await page.getByText('知萃桌面连接', { exact: true }).waitFor();
      if (cancelRetry) {
        await panel.getByRole('button', { name: '取消授权', exact: true }).click();
        await panel.getByRole('button', { name: '授权连接', exact: true }).click();
        await page.getByRole('heading', { name: '确认连接权限' }).waitFor();
      }
      await page.getByRole('button', { name: '允许连接', exact: true }).click();
      await panel.getByText('连接检查通过', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__agentFixture.calls.filter(item => item.operation === 'setup').length), 1);
      assert.equal(await page.evaluate(() => window.__agentFixture.calls.filter(item => item.operation === 'authorize').length), cancelRetry ? 2 : 1);
    }
    await panel.getByRole('button', { name: '复制给 Agent 的提示词', exact: true }).click();
    assert.match(await page.evaluate(() => window.__agentFixture.copied), /知萃/);
  }
  assert.equal(await page.locator('[data-nextjs-dialog]').count(), 0);
  const overflow = await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false, `${name}: 接入面板不得横向溢出`);
  await panel.screenshot({ path: `${output}/${name}.png` });
  results.push({ name, passed: true, calls: await page.evaluate(() => window.__agentFixture.calls) });
  await context.close();
}

try {
  await scenario('cloud-disabled', { disabled: true });
  await scenario('desktop-connect');
  await scenario('cancel-and-retry', { cancelRetry: true });
  await scenario('legacy-client', { legacy: true });
  await scenario('restore-authorization', { resume: true });
  await scenario('mobile-help', { desktop: false });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/browser-report.json`, JSON.stringify({ results, errors, realPlatformAccess: false }, null, 2));
  console.log(JSON.stringify({ passed: results.length, errors }));
} catch (error) {
  const pages = browser.contexts().flatMap(context => context.pages());
  for (const page of pages) {
    console.error(JSON.stringify({ url: page.url(), text: (await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 1800), errors }));
    await page.screenshot({ path: `${output}/failure.png` }).catch(() => {});
  }
  throw error;
} finally { await browser.close(); }
