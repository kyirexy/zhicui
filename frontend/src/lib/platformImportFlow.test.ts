import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as batches from './platformImportBatch.ts';
import * as jobs from './bilibiliImportJobs.ts';
import { platformImportSummary } from './libraryIncrementalSync.ts';
import { capturePlatformSyncSnapshot } from './platformSyncSnapshot.ts';
import type { PlatformLibraryImportEntry } from './types';

const panel = readFileSync(new URL('../components/PlatformLibraryPanel.tsx', import.meta.url), 'utf8');
const input = Array.from({ length: 20 }, (_, index) => `https://www.bilibili.com/video/BVtest${index}`);

function panelFlow(importResult: object, options: { throwBridge?: boolean; changeUser?: boolean; cancelled?: boolean; initial?: PlatformLibraryImportEntry[] } = {}) {
  const resultSets: PlatformLibraryImportEntry[][] = [], actions: string[] = [], connections: object[] = [];
  const currentUserIdRef = { current: 'owner' };
  let imported = 0, collected = 0, refreshes = 0;
  const resultsRef = { current: options.initial || [] };
  const apiCalls: unknown[][] = [];
  const context = vm.createContext({
    window: { zhicuiDesktop: { collectPlatformAccount: async () => {
      collected += 1;
      if (options.throwBridge) throw new Error('internal Electron exception');
      if (options.cancelled) return { success: false, cancelled: true };
      return { success: true, urls: input, coverage: 'complete', orderReliable: true };
    } } },
    accountBridgeAvailable: true, user: { id: 'owner', agent_profile_key: 'fixture-owner' }, accountAction: '',
    mountedRef: { current: true }, currentUserIdRef, jobRefreshRef: { current: 0 },
    resultsRef, hasUnresolvedBilibiliSource: jobs.hasUnresolvedBilibiliSource,
    refreshImportResults: async () => { refreshes += 1; },
    bilibiliRetrySourcesRef: { current: [] }, canRetryBilibili: false,
    setCanRetryBilibili: (value: boolean) => { context.canRetryBilibili = value; },
    readLibraryQuickSyncPreferences: () => ({ count: 20 }),
    setFeedbackView: () => {}, setRefreshingResults: () => {}, setError: () => {},
    setAccountAction: (value: string) => actions.push(value),
    setResults: (value: PlatformLibraryImportEntry[] | ((current: PlatformLibraryImportEntry[]) => PlatformLibraryImportEntry[])) => {
      const next = typeof value === 'function' ? value(resultsRef.current) : value;
      resultsRef.current = next; resultSets.push(next);
    },
    capturePlatformSyncSnapshot, updateAccountConnection: (_platform: string, value: object) => connections.push(value),
    accountConnections: { bilibili: { connected: true } },
    importPlatformLibraryItems: async (...args: unknown[]) => { apiCalls.push(args.slice(0, 3)); imported += 1;
      if (options.changeUser) currentUserIdRef.current = 'new-owner'; return importResult; },
    platformImportErrorMessage: batches.platformImportErrorMessage,
    unsubmittedPlatformImports: batches.unsubmittedPlatformImports,
    platformImportSummary, platformSyncWarning: () => '', load: async () => {},
  });
  const code = panel.slice(panel.indexOf('const syncAccount = async'), panel.indexOf('const toggleAccountMode ='));
  vm.runInContext(ts.transpileModule(`${code}\nglobalThis.run = syncAccount; globalThis.retry = retryBilibiliSync;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  return { run: () => context.run('bilibili', ['like', 'collect']), resultSets, actions, connections, imports: () => imported,
    collects: () => collected, refreshes: () => refreshes, retry: () => context.retry(), apiCalls };
}

test('真实Panel遇结果未知停止后续来源，保留未发送数量并收尾busy', async () => {
  const result = await batches.importPlatformBatches(input, async () => ({ success: false, status: 502 }));
  const flow = panelFlow(result);
  await flow.run();
  assert.equal(flow.imports(), 1);
  assert.equal(flow.actions.at(-1), '');
  const entries = flow.resultSets.at(-1)!;
  assert.equal(entries.filter((entry) => entry.status === 'pending').length, 10);
  assert.equal(entries.filter((entry) => entry.status === 'not_submitted').length, 30);
  assert.equal((flow.connections.at(-1) as { stage: string }).stage, 'error');
});

test('真实Panel取消喜欢后不重新打开收藏窗口；已有后台任务点击仅查看进度', async () => {
  const cancelled = panelFlow({}, { cancelled: true });
  await cancelled.run();
  assert.equal(cancelled.collects(), 1); assert.equal(cancelled.imports(), 0);
  assert.equal(cancelled.actions.at(-1), '');
  const active = panelFlow({}, { initial: [{ input: input[0], platform: 'bilibili', status: 'pending', success: false,
    job_id: 'running-job', background_pending: true, submission_key: 'collect:1000:0' }] });
  await active.run();
  assert.equal(active.collects(), 0); assert.equal(active.imports(), 0); assert.equal(active.refreshes(), 1);
});

test('POST未确认且服务端列表尚无任务时，用户可显式沿用原快照重试，不重新采集', async () => {
  const response = await batches.importPlatformBatches(input, async () => ({ success: false, status: 502 }));
  const flow = panelFlow(response);
  await flow.run();
  assert.equal(flow.collects(), 2); assert.equal(flow.imports(), 1);
  const original = JSON.stringify(flow.apiCalls[0]);
  response.data = { items: input.map((input) => ({ input, success: true, status: 'reused' })), total: 20, success: 20, failed: 0 };
  await flow.retry();
  assert.equal(flow.collects(), 2, '人工重试仅提交原内容，不调用原生采集');
  assert.equal(flow.imports(), 3, '原来未知的来源与尚未开始来源各提交一次');
  assert.equal(JSON.stringify(flow.apiCalls[1]), original, 'urls/mode/source_synced_at/coverage/reliable全部保持原快照');
  assert.equal(flow.actions.at(-1), '');
});

test('真实Panel在桥接异常后释放按钮，不展示底层异常；切账号丢弃迟到结果', async () => {
  const throwing = panelFlow({}, { throwBridge: true });
  await throwing.run();
  assert.equal(throwing.actions.at(-1), '');
  assert.equal(throwing.imports(), 0);
  assert.doesNotMatch(JSON.stringify(throwing.connections), /Electron|exception/);
  const result = await batches.importPlatformBatches(input, async (batch) => ({ success: true, data: {
    items: batch.urls.map((input) => ({ input, success: true, status: 'reused' })), total: batch.urls.length, success: batch.urls.length, failed: 0,
  } }));
  const switched = panelFlow(result, { changeUser: true });
  await switched.run();
  assert.equal(switched.imports(), 1);
  assert.ok(switched.resultSets.every((value) => value.length === 0));
});

test('Panel把公共故障汇总，明细默认折叠，刷新只读取持久状态', () => {
  assert.match(panel, /<details>\s*<summary>查看视频明细/);
  assert.match(panel, /platformImportNotice\(results\)/);
  assert.match(panel, /return watchBilibiliJobs\(activeBilibiliJobIds.split\(','\)/);
  assert.match(panel, /if \(completed\(next\) > completed\(previous\)\) notifyLibraryUpdated\(\)/);
  const refresh = panel.slice(panel.indexOf('const refreshImportResults'), panel.indexOf('const filteredItems'));
  assert.match(refresh, /await listBilibiliImportJobs\(\)/);
  assert.match(refresh, /refreshId !== jobRefreshRef.current \|\| accountActionRef.current/);
  assert.doesNotMatch(refresh, /importPlatformLibraryItems\(/);
  assert.doesNotMatch(panel, /未知平台|importResultLabel|结果待确认，可重试/);
});

test('真实API仅B站账号来源使用短提交任务接口，手动/XHS仍走已有导入', async () => {
  const calls: Array<{ path: string; body?: { urls: string[]; source_rank_offset: number; source_synced_at: string }; signal?: AbortSignal }> = [];
  const durable = new Map();
  let notifications = 0;
  const exports = {};
  const context = vm.createContext({ exports, process: { env: {} }, URL, URLSearchParams, Headers, AbortController,
    setTimeout, clearTimeout,
    require: (name: string) => {
      if (name === './libraryUpdates') return { notifyLibraryUpdated: () => notifications++ };
      if (name === './douyinDesktopSync') return {};
      if (name === './platformImportBatch') return batches;
      if (name === './bilibiliImportJobs') return jobs;
      if (name === './authSession') return { readStoredToken: () => 'fixture-only', sessionFetch: async (path: string, options: RequestInit) => {
        const body = options.body ? JSON.parse(String(options.body)) : undefined;
        calls.push({ path, body, signal: options.signal as AbortSignal });
        if (path === '/api/library/bilibili/import-jobs') {
          const id = `job-${body.source_rank_offset}`;
          const job = { id, status: 'queued', total: body.urls.length, completed: 0, success: 0, failed: 0,
            items: body.urls.map((input: string) => ({ input, platform: 'bilibili', status: 'pending', success: false })) };
          durable.set(id, job); return new Response(JSON.stringify({ success: true, data: job }), { status: 202 });
        }
        if (path.startsWith('/api/library/bilibili/import-jobs/')) {
          const job = durable.get(path.split('/').at(-1));
          return new Response(JSON.stringify({ success: true, data: { ...job, status: 'succeeded', completed: job.total,
            success: job.total, items: job.items.map((entry: object) => ({ ...entry, status: 'reused', success: true })) } }));
        }
        return new Response(JSON.stringify({ success: true, data: { total: body.urls.length, success: body.urls.length, failed: 0,
          items: body.urls.map((input: string) => ({ input, success: true, status: 'reused' })) } }));
      } };
      throw new Error(name);
    },
  });
  const code = ts.transpileModule(readFileSync(new URL('./api.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(code, context);
  const api = exports as { importPlatformLibraryItems: (...args: unknown[]) => Promise<{ data: { success: number; items: PlatformLibraryImportEntry[] } }> };
  const snapshot = { sourceSyncedAt: '2026-09-14T10:00:00Z', coverage: 'complete', orderReliable: true };
  const result = await api.importPlatformLibraryItems(input, 'collect', snapshot);
  assert.equal(result.data.success, 20);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.path), ['/api/library/bilibili/import-jobs', '/api/library/bilibili/import-jobs']);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.body?.source_rank_offset), [0, 10]);
  assert.ok(calls.slice(0, 2).every((call) => call.body?.source_synced_at === snapshot.sourceSyncedAt));
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
  assert.equal(notifications, 1, '只在已完成数量增加时刷新资料，入队不算完成');
  assert.ok(result.data.items.every((entry) => entry.submission_key));
  await api.importPlatformLibraryItems([input[0]]);
  assert.equal(calls.at(-1)?.path, '/api/library/imports');
  await api.importPlatformLibraryItems(['https://www.xiaohongshu.com/explore/fixture'], 'collect', snapshot);
  assert.equal(calls.at(-1)?.path, '/api/library/imports');
});
