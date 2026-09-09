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

test('不可靠或缺排名的新快照不能越过可靠历史，也不打乱无排名资料的服务端次序', () => {
  const records = [
    item('unknown-old', { source_synced_at: '2026-09-01T00:00:00Z' }),
    item('unreliable-new', {
      source_ranks: { collect: 0 }, source_order_reliabilities: { collect: false },
      source_synced_ats: { collect: '2026-09-10T00:00:00Z' },
    }),
    item('ranked-old', { source_rank: 0, source_synced_at: '2026-09-02T00:00:00Z' }),
    item('missing-new', { source_synced_at: '2026-09-11T00:00:00Z' }),
    item('ranked-new', { source_rank: 1, source_synced_at: '2026-09-03T00:00:00Z' }),
    item('invalid-new', { source_rank: NaN, source_synced_at: '2026-09-12T00:00:00Z' }),
    item('fraction-new', { source_rank: 0.5, source_synced_at: '2026-09-13T00:00:00Z' }),
  ];
  assert.deepEqual(sortPlatformLibrarySource(records, 'collect').map((entry) => entry.id), [
    'ranked-new', 'ranked-old', 'unknown-old', 'unreliable-new', 'missing-new', 'invalid-new', 'fraction-new',
  ]);
  assert.equal(records[0].id, 'unknown-old');
});

test('收藏可靠性只由收藏字段决定，喜欢的可靠rank不能让收藏无排名项提前', () => {
  const records = [
    item('reliable-like', {
      source_mode: 'like', source_modes: ['collect', 'like'],
      source_rank: 0, source_order_reliable: true, source_synced_at: '2026-09-11T00:00:00Z',
      source_ranks: { like: 0 }, source_order_reliabilities: { collect: false, like: true },
    }),
    item('reliable-collect', {
      source_mode: 'like', source_modes: ['collect', 'like'],
      source_rank: 0, source_order_reliable: false, source_synced_at: '2026-09-12T00:00:00Z',
      source_ranks: { collect: 2 }, source_order_reliabilities: { collect: true, like: false },
      source_synced_ats: { collect: '2026-09-01T00:00:00Z' },
    }),
  ];
  assert.deepEqual(selectPlatformLibrarySource(records, 'collect').map((entry) => entry.id), ['reliable-collect', 'reliable-like']);
  assert.deepEqual(selectPlatformLibrarySource(records, 'like').map((entry) => entry.id), ['reliable-like', 'reliable-collect']);
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
