import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasReadyTranscript,
  selectAutomaticTranscriptPreparationTargets,
  selectSyncedSourceScope,
  selectTranscriptPreparationTargets,
} from './libraryTranscriptPreparation.ts';
import type { DouyinLibraryItem } from './types.ts';

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
