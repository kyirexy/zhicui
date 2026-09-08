import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { selectPlatformLibrarySource, sortPlatformLibrarySource } from './platformLibraryOrder.ts';
import type { PlatformLibraryItem } from './types.ts';

const item = (id: string, values: Partial<PlatformLibraryItem> = {}) => ({
  id, source_mode: 'collect', source_modes: ['collect'],
  published_at: '2026-09-08T00:00:00Z', ...values,
} as PlatformLibraryItem);

test('同一视频的收藏与喜欢排名互相独立，不能按发布时间重排', () => {
  const records = [
    item('first-like', { source_modes: ['collect', 'like'], source_ranks: { collect: 1, like: 0 } }),
    item('first-collect', {
      source_modes: ['collect', 'like'], source_ranks: { collect: 0, like: 1 },
      published_at: '2020-01-01T00:00:00Z',
    }),
  ];
  assert.deepEqual(selectPlatformLibrarySource(records, 'collect').map((entry) => entry.id), ['first-collect', 'first-like']);
  assert.deepEqual(selectPlatformLibrarySource(records, 'like').map((entry) => entry.id), ['first-like', 'first-collect']);
  assert.deepEqual(records.map((entry) => entry.id), ['first-like', 'first-collect']);
});

test('来源过滤不把普通导入、未知来源或者作品混进收藏/喜欢', () => {
  const records = [
    item('favorite'),
    item('liked', { source_mode: 'like', source_modes: ['like'] }),
    item('imported', { source_mode: 'import', source_modes: [] }),
    item('unknown', { source_mode: 'unknown', source_modes: [] }),
  ];
  assert.deepEqual(selectPlatformLibrarySource(records, 'collect').map((entry) => entry.id), ['favorite']);
  assert.deepEqual(selectPlatformLibrarySource(records, 'like').map((entry) => entry.id), ['liked']);
  assert.deepEqual(selectPlatformLibrarySource(records, 'import').map((entry) => entry.id), ['imported']);
});

test('旧资料缺排名时保持服务端次序，非法排名不会抢到前面', () => {
  const records = [item('old-1'), item('old-2'), item('bad', { source_rank: -1 }), item('ranked', { source_rank: 0 })];
  assert.deepEqual(sortPlatformLibrarySource(records, 'collect').map((entry) => entry.id), ['ranked', 'old-1', 'old-2', 'bad']);
});

test('新快照前缀先展示，旧快照rank0不能插进新快照rank1前面', () => {
  const records = [
    item('old-zero', { source_ranks: { collect: 0 }, source_synced_ats: { collect: '2026-09-07T01:00:00Z' } }),
    item('new-second', { source_ranks: { collect: 1 }, source_synced_ats: { collect: '2026-09-08T01:00:00Z' } }),
    item('new-first', { source_ranks: { collect: 0 }, source_synced_ats: { collect: '2026-09-08T09:00:00+08:00' } }),
  ];
  assert.deepEqual(selectPlatformLibrarySource(records, 'collect').map((entry) => entry.id), [
    'new-first', 'new-second', 'old-zero',
  ]);
});

test('收藏排序只使用收藏快照，喜欢更新更晚也不能顶替收藏快照', () => {
  const records = [
    item('recent-like', {
      source_mode: 'like', source_modes: ['collect', 'like'],
      source_synced_at: '2026-09-09T01:00:00Z',
      source_synced_ats: { collect: '2026-09-07T01:00:00Z', like: '2026-09-09T01:00:00Z' },
      source_ranks: { collect: 0, like: 0 },
    }),
    item('recent-collect', {
      source_synced_ats: { collect: '2026-09-08T01:00:00Z' }, source_ranks: { collect: 1 },
    }),
  ];
  assert.deepEqual(selectPlatformLibrarySource(records, 'collect').map((entry) => entry.id), ['recent-collect', 'recent-like']);
});

test('回到资料库恢复默认平台顺序，后台文案刷新使用最新排序且防止旧请求覆盖', () => {
  const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /useState\(DEFAULT_SOURCE_SORTS\)/);
  assert.doesNotMatch(page, /zhicui-library-source-sorts-v1/);
  assert.match(page, /sourceSortsRef\.current\[requestedMode\]/);
  assert.match(page, /requestId === libraryRequestRef\.current && requestedMode === sourceModeRef\.current/);
  assert.match(page, /selectPlatformLibrarySource\(platformItems, biliSourceMode\)/);
});
