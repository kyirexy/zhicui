#!/usr/bin/env node
/** 从真实 CLI 验证 PAT、设备授权、凭据刷新和 MCP；只允许专用普通测试账号。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.SMOKE_BASE_URL || 'https://luxai.cn').replace(/\/$/u, '');
const CLI = resolve(process.env.SMOKE_CLI_ENTRY || join(ROOT, 'cli/dist/index.js'));
const SCOPES = ['account:read', 'library:read', 'creator:read'];
const RELEASE_PROFILE = process.env.SMOKE_AGENT_PROFILE || 'full';
const USERNAME = 'zhicui_production_smoke';
const PROFILE = `smoke-agent-${randomUUID()}`;
const PAT_NAME = PROFILE;
const report = { base_url: API, agent_release_profile: RELEASE_PROFILE, started_at: new Date().toISOString(), checks: [], cleanup: false };
let configDirectory;
let browserToken;
let credentialManager;
const credentialIds = new Set();
let pendingCode;
let initialDeviceIds;

class SmokeError extends Error {}
function check(condition, label) {
  if (!condition) throw new SmokeError(label);
}
function passed(name, detail = {}) {
  report.checks.push({ name, passed: true, ...detail });
  process.stdout.write(`${JSON.stringify({ check: name, passed: true, ...detail })}\n`);
}
function parse(value, label) {
  try { return JSON.parse(value); } catch { throw new SmokeError(`${label}: invalid JSON`); }
}
async function request(path, { method = 'GET', token = browserToken, body, allowFailure = false } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new SmokeError(`HTTP transport failed: ${method} ${path.split('?')[0]}`); }
  const payload = parse(await response.text(), 'HTTP response');
  if (!allowFailure) {
    const code = payload.error?.code;
    check(response.ok && !payload.error && payload.success !== false, `HTTP ${response.status}${/^[A-Z_]+$/u.test(code || '') ? ` ${code}` : ''}: ${path.split('?')[0]}`);
  }
  return { status: response.status, payload, data: payload.data };
}
function cli(args, { input = '', json = true, allowFailure = false, onEvent } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--profile', PROFILE, '--non-interactive', '--quiet', ...(json ? ['--json'] : [])], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    let buffer = '';
    let failure;
    let events = Promise.resolve();
    const timer = setTimeout(() => { failure = new SmokeError('CLI process timeout'); child.kill(); }, 120_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (value) => {
      output += value;
      if (output.length > 8_000_000) { failure = new SmokeError('CLI output too large'); child.kill(); return; }
      if (!onEvent) return;
      buffer += value;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || '';
      for (const line of lines.filter(Boolean)) {
        events = events.then(() => onEvent(parse(line, 'CLI event'))).catch((error) => { failure = error; child.kill(); });
      }
    });
    // 不输出 subprocess 日志；其中可能包含账号资料或授权链接。
    child.stderr.resume();
    child.stdin.on('error', () => undefined);
    child.once('error', () => { clearTimeout(timer); reject(new SmokeError('Cannot start CLI')); });
    child.once('close', async (code) => {
      clearTimeout(timer);
      await events;
      if (failure) { reject(failure); return; }
      let data;
      try { data = json ? parse(output, 'CLI response') : output.trim().split(/\r?\n/u).filter(Boolean).map((line) => parse(line, 'CLI message')); }
      catch (error) { reject(error); return; }
      if (code !== 0 && !allowFailure) {
        const errorCode = json ? data.error?.code : data.at(-1)?.error?.code;
        reject(new SmokeError(`CLI ${args.slice(0, 2).join(' ')} failed${/^[A-Z_]+$/u.test(errorCode || '') ? `: ${errorCode}` : ''}`));
        return;
      }
      accept({ code, data });
    });
    child.stdin.end(input);
  });
}
async function revoke(id) {
  const result = await request(`/api/agent-interface/v1/credentials/${id}/revoke`, { method: 'POST' });
  check(Boolean(result.data?.credential?.revoked_at), 'Credential revocation not persisted');
}
async function rememberStoredCredential() {
  const saved = await credentialManager?.load();
  if (saved) {
    const match = /^zhc_(?:access|pat)_([a-f0-9]{32})_/u.exec(saved.access_token);
    check(Boolean(match), 'Unexpected own test credential format');
    credentialIds.add(match[1]);
  }
  return saved;
}
async function main() {
  check(['core', 'full'].includes(RELEASE_PROFILE), 'SMOKE_AGENT_PROFILE must be core or full');
  const manifestPath = process.env.SMOKE_AGENT_CAPABILITY_MANIFEST || join(ROOT, 'backend/app/agent_interface', RELEASE_PROFILE === 'core' ? 'core_capabilities_v1.json' : 'stable_capabilities_v1.json');
  report.agent_capability_manifest_sha256 = createHash('sha256').update(await readFile(manifestPath)).digest('hex');
  const parsedApi = new URL(API);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsedApi.hostname);
  check(API === 'https://luxai.cn' || (local && ['http:', 'https:'].includes(parsedApi.protocol)), 'Only production or loopback URLs are allowed');
  check(!parsedApi.username && !parsedApi.password && !parsedApi.search && !parsedApi.hash, 'Invalid API origin');
  const email = process.env.SMOKE_LOGIN_EMAIL;
  check(Boolean(email), 'SMOKE_LOGIN_EMAIL is required');
  let password;
  if (process.argv.includes('--password-stdin')) {
    check(!process.stdin.isTTY, 'Pipe the test password through stdin; interactive echo is forbidden');
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      check(length <= 8192, 'Password input too large');
      chunks.push(chunk);
    }
    password = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    check(Boolean(process.env.SMOKE_PASSWORD_FILE), 'SMOKE_PASSWORD_FILE or --password-stdin is required');
    password = (await readFile(process.env.SMOKE_PASSWORD_FILE, 'utf8')).trim();
  }
  check(Boolean(password), 'Empty test password');
  const login = await request('/api/auth/login', { method: 'POST', body: { email, password }, token: null });
  password = undefined;
  check(login.data?.user?.username === USERNAME && login.data.user.is_admin === false, 'Refusing a real-user or administrator account');
  check(typeof login.data.token === 'string' && login.data.token.length > 20, 'Login token missing');
  browserToken = login.data.token;
  passed('reserved_non_admin_login');

  configDirectory = await mkdtemp(join(tmpdir(), 'zhicui-agent-cli-smoke-'));
  // 永不接触默认 profile，也不允许继承显式明文凭据或真实桌面桥接描述符。
  delete process.env.ZHICUI_CREDENTIALS_FILE;
  delete process.env.ZHICUI_ALLOW_PLAINTEXT_CREDENTIALS;
  process.env.ZHICUI_CONFIG_HOME = configDirectory;
  process.env.ZHICUI_DESKTOP_BRIDGE_DESCRIPTOR = join(configDirectory, 'no-desktop-bridge.json');
  process.env.ZHICUI_API_URL = API;
  if (local) process.env.ZHICUI_CLI_DEV = '1'; else delete process.env.ZHICUI_CLI_DEV;
  const { CredentialManager } = await import(pathToFileURL(join(dirname(CLI), 'credentials.js')).href);
  credentialManager = new CredentialManager(PROFILE, API);
  const version = await cli(['--version']);
  report.cli_version = version.data.version;
  const publicCapabilities = await cli(['capabilities', '--public']);
  check((publicCapabilities.data.release_profile || 'full') === RELEASE_PROFILE && publicCapabilities.data.feature_enabled === true, 'Public capability profile mismatch or disabled');
  const advertisedScopes = new Set((publicCapabilities.data.scopes || []).map((scope) => scope.id));
  check(SCOPES.every((scope) => advertisedScopes.has(scope)), 'Test read-only scopes are not available');
  if (RELEASE_PROFILE === 'core') check(!['local:invoke', 'analysis:read', 'automation:read'].some((scope) => advertisedScopes.has(scope)), 'Core advertised unavailable scopes');
  passed('public_capabilities_profile', { profile: RELEASE_PROFILE });
  const created = await request('/api/agent-interface/v1/credentials/pat', {
    method: 'POST', body: { name: PAT_NAME, scopes: SCOPES, expires_in_days: 1 },
  });
  const pat = created.data?.token;
  const patId = created.data?.credential?.id;
  check(typeof pat === 'string' && /^[a-f0-9]{32}$/u.test(patId || ''), 'PAT creation failed');
  credentialIds.add(patId);
  const imported = await cli(['auth', 'pat'], { input: pat });
  check(imported.data.authenticated === true && !imported.data.store.includes('plaintext'), 'PAT was not stored securely');
  passed('pat_stdin_system_store', { store: imported.data.store });
  const listed = await request('/api/agent-interface/v1/credentials');
  check(listed.data.items.some((item) => item.id === patId) && !JSON.stringify(listed.data).includes(pat), 'PAT list disclosure or missing credential');
  passed('pat_one_time_display');

  const verification = await cli(['auth', 'status', '--verify']);
  check(verification.data.valid === true, 'CLI credential verification failed');
  const account = await cli(['account', 'get']);
  check(account.data.status === 'succeeded' && account.data.data?.result?.username === USERNAME, 'CLI account action failed');
  check(!('is_admin' in account.data.data.result), 'Account action returned administrator state');
  const library = await cli(['library', 'list', '--per-page', '3']);
  check(library.data.status === 'succeeded' && Array.isArray(library.data.data?.result?.items), 'CLI library action failed');
  const creators = await cli(['creator', 'list']);
  check(creators.data.status === 'succeeded', 'CLI creator action failed');
  passed('cli_account_library_creator', { library_total: library.data.data.result.total });

  const denied = await request('/api/agent-interface/v1/actions/knowledge.create/invoke', {
    token: pat, method: 'POST', body: { input: {} }, allowFailure: true,
  });
  check(denied.status === 403 && denied.payload.error?.code === 'SCOPE_DENIED', 'Read-only credential accepted write action');
  passed('read_only_scope_boundary');
  const mcpInput = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'zhicui_library_list', arguments: { per_page: 3 } } },
  ].map((item) => JSON.stringify(item)).join('\n');
  const mcp = await cli(['mcp', 'serve', '--stdio'], { json: false, input: mcpInput });
  const discovery = mcp.data.find((item) => item.id === 2)?.result?.tools;
  check(Array.isArray(discovery) && discovery.some((item) => item.name === 'zhicui_library_list'), 'MCP discovery failed');
  check(!discovery.some((item) => /admin|shell|import_link|local_|cancel/u.test(item.name)), 'MCP exposed unauthorized tools');
  const called = mcp.data.find((item) => item.id === 3)?.result;
  check(called?.isError === false && called.structuredContent?.status === 'succeeded', 'MCP library invocation failed');
  passed('mcp_stdio_discovery_and_call', { tool_count: discovery.length });

  await revoke(patId);
  await revoke(patId); // 吊销应当幂等。
  const revoked = await cli(['account', 'get'], { allowFailure: true });
  check(revoked.code !== 0 && revoked.data.error?.code === 'CREDENTIAL_REVOKED', 'Revoked PAT remains usable');
  await cli(['auth', 'logout']);
  passed('pat_revoke_idempotent_and_denied');

  const beforeDevice = await request('/api/agent-interface/v1/devices');
  initialDeviceIds = new Set(beforeDevice.data.items.map((item) => item.id));
  const device = await cli(['auth', 'login', '--no-open', '--scopes', SCOPES.join(','), '--jsonl', '--timeout', '90s'], {
    json: false,
    onEvent: async (event) => {
      if (event.event !== 'device_authorization') return;
      pendingCode = event.user_code;
      check(new URL(event.verification_url).origin === parsedApi.origin, 'Device authorization origin mismatch');
      const preview = await request(`/api/agent-interface/v1/auth/device/request?user_code=${encodeURIComponent(pendingCode)}`);
      check(preview.data.status === 'pending' && JSON.stringify([...preview.data.scopes].sort()) === JSON.stringify([...SCOPES].sort()), 'Device scope preview mismatch');
      // 仅在上方已确认的专用普通测试账号中模拟浏览器点击，绝不授权个人账号。
      await request('/api/agent-interface/v1/auth/device/approve', { method: 'POST', body: { user_code: pendingCode, approve: true } });
    },
  });
  check(device.data.some((item) => item.event === 'authorization_complete' && item.authenticated === true), 'Device authorization not completed');
  let saved = await rememberStoredCredential();
  check(saved?.kind === 'device' && Boolean(saved.refresh_token), 'Device credentials missing');
  const deviceStatus = await cli(['auth', 'status', '--verify']);
  check(deviceStatus.data.valid === true, 'Device credential verification failed');
  saved = await rememberStoredCredential();
  passed('device_request_preview_approve_poll');

  // 只改变本次独立测试 profile 的过期元数据，以走 CLI 的真实刷新路径。
  await credentialManager.save({ ...saved, expires_at: new Date(Date.now() - 1_000).toISOString() });
  const afterRefresh = await cli(['account', 'get']);
  check(afterRefresh.data.status === 'succeeded', 'Refreshed credential action failed');
  const refreshed = await rememberStoredCredential();
  check(refreshed.refresh_token !== saved.refresh_token, 'Refresh token did not rotate');
  passed('device_refresh_rotation');
}

let failed;
try { await main(); }
catch (error) { failed = error instanceof SmokeError ? error.message : 'Smoke failed; sensitive diagnostics suppressed'; }
finally {
  const cleanupErrors = [];
  if (browserToken) {
    try { await rememberStoredCredential(); } catch { cleanupErrors.push('read_test_profile'); }
    try {
      // 创建请求成功但后续解析/进程中断时，仍只回收本次唯一名称的 PAT。
      const listed = await request('/api/agent-interface/v1/credentials');
      for (const item of listed.data.items || []) if (item.name === PAT_NAME) credentialIds.add(item.id);
    } catch { cleanupErrors.push('list_own_pat'); }
    for (const id of credentialIds) {
      try { await revoke(id); } catch { cleanupErrors.push('revoke_test_credential'); }
    }
    if (pendingCode) {
      try { await request('/api/agent-interface/v1/auth/device/approve', { method: 'POST', body: { user_code: pendingCode, approve: false }, allowFailure: true }); }
      catch { cleanupErrors.push('close_test_device_request'); }
    }
    if (initialDeviceIds) {
      try {
        const devices = await request('/api/agent-interface/v1/devices');
        // 网络在发证后、CLI 落盘前断开时，不能误报全部已清理；也不能猜测撤销别的并发连接。
        if (devices.data.items.some((item) => !initialDeviceIds.has(item.id) && !item.revoked_at)) {
          cleanupErrors.push('unaccounted_device_credential');
        }
      } catch { cleanupErrors.push('verify_test_device_cleanup'); }
    }
  }
  if (credentialManager) {
    try { await credentialManager.delete(); } catch { cleanupErrors.push('delete_test_profile'); }
  }
  if (configDirectory) {
    // 该路径只来自本进程的 mkdtemp，且只存放测试 profile 的加密凭据和锁。
    const parent = resolve(dirname(configDirectory));
    if (parent === resolve(tmpdir()) && configDirectory.startsWith(join(parent, 'zhicui-agent-cli-smoke-'))) {
      try { await rm(configDirectory, { recursive: true, force: true }); } catch { cleanupErrors.push('remove_test_directory'); }
    } else cleanupErrors.push('unsafe_test_directory');
  }
  report.cleanup = cleanupErrors.length === 0;
  report.cleanup_errors = cleanupErrors;
  report.passed = !failed && report.cleanup;
  report.completed_at = new Date().toISOString();
  if (failed) report.failure = failed;
  if (process.env.SMOKE_REPORT_FILE) {
    try { await writeFile(process.env.SMOKE_REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
    catch { report.passed = false; report.failure = 'Cannot write sanitized smoke report'; }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.passed) process.exitCode = 1;
}
