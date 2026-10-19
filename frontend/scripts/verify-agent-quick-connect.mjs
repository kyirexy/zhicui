import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { chromium } = createRequire(`${root}/desktop/package.json`)('playwright-core');
const base = process.env.AGENT_UI_BASE_URL || 'http://127.0.0.1:3016';
const output = process.env.AGENT_UI_OUTPUT || resolve(root, '.artifacts/agent-access-browser');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
const errors = [];
const fixtureUser = { id: 'agent-ui-fixture', email: 'fixture@example.invalid', username: '接入验收', is_active: true, is_admin: false, email_verified: true, agent_profile_key: 'fixture-profile', created_at: '2026-09-01T00:00:00Z' };
const fixtureToken = `fixture.${Buffer.from(JSON.stringify({ sub: fixtureUser.id, sid: 'agent-ui-session', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const dailyScopes = ['account:read', 'library:read', 'library:write', 'creator:read', 'ask:read', 'ask:run', 'local:invoke'];
const readOnlyScopes = ['account:read', 'library:read', 'creator:read', 'ask:read'];

async function scenario(name, { disabled = false, desktop = true, nativeMobile = !desktop, legacy = false, resume = false, cancelRetry = false, pat = false, presets = false, simpleKey = false, keyFailure = false, copyFailure = false, profile = 'full' } = {}) {
  const availableScopes = presets ? [...dailyScopes.filter(scope => profile !== 'core' || !['creator:read', 'local:invoke'].includes(scope)), 'knowledge:read'] : ['library:read'];
  const patRequests = [];
  const keyRequests = [];
  let keyIssued = false;
  let keyRevoked = false;
  let keyRevocationVerified = false;
  const keyCredential = { id: 'agent-key-fixture', type: 'pat', client_type: 'agent_key', name: '我的 Agent', token_prefix: 'zhc_pat_key', scopes: dailyScopes, expiry_policy: 'sliding_inactivity', inactivity_days: 365, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 365 * 86400000).toISOString(), revoked_at: null, last_used_at: null };
  const existingCredential = { id: 'existing-readonly', type: 'pat', name: '已有只读连接', token_prefix: 'zhc_pat_existing', scopes: ['library:read'], created_at: '2026-09-01T00:00:00Z', expires_at: null, revoked_at: null, last_used_at: null };
  const context = await browser.newContext({ viewport: { width: desktop || !nativeMobile ? 1440 : 390, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'], bypassCSP: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
  await context.addInitScript(({ desktop, nativeMobile, legacy, disabled, resume, copyFailure, fixtureToken, fixtureUser }) => {
    localStorage.setItem('zhicui_token', fixtureToken);
    const state = window.__agentFixture = { configured: resume, authorized: false, calls: [], listeners: new Set(), pending: null, copied: '', activeId: resume ? '90f2d2a8-9b24-4336-9ac5-3e5f10c587fc' : null, activeClient: resume ? 'claude' : 'codex' };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { if (copyFailure) throw new Error('复制失败，请查看密钥手动复制'); state.copied = value; } } });
    state.emit = event => state.listeners.forEach(listener => listener(event));
    state.finish = approve => {
      state.authorized = approve;
      state.emit({ client: state.activeClient, authorization_id: state.activeId, status: approve ? 'success' : 'error', message: approve ? '授权已完成' : '已拒绝授权' });
      state.pending?.({ success: approve, message: approve ? '授权已完成' : '已拒绝授权' });
      state.pending = null;
    };
    if (!desktop) {
      if (nativeMobile) {
        window.androidBridge = {};
        window.CapacitorCustomPlatform = { name: 'android' };
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
      }
      return;
    }
    const current = () => ({ client: 'codex', installed: true, configured: state.configured, managed: state.configured,
      authenticated: state.authorized, cloud_available: !disabled, mcp_healthy: state.authorized, ready: state.authorized && !disabled,
      code: disabled ? 'INTERFACE_DISABLED' : state.authorized ? 'READY' : 'AUTH_REQUIRED', message: '连接检查' });
    const target = {
      getRuntimeInfo: async () => ({ desktop: true, platform: 'win32', version: legacy ? '1.1.7' : '1.1.8', packaged: true, channel: 'beta', displayName: '知萃' }),
      restoreAuthSession: async () => ({ token: fixtureToken, user: fixtureUser }),
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
  }, { desktop, nativeMobile, legacy, disabled, resume, copyFailure, fixtureToken, fixtureUser });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname.startsWith('/api/agent-interface/')) {
        if (disabled) return route.fulfill({ status: 503, json: { status: 'failed', error: { code: 'INTERFACE_DISABLED', message: '尚未开放' }, data: null } });
        let data = { items: [] };
        if (url.pathname.endsWith('/capabilities')) data = { release_profile: profile, limitations: [], feature_enabled: true, actions: [], scopes: availableScopes.map(id => ({ id, title: id, description: '当前服务可用权限' })), user_hash: 'fixture-profile' };
        if (url.pathname.endsWith('/credentials')) data = { items: [...(keyIssued && !keyRevoked ? [keyCredential] : []), existingCredential] };
        if (url.pathname.endsWith('/credentials/agent-key')) {
          const input = route.request().postDataJSON();
          keyRequests.push(input);
          assert.deepEqual(input, {});
          if (keyFailure) return route.fulfill({ status: 500, json: { status: 'failed', error: { code: 'INTERNAL_ERROR', message: '生成密钥失败，请稍后重试' }, data: null } });
          keyIssued = true;
          keyRevoked = false;
          await new Promise(resolve => setTimeout(resolve, 80));
          data = { token: 'zhc_pat_synthetic_agent_key_fixture', credential: keyCredential };
        }
        if (url.pathname.endsWith('/credentials/agent-key-fixture/revoke')) {
          keyRevoked = true;
          data = { credential: { ...keyCredential, revoked_at: new Date().toISOString() } };
        }
        if (url.pathname.endsWith('/credentials/pat')) {
          const input = route.request().postDataJSON();
          patRequests.push(input);
          if (!presets) assert.deepEqual(input.scopes, ['library:read']);
          data = { token: 'zhc_pat_fixture_not_a_real_token', credential: { id: `pat-fixture-${patRequests.length}`, type: 'pat', name: input.name, token_prefix: 'zhc_pat_fixture', scopes: input.scopes, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), revoked_at: null, last_used_at: null } };
        }
        if (url.pathname.endsWith('/auth/device/request')) data = { client_name: '知萃桌面连接', client_type: 'cli', scopes: ['library:read', 'ask:run', 'local:invoke'], expires_at: new Date(Date.now() + 600000).toISOString() };
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
  await page.waitForURL('**/agent-access');
  await page.getByRole('heading', { name: 'Agent 密钥', exact: true }).waitFor();
  const advanced = page.locator('details').filter({ has: page.locator(':scope > summary', { hasText: /^高级设置$/ }) });
  if (simpleKey) {
    const keyPanel = page.locator('#agent-key');
    assert.equal(await advanced.getAttribute('open'), null);
    assert.equal(await page.locator('section[aria-labelledby="agent-confirmations-title"]').count(), 0);
    await page.getByText('仅可读取资料 · 尚未使用', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '连接你的 AI Agent', exact: true }).isVisible(), false);
    await keyPanel.getByRole('button', { name: '生成 Agent 密钥', exact: true }).click({ clickCount: 2 });
    if (keyFailure) {
      await keyPanel.getByRole('alert').waitFor();
      assert.match(await keyPanel.getByRole('alert').innerText(), /生成密钥失败/);
      assert.equal(keyRequests.length, 1);
      assert.equal(patRequests.length, 0);
      assert.equal(await keyPanel.getByRole('button', { name: '生成 Agent 密钥', exact: true }).isEnabled(), true);
    } else {
      await keyPanel.getByRole('button', { name: '复制给 Agent', exact: true }).click();
      assert.equal(keyRequests.length, 1);
      assert.equal(patRequests.length, 0);
      if (copyFailure) {
        await keyPanel.getByRole('alert').waitFor();
        await keyPanel.getByText('查看密钥', { exact: true }).click();
        assert.equal(await keyPanel.locator('code').innerText(), 'zhc_pat_synthetic_agent_key_fixture');
      } else {
        const copied = await page.evaluate(() => window.__agentFixture.copied);
        assert.match(copied, /connect --pat-stdin --client codex --non-interactive --json/);
        assert.equal(copied.split('zhc_pat_synthetic_agent_key_fixture').length - 1, 1);
      }
      assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('zhc_pat_synthetic_agent_key_fixture'))), false);
      await page.screenshot({ path: `${output}/${name}-ready.png`, fullPage: true });
      const connection = page.locator('article').filter({ has: page.getByText('我的 Agent', { exact: true }) });
      await connection.getByText('等待 Agent 使用 · 尚未使用', { exact: true }).waitFor();
      await connection.getByRole('button', { name: '吊销', exact: true }).click();
      await page.getByRole('button', { name: '取消', exact: true }).click();
      await connection.getByRole('button', { name: '吊销', exact: true }).click();
      await page.getByRole('button', { name: '确认吊销', exact: true }).click();
      await connection.waitFor({ state: 'detached' });
      assert.equal(keyRevoked, true);
      keyRevocationVerified = true;
      assert.equal(await keyPanel.getByRole('button', { name: '复制给 Agent', exact: true }).count(), 0);
      assert.equal(await keyPanel.locator('code').count(), 0);
      await keyPanel.getByRole('button', { name: '生成 Agent 密钥', exact: true }).click();
      await keyPanel.getByRole('button', { name: '复制给 Agent', exact: true }).waitFor();
      assert.equal(keyRequests.length, 2);
      await keyPanel.getByRole('button', { name: '完成', exact: true }).click();
      assert.equal(await keyPanel.locator('code').count(), 0);
    }
    assert.equal(await page.evaluate(() => window.__agentFixture.calls.length), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await page.locator('[data-nextjs-dialog]').count(), 0);
    await keyPanel.getByRole('button', { name: '生成 Agent 密钥', exact: true }).hover();
    const primaryContrast = await keyPanel.getByRole('button', { name: '生成 Agent 密钥', exact: true }).evaluate(element => {
      const luminance = color => {
        const values = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
      };
      const results = {};
      for (const theme of ['light', 'dark']) {
        document.documentElement.dataset.theme = theme;
        const style = getComputedStyle(element);
        const color = luminance(style.color), background = luminance(style.backgroundColor);
        results[theme] = (Math.max(color, background) + .05) / (Math.min(color, background) + .05);
      }
      document.documentElement.dataset.theme = 'light';
      return results;
    });
    assert.ok(primaryContrast.light >= 4.5 && primaryContrast.dark >= 4.5, `${name}: 密钥主按钮明暗主题文字对比度`);
    await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
    results.push({ name, passed: true, keyRequests: keyRequests.length, keyRevocationVerified, primaryContrast });
    await context.close();
    return;
  }
  if (await advanced.getAttribute('open') === null) await advanced.locator(':scope > summary').click();
  await page.getByRole('heading', { name: '连接你的 AI Agent', exact: true }).waitFor();
  const panel = page.locator('section[aria-labelledby="quick-agent-title"]');
  const patPanel = page.locator('#personal-access-token');
  await patPanel.getByRole('heading', { name: '个人访问令牌 PAT', exact: true }).waitFor();
  if (profile === 'core') await page.getByText('复制一次交给 Agent，之后打开知萃即可使用。', { exact: true }).waitFor();
  if (disabled) {
    await page.getByText('当前环境的 Agent 接口尚未启用', { exact: true }).waitFor();
    assert.equal(await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).isDisabled(), true);
  } else if (pat) {
    await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).click();
    await patPanel.getByText('请现在复制令牌', { exact: true }).waitFor();
    assert.equal(await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).isDisabled(), true);
    await patPanel.getByRole('button', { name: '我已保存，关闭', exact: true }).click();
    assert.equal(await patPanel.getByText('zhc_pat_fixture_not_a_real_token', { exact: true }).count(), 0);
    await page.getByRole('heading', { name: '我的连接', exact: true }).waitFor();
  }
  if (!desktop) {
    await panel.getByRole('link', { name: '下载知萃电脑客户端' }).waitFor();
    await panel.getByRole('button', { name: '复制给 Agent，开始连接' }).click();
    assert.match(await page.evaluate(() => window.__agentFixture.copied), /先检查当前会话/);
    await panel.getByText('手动使用 CLI', { exact: true }).click();
    if (profile === 'core') {
      assert.match(await page.evaluate(() => window.__agentFixture.copied), /优先使用已登录且支持授权的桌面客户端/);
    }
    if (presets) {
      const browserPreset = panel.getByRole('combobox', { name: '新连接的权限', exact: true });
      const patPreset = patPanel.getByRole('combobox', { name: '新连接的权限预设', exact: true });
      const checkbox = scope => patPanel.locator('label').filter({ has: page.locator('code', { hasText: new RegExp(`^${scope}$`) }) }).getByRole('checkbox');
      const assertScopes = async expected => {
        const checked = await patPanel.locator('label').filter({ has: page.locator('input:checked') }).locator('code').allTextContents();
        assert.deepEqual(checked.sort(), [...expected].sort());
        assert.equal(await panel.locator('code').innerText(), expected.length ? `zhicui auth login --scopes '${expected.join(',')}'` : '请先选择至少一项当前可用权限');
        assert.deepEqual(await page.getByText('已有只读连接', { exact: true }).locator('xpath=ancestor::article').locator('div > span').allTextContents(), ['library:read']);
      };
      const createPat = async expected => {
        const before = patRequests.length;
        await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).click();
        await patPanel.getByText('请现在复制令牌', { exact: true }).waitFor();
        assert.equal(patRequests.length, before + 1);
        assert.deepEqual(patRequests.at(-1).scopes, [...expected].sort());
        await patPanel.getByRole('button', { name: '我已保存，关闭', exact: true }).click();
      };
      const daily = dailyScopes.filter(scope => availableScopes.includes(scope));
      const readOnly = readOnlyScopes.filter(scope => availableScopes.includes(scope));
      assert.equal(await browserPreset.inputValue(), 'daily');
      assert.equal(await patPreset.inputValue(), 'daily');
      await assertScopes(daily);
      await createPat(daily);
      await browserPreset.selectOption('read-only');
      assert.equal(await patPreset.inputValue(), 'read-only');
      await assertScopes(readOnly);
      await createPat(readOnly);
      await patPreset.selectOption('custom');
      assert.equal(await browserPreset.inputValue(), 'custom');
      assert.equal(await patPanel.locator('#agent-permissions').getAttribute('open'), '');
      await checkbox('knowledge:read').check();
      const custom = [...readOnly, 'knowledge:read'];
      await assertScopes(custom);
      await createPat(custom);
      for (const scope of custom) await checkbox(scope).uncheck();
      await assertScopes([]);
      assert.equal(await panel.getByRole('button', { name: '复制 CLI 授权命令', exact: true }).isDisabled(), true);
      const before = patRequests.length;
      await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).click();
      const scopeError = patPanel.getByRole('alert').filter({ hasText: '请至少选择一项权限' });
      await scopeError.waitFor();
      assert.equal(patRequests.length, before);
      await checkbox('library:read').check();
      await scopeError.waitFor({ state: 'hidden' });
      await checkbox('library:read').uncheck();
      await patPanel.getByRole('button', { name: '创建个人访问令牌', exact: true }).click();
      await scopeError.waitFor();
      await browserPreset.selectOption('daily');
      await assertScopes(daily);
      await scopeError.waitFor({ state: 'hidden' });
    } else assert.equal(await panel.locator('code').innerText(), "zhicui auth login --scopes 'library:read'");
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
    const copyPrompt = panel.getByRole('button', { name: '复制给 Agent 的提示词', exact: true });
    if (disabled) assert.equal(await copyPrompt.isDisabled(), true);
    else {
      await copyPrompt.click();
      assert.match(await page.evaluate(() => window.__agentFixture.copied), /知萃/);
    }
  }
  assert.equal(await page.locator('[data-nextjs-dialog]').count(), 0);
  const overflow = await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1);
  assert.equal(overflow, false, `${name}: 接入面板不得横向溢出`);
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
  results.push({ name, passed: true, calls: await page.evaluate(() => window.__agentFixture.calls), patScopes: patRequests.map(request => request.scopes) });
  await context.close();
}

try {
  await scenario('desktop-simple-key', { simpleKey: true });
  await scenario('mobile-simple-key', { simpleKey: true, desktop: false });
  await scenario('key-creation-failure', { simpleKey: true, keyFailure: true });
  await scenario('key-copy-failure', { simpleKey: true, copyFailure: true });
  if (process.env.AGENT_UI_ONLY !== 'key') {
  await scenario('cloud-disabled', { disabled: true });
  await scenario('desktop-connect');
  await scenario('cancel-and-retry', { cancelRetry: true });
  await scenario('legacy-client', { legacy: true });
  await scenario('restore-authorization', { resume: true });
  await scenario('mobile-help', { desktop: false });
  await scenario('browser-pat', { desktop: false, nativeMobile: false, pat: true });
  await scenario('browser-core-pat', { desktop: false, nativeMobile: false, pat: true, profile: 'core' });
  await scenario('browser-scope-presets', { desktop: false, nativeMobile: false, presets: true });
  await scenario('browser-core-scope-presets', { desktop: false, nativeMobile: false, presets: true, profile: 'core' });
  }
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
