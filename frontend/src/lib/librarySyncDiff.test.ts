import assert from 'node:assert/strict';
import test from 'node:test';

import { findNewLibraryItems } from './librarySyncDiff.ts';

test('切换到非当前来源同步时仍能识别新视频', () => {
  const previousIds = new Set(['old-like']);
  const refreshed = [
    { aweme_id: 'new-like' },
    { aweme_id: 'old-like' },
  ];
  assert.deepEqual(findNewLibraryItems(refreshed, previousIds), [{ aweme_id: 'new-like' }]);
});
