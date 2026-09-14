import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { LibraryExtractionBatchTracker, runReservedExtractionBatches } from './libraryExtractionQueue.ts';

import {
  hasReadyTranscript,
  selectAutomaticTranscriptPreparationTargets,
  selectSyncedSourceScope,
  selectTranscriptPreparationTargets,
} from './libraryTranscriptPreparation.ts';
import type { DouyinBatchExtractionJob, DouyinLibraryItem } from './types.ts';

function item(
  awemeId: string,
  overrides: Partial<DouyinLibraryItem> = {},
): DouyinLibraryItem {
  return {
    aweme_id: awemeId,
    title: `视频 ${awemeId}`,
    caption: '',
    author_name: '',
    tags: [],
    can_extract: true,
    extracted: false,
    extracted_note_id: null,
    transcript_chars: 0,
    ai_initialized: false,
    ...overrides,
  } as DouyinLibraryItem;
}

test('treats a persisted non-empty transcript as ready', () => {
  assert.equal(hasReadyTranscript(item('ready', {
    extracted: true,
    extracted_note_id: 'note-ready',
    transcript_chars: 128,
  })), true);
  assert.equal(hasReadyTranscript(item('empty', {
    extracted: true,
    extracted_note_id: 'note-empty',
    transcript_chars: 0,
  })), false);
});

test('includes existing pending videos instead of only newly synced videos', () => {
  const oldPending = item('old-pending');
  const newPending = item('new-pending');
  const emptyPersisted = item('empty-persisted', {
    extracted: true,
    extracted_note_id: 'note-empty',
    transcript_chars: 0,
  });
  const ready = item('ready', {
    extracted: true,
    extracted_note_id: 'note-ready',
    transcript_chars: 320,
  });

  const selected = selectTranscriptPreparationTargets([
    [oldPending, ready, emptyPersisted],
    [newPending, oldPending],
  ]);

  assert.deepEqual(selected.map((entry) => entry.aweme_id), [
    'old-pending',
    'empty-persisted',
    'new-pending',
  ]);
});

test('skips unavailable videos and respects the batch limit', () => {
  const selected = selectTranscriptPreparationTargets([
    [
      item('unavailable', { can_extract: false }),
      item('first'),
      item('second'),
    ],
  ], 1);

  assert.deepEqual(selected.map((entry) => entry.aweme_id), ['first']);
});

test('uses source rank for the synchronized scope instead of the current display order', () => {
  const scoped = selectSyncedSourceScope([
    item('published-newest', { source_rank: 8 }),
    item('just-liked', { source_rank: 0 }),
    item('liked-second', { source_rank: 1 }),
  ], 2);

  assert.deepEqual(scoped.map((entry) => entry.aweme_id), [
    'just-liked',
    'liked-second',
  ]);
});

test('最新同步范围不会被旧快照的更小rank打乱', () => {
  const scoped = selectSyncedSourceScope([
    item('old-first', { source_rank: 0, source_synced_at: '2026-09-07T00:00:00Z' }),
    item('new-second', { source_rank: 1, source_synced_at: '2026-09-08T00:00:00Z' }),
    item('new-first', { source_rank: 0, source_synced_at: '2026-09-08T00:00:00Z' }),
  ], 2);
  assert.deepEqual(scoped.map((entry) => entry.aweme_id), ['new-first', 'new-second']);
});

test('自动准备只接收明确新增 ID，重复和旧接口缺失 ID 不会处理历史欠账', () => {
  const items = [item('old-pending'), item('new-pending')];
  assert.deepEqual(selectAutomaticTranscriptPreparationTargets([{ items, createdVideoIds: [] }]), []);
  assert.deepEqual(selectAutomaticTranscriptPreparationTargets([{ items }]), []);
  assert.deepEqual(selectAutomaticTranscriptPreparationTargets([
    { items, createdVideoIds: ['new-pending'] },
  ]).map((entry) => entry.aweme_id), ['new-pending']);
});

test('跨来源重复新增 ID 只提交一次，任一来源已有文稿就不再排队', () => {
  const selected = selectAutomaticTranscriptPreparationTargets([
    { items: [item('new'), item('ready')], createdVideoIds: ['new', 'ready'] },
    { items: [item('new'), item('ready', { extracted_note_id: 'note', transcript_chars: 200 })], createdVideoIds: ['new'] },
  ]);
  assert.deepEqual(selected.map((entry) => entry.aweme_id), ['new']);
});

test('重复同步补齐本轮范围的未完成文稿，不重复处理已完成或范围外历史视频', () => {
  const selected = selectAutomaticTranscriptPreparationTargets([{
    items: [item('pending'), item('ready', { extracted_note_id: 'note', transcript_chars: 200 }), item('outside')],
    createdVideoIds: [],
    syncedVideoIds: ['pending', 'ready'],
  }]);
  assert.deepEqual(selected.map((entry) => entry.aweme_id), ['pending']);
});

// 执行真实页面的目标选择、按钮动作及 extractItems，网络边界使用隔离夹具。
const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
const pendingSelection = page.slice(page.indexOf('  const pendingTranscriptItems = useMemo('),
  page.indexOf('  const selectedAnalysisNoteIds = useMemo('));
const extractAction = page.slice(page.indexOf('  const extractItems = async ('),
  page.indexOf('  const extractStructuredSelected = async'));
const prepareAction = page.slice(page.indexOf('  const preparePendingTranscripts = async'),
  page.indexOf('  const deleteExtraction = async'));
const prepareCode = ts.transpileModule(`${pendingSelection}\n${extractAction}\n${prepareAction}\nexports.run = preparePendingTranscripts;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function batchJob(ids: string[], status: DouyinBatchExtractionJob['status'] = 'success'): DouyinBatchExtractionJob {
  const success = status === 'success' ? ids.length : status === 'partial' ? 1 : 0;
  return {
    job_id: `job-${ids[0]}`, operation: 'transcript', status, created_at: '', started_at: '',
    concurrency: { asr: 4, llm: 2 }, total: ids.length, success,
    failed: status === 'failed' || status === 'partial' ? ids.length - success : 0,
    active: 0, queued: status === 'running' ? ids.length : 0, database_stores_media: false,
    items: ids.map((aweme_id, index) => ({ aweme_id,
      state: index < success ? 'done' : status === 'running' ? 'queued' : 'error',
      error: '', updated_at: '', already_existed: false, ai_initialized: false,
      note_id: index < success ? `note-${aweme_id}` : null, transcript_chars: index < success ? 100 : 0,
    })),
  };
}

function preparationHarness(items: DouyinLibraryItem[], resultStatus: DouyinBatchExtractionJob['status'] = 'success') {
  const submitted: string[][] = [];
  const notices: string[] = [];
  let collects = 0;
  const noOp = () => {};
  const context = {
    exports: {} as { run: () => Promise<void> }, items,
    // 搜索只影响展示，按钮处理当前完整分类；不能用 filteredItems 替换来源资料。
    filteredItems: items.slice(0, 1), search: '只显示第一条', selected: new Set(),
    useMemo: (factory: () => unknown) => factory(), selectTranscriptPreparationTargets,
    user: { id: 'user-a' }, currentUserIdRef: { current: 'user-a' }, activeRef: { current: true },
    sourceMode: 'collect', sourceModeRef: { current: 'collect' }, sourceLabel: '收藏',
    extractionUserEpochRef: { current: 1 }, extractionQueueRef: { current: null as LibraryExtractionBatchTracker | null },
    extractionNoticeRef: { current: noOp as (message: string) => void }, batchExtractingRef: { current: false },
    sourceSyncRunRef: { current: null as { cancelled: boolean } | null }, refreshing: false,
    desktopLocalDouyin: true,
    syncCollectionRef: { current: async () => { collects += 1; throw new Error('准备文案不得同步来源'); } },
    window: { setTimeout, clearTimeout, zhicuiDesktop: {
      collectPlatformAccount: async () => { collects += 1; throw new Error('不得打开抖音采集'); },
    } }, AbortController,
    LibraryExtractionBatchTracker, runReservedExtractionBatches,
    setNotice: (message: string) => notices.push(message), setPipelineStage: noOp,
    setBatchExtracting: noOp, setActiveBatchOperation: noOp, applyExtractionJob: noOp,
    formatTranscriptPreparationProgress: () => '文案准备中',
    startDouyinBatchExtraction: async (ids: string[], operation: string) => {
      assert.equal(operation, 'transcript');
      assert.ok(ids.length <= 100);
      submitted.push([...ids]);
      return { success: true, data: batchJob(ids, 'running') };
    },
    waitForExtractionJob: async (initial: DouyinBatchExtractionJob) => batchJob(initial.items.map((value) => value.aweme_id), resultStatus),
  };
  vm.runInNewContext(prepareCode, context);
  return { context, submitted, notices, collects: () => collects, run: () => context.exports.run() };
}

test('真实准备按钮：前21条已完成、后29条待处理，精确提交后29条且不读取顶部29条', async () => {
  const items = Array.from({ length: 50 }, (_, index) => item(String(index), index < 21
    ? { extracted_note_id: `ready-${index}`, transcript_chars: 100 } : {}));
  const h = preparationHarness(items);
  await h.run();
  assert.deepEqual(h.submitted, [items.slice(21).map((value) => value.aweme_id)]);
  assert.equal(h.collects(), 0);
  assert.equal(h.notices.at(-1), '29 条视频文案已就绪');
});

test('真实准备按钮：搜索/选择不截断当前分类，超过100条分块全部提交并排除已完成/不可用/重复项', async () => {
  const pending = Array.from({ length: 205 }, (_, index) => item(String(index)));
  const h = preparationHarness([...pending, item('0'), item('ready', {
    extracted_note_id: 'ready-note', transcript_chars: 100,
  }), item('unavailable', { can_extract: false })]);
  await h.run();
  assert.deepEqual(h.submitted.map((ids) => ids.length), [100, 100, 5]);
  assert.deepEqual(h.submitted.flat(), pending.map((value) => value.aweme_id));
  assert.equal(h.collects(), 0);
  assert.equal(h.notices.at(-1), '205 条视频文案已就绪');
});

for (const blocked of ['extracting', 'syncing', 'cancelled-sync']) {
  test(`真实准备按钮：${blocked} 阶段不重复提交或越过取消中的同步`, async () => {
    const h = preparationHarness([item('pending')]);
    if (blocked === 'extracting') h.context.batchExtractingRef.current = true;
    if (blocked === 'syncing') h.context.refreshing = true;
    if (blocked === 'cancelled-sync') h.context.sourceSyncRunRef.current = { cancelled: true };
    await h.run();
    assert.deepEqual(h.submitted, []);
    assert.equal(h.collects(), 0);
  });
}

for (const status of ['partial', 'failed', 'running'] as const) {
  test(`真实准备按钮：${status} 如实保留进度或给出重试方式，不宣称全部完成`, async () => {
    const h = preparationHarness([item('a'), item('b')], status);
    await h.run();
    assert.doesNotMatch(h.notices.at(-1) || '', /文案已就绪|全部完成/);
    assert.match(h.notices.at(-1) || '', status === 'running' ? /仍在后台准备/ : /重新同步收藏.*单条解析/);
  });
}

for (const changed of ['user', 'source', 'unmount'] as const) {
  test(`真实准备按钮：${changed} 后迟到完成不覆盖当前页面提示`, async () => {
    const h = preparationHarness([item('pending')]);
    h.context.waitForExtractionJob = async (initial) => {
      if (changed === 'user') {
        h.context.currentUserIdRef.current = 'user-b';
        h.context.extractionUserEpochRef.current += 1;
      }
      if (changed === 'source') h.context.sourceModeRef.current = 'like';
      if (changed === 'unmount') h.context.activeRef.current = false;
      return batchJob(initial.items.map((value) => value.aweme_id));
    };
    await h.run();
    assert.ok(!h.notices.some((message) => /文案已就绪/.test(message)));
  });
}
