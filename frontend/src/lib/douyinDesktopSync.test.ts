import assert from 'node:assert/strict';
import test from 'node:test';

import {
  supportsLocalDouyinRuntime,
  toLocalDouyinSyncItems,
} from './douyinDesktopSync.ts';

test('local Douyin connector is gated to the compatible desktop version', () => {
  assert.equal(supportsLocalDouyinRuntime('1.0.6'), false);
  assert.equal(supportsLocalDouyinRuntime('1.0.7'), true);
  assert.equal(supportsLocalDouyinRuntime('1.1.0'), true);
  assert.equal(supportsLocalDouyinRuntime('2.0.0'), true);
});

test('desktop result is reduced to the public server metadata contract', () => {
  const mapped = toLocalDouyinSyncItems([{
    videoId: '7672579366093622537',
    sourceUrl: 'https://www.douyin.com/video/7672579366093622537',
    title: '标题',
    caption: '文案',
    authorName: '作者',
    coverUrl: 'https://p3.douyinpic.com/cover.jpg',
    publishedAt: '2026-08-27T08:00:00Z',
    durationSeconds: 20,
    sourceRank: 0,
  }]);

  assert.deepEqual(Object.keys(mapped[0]).sort(), [
    'author_name',
    'caption',
    'cover_url',
    'duration_seconds',
    'published_at',
    'source_rank',
    'source_url',
    'title',
    'video_id',
  ]);
  assert.equal(JSON.stringify(mapped).toLowerCase().includes('cookie'), false);
  assert.equal(JSON.stringify(mapped).toLowerCase().includes('media_url'), false);
});
