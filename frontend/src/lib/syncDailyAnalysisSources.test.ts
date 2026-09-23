import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { PlatformAccountCollectRequest, PlatformAccountStatus, PlatformAccountSyncCancelRequest } from './desktopRuntime';

type Call = { name: string; args: unknown[] };
const ok = (data: unknown) => ({ success: true, data });

function loadModule<T>(path: string): T {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { exports, Error });
  return exports as T;
}

// 使用桌面端实际的 IPC 校验器，防止 mock 放过正式客户端会拒绝的请求。
const desktopValidators = loadModule<{
  validatePlatformAccountCollectRequest: (request: PlatformAccountCollectRequest) => PlatformAccountCollectRequest;
  validatePlatformAccountSyncCancelRequest: (request: PlatformAccountSyncCancelRequest) => PlatformAccountSyncCancelRequest;
}>('../../../desktop/src/security.ts');
const feedback = loadModule<typeof import('./platformSyncFeedback')>('./platformSyncFeedback.ts');

function harness(options: {
  douyin?: boolean;
  bili?: boolean;
  fail?: boolean;
  onCollect?: (request: PlatformAccountCollectRequest) => void;
} = {}) {
  const calls: Call[] = [];
  const exports = {} as typeof import('./syncDailyAnalysisSources');
  const source = readFileSync(new URL('./syncDailyAnalysisSources.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const local = new Map<string, string>([
    ['zhicui_token', 'token-user-a'],
    ['zhicui-platform-account-connections:profile-a', JSON.stringify({ douyin: options.douyin !== false, bilibili: options.bili === true })],
  ]);
  const listeners = new Set<(status: PlatformAccountStatus) => void>();
  const bridge = {
    getRuntimeInfo: async () => ({ version: '1.2.0' }),
    onPlatformAccountStatus: (listener: (status: PlatformAccountStatus) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    collectPlatformAccount: async (request: PlatformAccountCollectRequest) => {
      calls.push({ name: 'collectPlatformAccount', args: [request] });
      desktopValidators.validatePlatformAccountCollectRequest(request);
      options.onCollect?.(request);
      if (options.fail) return { success: false, platform: request.platform, mode: request.mode, error: '读取失败' };
      if (request.platform === 'bilibili') return { success: true, platform: 'bilibili', mode: request.mode, urls: ['https://bilibili.com/video/BV1'] };
      return { success: true, platform: 'douyin', mode: request.mode, coverage: 'complete', orderReliable: true, items: [{ videoId: `${request.mode}-1`, sourceUrl: 'https://douyin.com/video/1', title: 't', caption: '', authorName: '', coverUrl: '', publishedAt: '', durationSeconds: 1, sourceRank: 1 }] };
    },
    cancelPlatformAccountSync: async (request: PlatformAccountSyncCancelRequest) => {
      desktopValidators.validatePlatformAccountSyncCancelRequest(request);
      calls.push({ name: 'cancelPlatformAccountSync', args: [request] });
      return { success: true };
    },
  };
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getDouyinLibraryStatus: async () => ok({ connected: false, cookie_valid: false }),
    ingestLocalDouyinLibrary: async () => ok({ accepted: 1, quarantined: 0 }),
    importPlatformLibraryItems: async () => ok({ success: 1, failed: 0, pending: 0, items: [] }),
    collectDouyinLibrary: async () => ok({ job_id: 'job', status: 'success', success: 1, failed: 0, processed: 1 }),
    getDouyinCollectionJob: async () => ok({ job_id: 'job', status: 'success', success: 1, failed: 0, processed: 1 }),
  };
  const request = (name: string) => async (...args: unknown[]) => { calls.push({ name, args }); return handlers[name](...args); };
  runInNewContext(js, {
    exports, Error, AbortController, crypto: { randomUUID }, window: { zhicuiDesktop: bridge, localStorage: { getItem: (k: string) => local.get(k), setItem: (k: string, v: string) => local.set(k, v) } },
    require(name: string) {
      if (name === './api') return Object.fromEntries(Object.keys(handlers).map((key) => [key, request(key)]));
      if (name === './authSession') return { readStoredToken: () => local.get('zhicui_token') };
      if (name === './desktopRuntime') return { supportsPlatformAccountSync: (value: unknown) => Boolean((value as { collectPlatformAccount?: unknown })?.collectPlatformAccount) };
      if (name === './douyinDesktopSync') return { supportsLocalDouyinRuntime: () => true, toLocalDouyinSyncItems: (items: unknown[]) => items };
      if (name === './douyinSyncFeedback') return { hasDouyinSyncFailureDiagnostic: (value: { error?: string }) => Boolean(value.error) };
      if (name === './platformSyncSnapshot') return { capturePlatformSyncSnapshot: () => ({ sourceSyncedAt: new Date().toISOString() }) };
      if (name === './platformSyncFeedback') return feedback;
      throw new Error(name);
    },
  });
  return { calls, listeners, setToken: (token: string) => local.set('zhicui_token', token),
    run: (override: Partial<Parameters<typeof exports.syncDailyAnalysisSources>[0]> = {}) => exports.syncDailyAnalysisSources({ userId: 'user-a', profileKey: 'profile-a', onProgress: () => undefined, ...override }) };
}

test('今日分析按收藏、喜欢串行读取已连接的桌面来源', async () => {
  const h = harness({ bili: true });
  const result = await h.run();
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(h.calls.filter((entry) => entry.name === 'collectPlatformAccount').map((entry) => {
    const request = entry.args[0] as { platform: string; mode: string };
    return `${request.platform}:${request.mode}`;
  }), ['douyin:collect', 'bilibili:collect', 'douyin:like', 'bilibili:like']);
  const requests = h.calls.filter((entry) => entry.name === 'collectPlatformAccount').map((entry) => entry.args[0] as PlatformAccountCollectRequest);
  for (const request of requests) {
    if (request.platform === 'douyin') assert.match(request.sessionKey!, /^[A-Za-z0-9_-]{16,80}$/);
    else assert.equal(Object.hasOwn(request, 'sessionKey'), false);
    assert.equal(Object.hasOwn(request, 'keepSessionOpen'), false);
  }
  assert.notEqual(requests[0].sessionKey, requests[2].sessionKey);
  assert.equal(h.calls.filter((entry) => entry.name === 'ingestLocalDouyinLibrary').length, 2);
  assert.equal(h.calls.filter((entry) => entry.name === 'importPlatformLibraryItems').length, 2);
  assert.equal(h.listeners.size, 0);
});

test('真实桌面校验仍拒绝旧的含冒号批次和 B站携带抖音批次', () => {
  const request: PlatformAccountCollectRequest = { platform: 'douyin', profileKey: 'profile-a', mode: 'collect', limit: 100 };
  assert.throws(() => desktopValidators.validatePlatformAccountCollectRequest({ ...request, sessionKey: `daily-analysis:user-a:${randomUUID()}` }), /批次标识无效/);
  assert.throws(() => desktopValidators.validatePlatformAccountCollectRequest({ ...request, platform: 'bilibili', sessionKey: randomUUID() }), /批次标识无效/);
});

test('取消抖音时只取消本轮合法批次，不保存已过期结果', async () => {
  const controller = new AbortController();
  const h = harness({ onCollect: () => controller.abort() });
  await assert.rejects(() => h.run({ signal: controller.signal }), { name: 'AbortError' });
  const request = h.calls.find((entry) => entry.name === 'collectPlatformAccount')!.args[0] as PlatformAccountCollectRequest;
  const cancels = h.calls.filter((entry) => entry.name === 'cancelPlatformAccountSync');
  assert.equal(cancels.length, 1);
  assert.equal((cancels[0].args[0] as PlatformAccountSyncCancelRequest).sessionKey, request.sessionKey);
  assert.equal(h.calls.some((entry) => /ingestLocal|importPlatform/.test(entry.name)), false);
  assert.equal(h.listeners.size, 0);
});

test('取消 B站不调用抖音批次取消，也不继续导入或读取下个来源', async () => {
  const controller = new AbortController();
  const h = harness({ douyin: false, bili: true, onCollect: () => controller.abort() });
  await assert.rejects(() => h.run({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.filter((entry) => entry.name === 'collectPlatformAccount').length, 1);
  assert.equal(h.calls.some((entry) => /cancelPlatform|ingestLocal|importPlatform/.test(entry.name)), false);
  assert.equal(h.listeners.size, 0);
});

test('采集中切换账号后不能向新账号保存结果', async () => {
  const h = harness({ onCollect: () => h.setToken('token-user-b') });
  await assert.rejects(() => h.run(), /账号已切换/);
  assert.equal(h.calls.some((entry) => /ingestLocal|importPlatform/.test(entry.name)), false);
  assert.equal(h.listeners.size, 0);
});

test('一个来源失败仍导入其余来源，错误不暴露 Electron 调用包装', async () => {
  const h = harness({ bili: true, onCollect: (request) => {
    if (request.platform === 'douyin' && request.mode === 'collect') {
      throw new Error("Error invoking remote method 'desktop:collect-platform-account': Error: 请重新登录抖音后重试");
    }
  } });
  const result = await h.run();
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /抖音收藏.*重新登录抖音/);
  assert.doesNotMatch(result.warnings[0], /Error|desktop:|remote method/);
  assert.equal(h.calls.filter((entry) => entry.name === 'collectPlatformAccount').length, 4);
  assert.equal(h.calls.filter((entry) => entry.name === 'ingestLocalDouyinLibrary').length, 1);
  assert.equal(h.calls.filter((entry) => entry.name === 'importPlatformLibraryItems').length, 2);
  assert.equal(h.listeners.size, 0);
});

test('全部来源失败时抛错，不能继续伪装成分析成功', async () => {
  await assert.rejects(() => harness({ fail: true }).run(), /读取失败/);
});

test('没有已连接来源时在写入前拒绝', async () => {
  const h = harness({ douyin: false });
  await assert.rejects(() => h.run(), /请先/);
  assert.equal(h.calls.some((entry) => entry.name === 'collectPlatformAccount'), false);
});
