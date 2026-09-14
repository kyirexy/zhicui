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
for (const outcome of ['success', 'needs-action', 'cancelled'] as const) {
  test(`真实页面多来源循环：${outcome} 保持顺序与本轮窗口生命周期`, async () => {
    const page = readFileSync(resolve(srcRoot, 'app', 'library', 'page.tsx'), 'utf8');
    const source = page.slice(page.indexOf('  const syncCollection = async'), page.indexOf('  const syncCollectionRef = useRef'));
    const code = ts.transpileModule(`${source}\nexports.run = syncCollection;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    const calls: Array<{ mode: string; current: () => boolean; sessionKey: string; keepOpen: boolean }> = [];
    let closed = 0;
    const noOp = () => {};
    const result = (mode: string) => ({ requestedMode: mode, refreshed: [], newlyVisible: [], overview: null,
      finalJob: { total: 0, success: 0, failed: 0, status: 'success', url: 'desktop-local' }, error: '' });
    const context = {
      exports: {} as { run: (modes: string[], persisted: string[]) => Promise<{ started: boolean }> },
      crypto: { randomUUID }, desktopDouyinUpdateRequired: false, desktopLocalDouyin: true,
      refreshing: false, loggedIn: true, user: { id: 'owner' }, currentUserIdRef: { current: 'owner' }, activeRef: { current: true },
      sourceSyncRunRef: { current: null as { cancelled: boolean; sessionKey: string } | null },
      sourceSyncGenerationRef: { current: 0 }, sourceSyncNoticeOwnedRef: { current: false },
      sourceModeRef: { current: 'collect' }, sourceReadability: {}, batchExtractingRef: { current: false },
      sourceSorts: { collect: 'collection', like: 'collection', post: 'published' }, libraryRequestRef: { current: 0 },
      SOURCE_MODES: [{ value: 'like', label: '喜欢' }, { value: 'collect', label: '收藏' }],
      syncCount: 50, MAX_SYNC_COUNT: 100, clampInteger: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
      normalizeQuickSyncModes, isQuickSyncModeReady, createSyncNoticeReporter, formatMultiSourceSyncSummary, formatPlatformSyncSourceResults,
      selectAutomaticTranscriptPreparationTargets, selectTranscriptPreparationTargets, selectSyncedSourceScope,
      nonNegativeInteger: (value: number) => Math.max(0, Math.trunc(value || 0)), isLibraryRevisionCurrent: () => true,
      publishSourceManagerNotice: noOp, setSourceSyncWarning: noOp, saveLibraryQuickSyncPreferences: noOp,
      setSyncCount: noOp, setRefreshing: noOp, setExtractionJob: noOp, setPipelineStage: noOp, setSourceSyncQueue: noOp,
      setItems: noOp, setCatalogRecoveryPending: noOp, setSelected: noOp, setError: noOp, setLoading: noOp, setLibraryOverview: noOp,
      writeLibraryListCache: noOp, setSyncRecoveryIssues: noOp,
      window: { zhicuiDesktop: { cancelPlatformAccountAction: async () => { closed += 1; } } },
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
    resolveFirst(outcome === 'success' ? result('like') : { ...result('like'), finalJob: null,
      error: '官方列表未就绪', needsAction: outcome === 'needs-action', cancelled: outcome === 'cancelled' });
    assert.equal((await task).started, true);
    assert.deepEqual(calls.map((call) => call.mode), outcome === 'success' ? ['like', 'collect'] : ['like']);
    if (outcome === 'success') {
      assert.equal(calls[1].sessionKey, calls[0].sessionKey);
      assert.equal(calls[1].keepOpen, false);
    }
    assert.equal(closed, 1);
    assert.equal(context.sourceSyncRunRef.current, null);
  });
}
