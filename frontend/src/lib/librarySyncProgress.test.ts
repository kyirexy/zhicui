import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createSyncNoticeReporter, formatTranscriptPreparationProgress } from './douyinSyncFeedback.ts';
import { hasReadyTranscript } from './libraryTranscriptPreparation.ts';
import { LibraryExtractionBatchTracker, runReservedExtractionBatches } from './libraryExtractionQueue.ts';
import { MIN_LOCAL_DOUYIN_DESKTOP_VERSION, requiresLocalDouyinDesktopUpdate } from './douyinDesktopSync.ts';
import { capturePlatformSyncSnapshot } from './platformSyncSnapshot.ts';
import { getDouyinSyncRecoveryIssue, updateDouyinSyncRecovery } from './douyinSyncRecovery.ts';

// 执行页面实际任务函数，覆盖弹窗回调接线和迟到响应，而非重写一份模拟实现。
const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
const taskSource = page.slice(page.indexOf('  const waitForExtractionJob = async'), page.indexOf('  const extractStructuredSelected = async'));
const code = ts.transpileModule(`${taskSource}\n exports.extractItems = extractItems;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const pending = Array.from({ length: 10 }, (_, index) => ({ aweme_id: String(index), can_extract: true, transcript_chars: 0 }));
const running = { job_id: 'job', operation: 'transcript', status: 'running', total: 10, success: 9, failed: 0, active: 1, queued: 0,
  items: pending.map((item, index) => ({ aweme_id: item.aweme_id, state: index < 9 ? 'done' : 'transcribing',
    note_id: index < 9 ? `note-${index}` : null, transcript_chars: index < 9 ? 100 : 0,
    ai_initialized: false, already_existed: false, error: '', updated_at: '2026-09-14T00:00:00Z' })),
};
const completed = { ...running, status: 'success', success: 10, active: 0,
  items: running.items.map((item) => ({ ...item, state: 'done', note_id: `note-${item.aweme_id}`, transcript_chars: 100 })),
};

for (const desktopVersion of ['1.1.2', '1.1.3']) {
test(`${desktopVersion} 加载新网页后，资料库和Agent同步入口均先提示升级而不开始采集`, async () => {
  const messages: string[] = [];
  const syncSource = page.slice(page.indexOf('  const syncCollection = async'), page.indexOf('  const syncCollectionRef = useRef'));
  const syncCode = ts.transpileModule(`${syncSource}\nexports.run = syncCollection;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const library = {
    exports: {} as { run: () => Promise<{ started: boolean }> }, desktopVersion,
    desktopDouyinUpdateRequired: requiresLocalDouyinDesktopUpdate(desktopVersion), MIN_LOCAL_DOUYIN_DESKTOP_VERSION,
    publishSourceManagerNotice: (message: string) => messages.push(message),
  };
  vm.runInNewContext(syncCode, library);
  assert.equal((await library.exports.run()).started, false);
  assert.ok(messages[0].includes(desktopVersion));
  assert.ok(messages[0].includes(`安装 ${MIN_LOCAL_DOUYIN_DESKTOP_VERSION}`));

  const sheet = readFileSync(new URL('../components/agent/AgentSourceSyncSheet.tsx', import.meta.url), 'utf8');
  const sheetSource = sheet.slice(sheet.indexOf('  const syncDouyin = async'), sheet.indexOf('  const importLinks = async'));
  const sheetCode = ts.transpileModule(`${sheetSource}\nexports.run = syncDouyin;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const agent = {
    exports: {} as { run: () => Promise<void> }, user: { id: 'a' }, currentUserIdRef: { current: 'a' }, accountEpochRef: { current: 1 }, runningRef: { current: false },
    douyinDesktopVersion: desktopVersion, douyinDesktopAvailable: true,
    douyinDesktopUpdateRequired: requiresLocalDouyinDesktopUpdate(desktopVersion), MIN_LOCAL_DOUYIN_DESKTOP_VERSION,
    douyinMode: 'collect', syncCount: 50, setPending: () => {}, setFailed: () => {}, setMessage: (message: string) => messages.push(message), onCompleted: () => {},
  };
  vm.runInNewContext(sheetCode, agent);
  await agent.exports.run();
  assert.ok(messages.at(-1)!.includes(desktopVersion));
  assert.ok(messages.at(-1)!.includes(`安装 ${MIN_LOCAL_DOUYIN_DESKTOP_VERSION}`));
  assert.equal(agent.runningRef.current, false);
});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(start: () => Promise<unknown>, poll: () => Promise<unknown> = async () => ({ success: true, data: completed })) {
  const notices: string[] = [];
  const batchFlags: boolean[] = [];
  const applied: unknown[] = [];
  const cacheWrites: unknown[] = [];
  const noOp = () => {};
  const context = {
    exports: {} as { extractItems: (targets: unknown[], operation: string, options: unknown) => Promise<{ status: string }> },
    activeRef: { current: true }, user: { id: 'a' }, currentUserIdRef: { current: 'a' },
    extractionUserEpochRef: { current: 1 }, extractionOwnerRef: { current: 0 }, batchExtractingRef: { current: false },
    extractionQueueRef: { current: null as LibraryExtractionBatchTracker | null }, extractionNoticeRef: { current: (_message: string) => {} },
    LibraryExtractionBatchTracker, runReservedExtractionBatches,
    extractionRevisionRef: { current: '' }, sourceModeRef: { current: 'collect' }, sourceSortsRef: { current: { collect: 'collection' } }, libraryRequestRef: { current: 0 },
    // 页面和导入的真实队列在浏览器共享 Error 构造器；VM 也需保持同一运行域语义。
    ALL_LIBRARY_ITEMS: 0, JOB_POLL_TIMEOUT_MS: 30000, Error, AbortController, window: { setTimeout, clearTimeout },
    wait: async () => {}, hasReadyTranscript, formatTranscriptPreparationProgress,
    setNotice: (message: string) => notices.push(message), setBatchExtracting: (value: boolean) => batchFlags.push(value),
    setActiveBatchOperation: noOp, setExtractionJob: noOp, setPipelineStage: noOp, setExtractProgress: noOp, setLoading: noOp,
    startDouyinBatchExtraction: start, getDouyinBatchExtraction: poll,
    applyExtractionJob: (job: unknown) => { applied.push(job); return true; },
    clearLibraryListCache: () => cacheWrites.push('clear'), getLibraryRevision: () => 1, isLibraryRevisionCurrent: () => true,
    listDouyinLibraryItems: async () => ({ success: true, data: { items: [] } }),
    writeLibraryListCache: () => cacheWrites.push('write'), applyLibraryListResult: noOp,
  };
  vm.runInNewContext(code, context);
  const reporter = createSyncNoticeReporter('新增 10 条，已有 20 条', () => true, (message) => notices.push(message));
  return { context, notices, batchFlags, applied, cacheWrites, run: () => context.exports.extractItems(pending, 'transcript', { background: true, onNotice: reporter }) };
}

test('弹窗保留同步摘要，实际9/10处理中与最终10/10完成持续更新', async () => {
  const polling = deferred<unknown>();
  const pollStarted = deferred<void>();
  const h = harness(async () => ({ success: true, data: running }), () => { pollStarted.resolve(); return polling.promise; });
  const result = h.run();
  await pollStarted.promise;
  assert.match(h.notices.at(-1)!, /新增 10 条，已有 20 条；文案准备中 · 已完成 9\/10/);
  polling.resolve({ success: true, data: completed });
  assert.equal((await result).status, 'success');
  assert.match(h.notices.at(-1)!, /新增 10 条，已有 20 条；文案已完成 10\/10/);
  assert.ok(h.notices.every((message) => !message.includes('将在')));
});

test('文稿启动失败同步到弹窗并保留已登记的新增复用结果', async () => {
  const h = harness(async () => ({ success: false, error: '服务暂不可用' }));
  assert.equal((await h.run()).status, 'failed');
  assert.match(h.notices.at(-1)!, /新增 10 条，已有 20 条；文案已完成 0\/10 条；10 条未完成，可重试/);
  assert.doesNotMatch(h.notices.at(-1)!, /服务暂不可用/);
  assert.equal(h.context.batchExtractingRef.current, false);
});

test('A→B→A后迟到的任务启动不能恢复旧任务或清除新任务标记', async () => {
  const starting = deferred<unknown>();
  const h = harness(() => starting.promise);
  const result = h.run();
  const beforeSwitch = { applied: [...h.applied], flags: [...h.batchFlags] };
  assert.equal(h.context.extractionQueueRef.current?.snapshot()?.queued, 10, '提交之前先显示全部待处理数量');
  h.context.extractionUserEpochRef.current += 2;
  h.context.extractionOwnerRef.current += 2;
  h.context.extractionQueueRef.current = new LibraryExtractionBatchTracker();
  starting.resolve({ success: true, data: running });
  assert.equal((await result).status, 'skipped');
  assert.deepEqual(h.applied, beforeSwitch.applied, '账号切换后不再写入任何旧任务状态');
  assert.equal(h.context.batchExtractingRef.current, true);
  assert.deepEqual(h.batchFlags, beforeSwitch.flags);
});

test('A→B→A后迟到的完成轮询不清理缓存、不写回旧进度', async () => {
  const polling = deferred<unknown>();
  const pollStarted = deferred<void>();
  const h = harness(async () => ({ success: true, data: running }), () => { pollStarted.resolve(); return polling.promise; });
  const result = h.run();
  await pollStarted.promise;
  const beforeSwitch = { applied: [...h.applied], flags: [...h.batchFlags] };
  assert.equal(h.context.extractionQueueRef.current?.snapshot()?.success, 9);
  h.context.extractionUserEpochRef.current += 2;
  h.context.extractionOwnerRef.current += 2;
  h.context.extractionQueueRef.current = new LibraryExtractionBatchTracker();
  polling.resolve({ success: true, data: completed });
  assert.equal((await result).status, 'skipped');
  assert.deepEqual(h.applied, beforeSwitch.applied);
  assert.deepEqual(h.cacheWrites, []);
  assert.deepEqual(h.batchFlags, beforeSwitch.flags);
});

test('任务完成刷新期间切换账号，旧列表响应不写入新会话缓存', async () => {
  const refreshing = deferred<{ success: boolean; data: { items: never[] } }>();
  const refreshStarted = deferred<void>();
  const h = harness(async () => ({ success: true, data: completed }));
  h.context.listDouyinLibraryItems = () => { refreshStarted.resolve(); return refreshing.promise; };
  const result = h.run();
  await refreshStarted.promise;
  h.context.extractionUserEpochRef.current += 2;
  h.context.extractionOwnerRef.current += 2;
  h.context.extractionQueueRef.current = new LibraryExtractionBatchTracker();
  refreshing.resolve({ success: true, data: { items: [] } });
  assert.equal((await result).status, 'skipped');
  assert.deepEqual(h.cacheWrites, ['clear']);
});

test('Agent同步弹窗账号往返后，旧采集结果不清除新任务标记或发送完成通知', async () => {
  const source = readFileSync(new URL('../components/agent/AgentSourceSyncSheet.tsx', import.meta.url), 'utf8');
  const sync = source.slice(source.indexOf('  const syncDouyin = async'), source.indexOf('  const importLinks = async'));
  const syncCode = ts.transpileModule(`${sync}\n exports.syncDouyin = syncDouyin;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const collecting = deferred<unknown>();
  const pendingFlags: boolean[] = [];
  const completed: unknown[] = [];
  const context = {
    exports: {} as { syncDouyin: () => Promise<void> },
    user: { id: 'a' }, currentUserIdRef: { current: 'a' }, accountEpochRef: { current: 1 }, runningRef: { current: false },
    douyinMode: 'collect', syncCount: 50, douyinDesktopUpdateRequired: false, douyinDesktopAvailable: true, douyinConnected: true, profileKey: 'a',
    setPending: (value: boolean) => pendingFlags.push(value), setFailed: () => {}, setMessage: () => {}, setDouyinStage: () => {},
    window: { zhicuiDesktop: { collectPlatformAccount: () => collecting.promise } },
    onCompleted: (value: unknown) => completed.push(value),
  };
  vm.runInNewContext(syncCode, context);
  const result = context.exports.syncDouyin();
  context.accountEpochRef.current += 2;
  collecting.resolve({ success: true, items: [{ aweme_id: 'old' }] });
  await result;
  assert.deepEqual(pendingFlags, [true]);
  assert.equal(context.runningRef.current, true);
  assert.deepEqual(completed, []);
});

test('真实采集函数识别本机忙碌，不写资料并要求多来源循环停止', async () => {
  const source = page.slice(page.indexOf('  const collectOneSource = async'), page.indexOf('  const syncCollection = async'));
  const collectCode = ts.transpileModule(`${source}\nexports.run = collectOneSource;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls: unknown[] = [];
  const noOp = () => {};
  const context = {
    exports: {} as { run: (...args: unknown[]) => Promise<{ queueMayStillBeRunning: boolean; needsAction: boolean; error: string }> },
    user: { id: 'owner', agent_profile_key: 'profile-owner' }, currentUserIdRef: { current: 'owner' },
    SOURCE_MODES: [{ value: 'like', label: '喜欢' }], sourceSorts: { like: 'collection' },
    batchExtractingRef: { current: false }, ALL_LIBRARY_ITEMS: 0, desktopLocalDouyin: true,
    sourceSyncGenerationRef: { current: 1 }, activeDesktopSyncRef: { current: null },
    syncRecoveryActionRef: { current: null }, syncRecoveryCancelRef: { current: null },
    setCollectionJob: noOp, setSyncRecoveryFocusing: noOp, setSyncRecoveryActionError: noOp,
    setSyncRecoveryIssues: noOp, capturePlatformSyncSnapshot, getDouyinSyncRecoveryIssue, updateDouyinSyncRecovery,
    listDouyinLibraryItems: async () => ({ success: true, data: { items: [] } }),
    ingestLocalDouyinLibrary: () => assert.fail('本机未开始采集时不得写入资料'),
    window: { zhicuiDesktop: { collectPlatformAccount: async (request: unknown) => {
      calls.push(request);
      return { success: false, code: 'LOCAL_ACTION_BUSY', error: '另一个平台操作仍在进行' };
    } } },
  };
  vm.runInNewContext(collectCode, context);
  const result = await context.exports.run('like', 50, noOp, () => true, false, 'this-sync-session', true);
  assert.equal(result.queueMayStillBeRunning, true, '本机忙碌必须阻止继续打开下一个分类');
  assert.equal(result.needsAction, false, '忙碌不应误导用户去官方页面验证');
  assert.match(result.error, /等待完成/);
  assert.equal(context.activeDesktopSyncRef.current, null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{
    platform: 'douyin', profileKey: 'profile-owner', mode: 'like', limit: 50,
    interactive: false, sessionKey: 'this-sync-session', keepSessionOpen: true,
  }]);
});
