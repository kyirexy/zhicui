import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Call = { name: string; args: unknown[] };
const ok = (data: unknown) => ({ success: true, data });

function harness(options: { douyin?: boolean; bili?: boolean; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const exports = {} as typeof import('./syncDailyAnalysisSources');
  const source = readFileSync(new URL('./syncDailyAnalysisSources.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const local = new Map<string, string>([
    ['zhicui_token', 'token-user-a'],
    ['zhicui-platform-account-connections:profile-a', JSON.stringify({ douyin: options.douyin !== false, bilibili: options.bili === true })],
  ]);
  const bridge = {
    getRuntimeInfo: async () => ({ version: '1.2.0' }),
    onPlatformAccountStatus: () => () => undefined,
    collectPlatformAccount: async (request: { platform: string; mode: string }) => {
      calls.push({ name: 'collectPlatformAccount', args: [request] });
      if (options.fail) return { success: false, platform: request.platform, mode: request.mode, error: '读取失败' };
      if (request.platform === 'bilibili') return { success: true, platform: 'bilibili', mode: request.mode, urls: ['https://bilibili.com/video/BV1'] };
      return { success: true, platform: 'douyin', mode: request.mode, coverage: 'complete', orderReliable: true, items: [{ videoId: `${request.mode}-1`, sourceUrl: 'https://douyin.com/video/1', title: 't', caption: '', authorName: '', coverUrl: '', publishedAt: '', durationSeconds: 1, sourceRank: 1 }] };
    },
    cancelPlatformAccountSync: async () => ({ success: true }),
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
    exports, Error, AbortController, crypto: { randomUUID: () => 'run-1' }, window: { zhicuiDesktop: bridge, localStorage: { getItem: (k: string) => local.get(k), setItem: (k: string, v: string) => local.set(k, v) } },
    require(name: string) {
      if (name === './api') return Object.fromEntries(Object.keys(handlers).map((key) => [key, request(key)]));
      if (name === './authSession') return { readStoredToken: () => local.get('zhicui_token') };
      if (name === './desktopRuntime') return { supportsPlatformAccountSync: (value: unknown) => Boolean((value as { collectPlatformAccount?: unknown })?.collectPlatformAccount) };
      if (name === './douyinDesktopSync') return { supportsLocalDouyinRuntime: () => true, toLocalDouyinSyncItems: (items: unknown[]) => items };
      if (name === './douyinSyncFeedback') return { hasDouyinSyncFailureDiagnostic: (value: { error?: string }) => Boolean(value.error) };
      if (name === './platformSyncSnapshot') return { capturePlatformSyncSnapshot: () => ({ sourceSyncedAt: new Date().toISOString() }) };
      if (name === './platformSyncFeedback') return { platformSyncWarning: () => '' };
      throw new Error(name);
    },
  });
  return { calls, run: (override: Partial<Parameters<typeof exports.syncDailyAnalysisSources>[0]> = {}) => exports.syncDailyAnalysisSources({ userId: 'user-a', profileKey: 'profile-a', onProgress: () => undefined, ...override }) };
}

test('今日分析按收藏、喜欢串行读取已连接的桌面来源', async () => {
  const h = harness({ bili: true });
  const result = await h.run();
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(h.calls.filter((entry) => entry.name === 'collectPlatformAccount').map((entry) => {
    const request = entry.args[0] as { platform: string; mode: string };
    return `${request.platform}:${request.mode}`;
  }), ['douyin:collect', 'bilibili:collect', 'douyin:like', 'bilibili:like']);
});

test('全部来源失败时抛错，不能继续伪装成分析成功', async () => {
  await assert.rejects(() => harness({ fail: true }).run(), /读取失败/);
});

test('没有已连接来源时在写入前拒绝', async () => {
  await assert.rejects(() => harness({ douyin: false }).run(), /请先/);
  assert.equal(harness({ douyin: false }).calls.some((entry) => entry.name === 'collectPlatformAccount'), false);
});
