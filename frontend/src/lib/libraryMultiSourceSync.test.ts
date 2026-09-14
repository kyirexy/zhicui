import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { createSyncNoticeReporter, formatMultiSourceSyncSummary } from './douyinSyncFeedback.ts';
import { selectAutomaticTranscriptPreparationTargets, selectTranscriptPreparationTargets, selectSyncedSourceScope } from './libraryTranscriptPreparation.ts';
import { formatPlatformSyncSourceResults } from './platformSyncFeedback.ts';
import {
  isQuickSyncModeReady,
  normalizeQuickSyncModes,
  toggleQuickSyncMode,
} from './libraryQuickSync.ts';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(testDirectory, '..');

test('同步范围支持多选并按界面顺序稳定保存', () => {
  assert.deepEqual(toggleQuickSyncMode(['collect'], 'like'), ['like', 'collect']);
  assert.deepEqual(toggleQuickSyncMode(['like', 'collect'], 'post'), [
    'like',
    'collect',
    'post',
  ]);
  assert.deepEqual(toggleQuickSyncMode(['like', 'collect', 'post'], 'collect'), [
    'like',
    'post',
  ]);
  assert.deepEqual(toggleQuickSyncMode(['like'], 'like'), ['like']);
  assert.deepEqual(normalizeQuickSyncModes(['post', 'like', 'post', 'collect']), [
    'like',
    'collect',
    'post',
  ]);
});

test('旧版兼容链路按真实登录条件判断各来源', () => {
  const unavailable = {
    reported: true,
    like_ready: false,
    collection_ready: false,
  };
  assert.equal(isQuickSyncModeReady('like', unavailable), false);
  assert.equal(isQuickSyncModeReady('collect', unavailable), false);
  assert.equal(isQuickSyncModeReady('post', unavailable), false);

  const collectionUnavailable = {
    reported: true,
    like_ready: true,
    collection_ready: false,
  };
  assert.equal(isQuickSyncModeReady('like', collectionUnavailable), true);
  assert.equal(isQuickSyncModeReady('collect', collectionUnavailable), false);
  assert.equal(isQuickSyncModeReady('post', collectionUnavailable), true);
});

test('同步弹窗使用多选语义且逐项等待每个来源完成', () => {
  const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
  const sequentialSync = page.slice(
    page.indexOf('const syncCollection = async'),
    page.indexOf('const syncCollectionRef = useRef'),
  );
  assert.match(page, /role="group" aria-label="选择一个或多个要同步的抖音来源"/);
  assert.match(page, /aria-pressed=\{active\}/);
  assert.match(page, /选择要同步的内容/);
  assert.match(page, /return readLibraryQuickSyncPreferences\(\)\.modes;/);
  assert.doesNotMatch(page, /readLibraryQuickSyncPreferences\(\)\.modes\[0\]/);
  assert.match(page, /每项 \$\{syncCount\} 条/);
  assert.match(page, /sourceSyncQueue\.current}\/\$\{sourceSyncQueue\.total}/);
  assert.doesNotMatch(page, /role="radiogroup" aria-label="选择一个要同步的抖音来源"/);
  assert.match(
    sequentialSync,
    /for \(const \[modeIndex, requestedMode\] of modes\.entries\(\)\) \{[\s\S]*?await collectOneSource\(requestedMode, requestedCount, reportNotice,\s*\(\) => isSyncUserCurrent\(\) && !syncRun\.cancelled, interactive,\s*syncRun\.sessionKey, modeIndex < modes\.length - 1\)/,
  );
  assert.match(sequentialSync, /try \{[\s\S]*?await collectOneSource/);
  assert.match(sequentialSync, /if \(result\.queueMayStillBeRunning \|\| result\.cancelled \|\| result\.needsAction \|\| syncRun\.cancelled\) break;/);
  assert.match(sequentialSync, /normalizeQuickSyncModes\(/);
  assert.match(sequentialSync, /sourceReadability\.collect\.blockedUntil > Date\.now\(\)/);
  assert.doesNotMatch(sequentialSync, /Promise\.all/);
});

test('补齐待整理文案不会覆盖用户的多选偏好', () => {
  const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
  const pendingTranscriptFlow = page.slice(
    page.indexOf('const preparePendingTranscripts = async'),
    page.indexOf('const deleteExtraction = async'),
  );
  assert.match(pendingTranscriptFlow, /const savedPreferences = readLibraryQuickSyncPreferences\(\);/);
  assert.match(
    pendingTranscriptFlow,
    /syncCollectionRef\.current\([\s\S]*?\[sourceMode\],[\s\S]*?savedPreferences\.modes/,
  );
  assert.doesNotMatch(
    pendingTranscriptFlow,
    /syncCollectionRef\.current\([\s\S]*?\[sourceMode\],[\s\S]*?\[sourceMode\]/,
  );
});

// 执行页面真实循环，覆盖来源间等待、批次窗口参数和恢复中断，而非仅校验函数文本。
for (const outcome of [
  'success', 'needs-action', 'cancelled', 'busy', 'legacy-bridge', 'account-switch', 'switch-during-cleanup',
] as const) {
  test(`真实页面多来源循环：${outcome} 保持顺序与本轮窗口生命周期`, { timeout: 5000 }, async () => {
    const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
    const source = page.slice(page.indexOf('  const syncCollection = async'), page.indexOf('  const syncCollectionRef = useRef'));
    const code = ts.transpileModule(`${source}\nexports.run = syncCollection;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const calls: Array<{ mode: string; current: () => boolean; sessionKey: string; keepOpen: boolean }> = [];
    const closedSessions: string[] = [];
    const refreshingFlags: boolean[] = [];
    let globalCancels = 0;
    let resolveClosing!: () => void;
    let closingStarted!: () => void;
    const closing = new Promise<void>((resolve) => { resolveClosing = resolve; });
    const startedClosing = new Promise<void>((resolve) => { closingStarted = resolve; });
    const noOp = () => {};
    const result = (mode: string) => ({ requestedMode: mode, refreshed: [], newlyVisible: [], overview: null,
      finalJob: { total: 0, success: 0, failed: 0, status: 'success', url: 'desktop-local' }, error: '' });
    const context = {
      exports: {} as { run: (modes: string[], persisted: string[]) => Promise<{ started: boolean }> },
      crypto: { randomUUID }, Error, desktopDouyinUpdateRequired: false, desktopLocalDouyin: true,
      refreshing: false, loggedIn: true, user: { id: 'owner' }, currentUserIdRef: { current: 'owner' }, activeRef: { current: true },
      sourceSyncRunRef: { current: null as { cancelled: boolean; userId?: string; sessionKey: string } | null },
      sourceSyncGenerationRef: { current: 0 }, sourceSyncNoticeOwnedRef: { current: false },
      sourceModeRef: { current: 'collect' }, sourceReadability: {}, batchExtractingRef: { current: false },
      sourceSorts: { collect: 'collection', like: 'collection', post: 'published' }, libraryRequestRef: { current: 0 },
      SOURCE_MODES: [{ value: 'like', label: '喜欢' }, { value: 'collect', label: '收藏' }],
      syncCount: 50, MAX_SYNC_COUNT: 100, clampInteger: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
      normalizeQuickSyncModes, isQuickSyncModeReady, createSyncNoticeReporter, formatMultiSourceSyncSummary, formatPlatformSyncSourceResults,
      selectAutomaticTranscriptPreparationTargets, selectTranscriptPreparationTargets, selectSyncedSourceScope,
      nonNegativeInteger: (value: number) => Math.max(0, Math.trunc(value || 0)), isLibraryRevisionCurrent: () => true,
      publishSourceManagerNotice: noOp, setSourceSyncWarning: noOp, saveLibraryQuickSyncPreferences: noOp,
      setSyncCount: noOp, setRefreshing: (value: boolean) => refreshingFlags.push(value),
      setExtractionJob: noOp, setPipelineStage: noOp, setSourceSyncQueue: noOp,
      setItems: noOp, setCatalogRecoveryPending: noOp, setSelected: noOp, setError: noOp, setLoading: noOp, setLibraryOverview: noOp,
      writeLibraryListCache: noOp, setSyncRecoveryIssues: noOp,
      window: { zhicuiDesktop: {
        cancelPlatformAccountAction: async () => { globalCancels += 1; },
        cancelPlatformAccountSync: outcome === 'legacy-bridge' ? undefined : async (request: { sessionKey: string }) => {
          closedSessions.push(request.sessionKey);
          closingStarted();
          if (outcome === 'switch-during-cleanup') await closing;
          if (outcome === 'busy') throw new Error('已有其他来源正在同步');
          return { cancelled: true };
        },
      } },
      collectOneSource: (mode: string, _count: number, _notice: unknown, current: () => boolean,
        _interactive: boolean, sessionKey: string, keepOpen: boolean) => {
        calls.push({ mode, current, sessionKey, keepOpen });
        return calls.length === 1 ? first : Promise.resolve(result(mode));
      },
    };
    vm.runInNewContext(code, context);
    const task = context.exports.run(['like', 'collect'], ['like', 'collect']);
    assert.deepEqual(calls.map((call) => call.mode), ['like']);
    assert.equal(calls[0].current(), true);
    assert.equal(calls[0].keepOpen, true);
    assert.match(calls[0].sessionKey, /^[0-9a-f-]{36}$/);
    if (outcome === 'cancelled') {
      context.sourceSyncRunRef.current!.cancelled = true;
      assert.equal(calls[0].current(), false, '取消立即使当前来源的迟到保存检查失效');
    }
    const nextRun = { userId: 'other', sessionKey: randomUUID(), cancelled: false };
    const switchAccount = () => {
      context.currentUserIdRef.current = 'other';
      context.sourceSyncGenerationRef.current += 1;
      context.sourceSyncRunRef.current = nextRun;
    };
    if (outcome === 'account-switch') switchAccount();
    const collectionSucceeded = ['success', 'legacy-bridge', 'account-switch', 'switch-during-cleanup'].includes(outcome);
    resolveFirst(collectionSucceeded ? result('like') : { ...result('like'), finalJob: null,
      error: outcome === 'busy' ? '已有其他来源正在同步' : '官方列表未就绪',
      queueMayStillBeRunning: outcome === 'busy',
      needsAction: outcome === 'needs-action', cancelled: outcome === 'cancelled' });
    if (outcome === 'switch-during-cleanup') {
      await startedClosing;
      switchAccount();
      resolveClosing();
    }
    assert.equal((await task).started, true);
    const completedBoth = collectionSucceeded && outcome !== 'account-switch';
    assert.deepEqual(calls.map((call) => call.mode), completedBoth ? ['like', 'collect'] : ['like']);
    if (completedBoth) {
      assert.equal(calls[1].sessionKey, calls[0].sessionKey);
      assert.equal(calls[1].keepOpen, false);
    }
    assert.equal(globalCancels, 0, '自动收尾不得全局取消其他窗口或旧客户端的任务');
    assert.ok(closedSessions.every((sessionKey) => sessionKey === calls[0].sessionKey), '取消只能携带本轮采集的同一个sessionKey');
    if (outcome === 'account-switch' || outcome === 'switch-during-cleanup') {
      assert.equal(context.sourceSyncRunRef.current, nextRun, '迟到收尾不能清除新账号的批次引用');
      assert.deepEqual(refreshingFlags, [true], '旧账号不能恢复新任务的空闲状态');
      assert.ok(!closedSessions.includes(nextRun.sessionKey));
    } else {
      assert.equal(closedSessions.length, outcome === 'legacy-bridge' ? 0 : 1);
      assert.equal(context.sourceSyncRunRef.current, null);
      assert.deepEqual(refreshingFlags, [true, false], '包括忙碌错误和取消失败在内，都必须结束本轮忙碌状态');
    }
  });
}
