import assert from 'node:assert/strict';
import test from 'node:test';
import { featuredCreatorCount, featuredCreatorReadyCount, selectFeaturedCreator } from './homeCreatorSelection.ts';
import type { CreatorSource } from './types.ts';

function source(overrides: Partial<CreatorSource> = {}): CreatorSource {
  return {
    id: 'source-1', platform: 'douyin', creator_id: 'creator-1', profile_url: 'https://www.douyin.com/user/1',
    display_name: '示例博主', avatar_url: '', status: 'active', last_error_code: '', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

test('selects a real active creator by catalog size, not a video author', () => {
  const chosen = selectFeaturedCreator([
    source({ id: 'small', display_name: '较新但较少', catalog_counts: { total: 3, untranscribed: 0, imported: 3, failed: 0 }, last_success_at: '2026-09-22T00:00:00Z' }),
    source({ id: 'large', display_name: '代表性博主', catalog_counts: { total: 36, untranscribed: 2, imported: 34, failed: 0 }, last_success_at: '2026-09-10T00:00:00Z' }),
    source({ id: 'disabled', display_name: '不可用', status: 'disabled', catalog_counts: { total: 99, untranscribed: 0, imported: 99, failed: 0 } }),
  ]);
  assert.equal(chosen?.id, 'large');
  assert.equal(featuredCreatorCount(chosen!), 36);
  assert.equal(featuredCreatorReadyCount(chosen!), 34);
});

test('uses recent success and then name for deterministic ties', () => {
  const chosen = selectFeaturedCreator([
    source({ id: 'z', display_name: '乙', last_success_at: '2026-09-10T00:00:00Z' }),
    source({ id: 'a', display_name: '甲', last_success_at: '2026-09-10T00:00:00Z' }),
  ]);
  assert.equal(chosen?.id, 'a');
  assert.equal(selectFeaturedCreator([]), null);
});
