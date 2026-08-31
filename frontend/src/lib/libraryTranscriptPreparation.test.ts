import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasReadyTranscript,
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
