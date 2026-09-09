import assert from 'node:assert/strict';
import test from 'node:test';
import type { DouyinLibraryListResult } from './types';
import {
  readLibraryListCache,
  readPlatformLibraryCache,
  writeLibraryListCache,
  writePlatformLibraryCache,
} from './libraryListCache.ts';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const result: DouyinLibraryListResult = {
  items: [],
  total: 0,
  source_total: 0,
  hidden: { temporary: 0, permanent: 0 },
  permanent_hidden_total: 0,
};

test('keeps a fresh per-user library list in session storage', () => {
  Object.assign(globalThis, {
    window: { sessionStorage: new MemoryStorage() },
  });
  writeLibraryListCache('user-a', 'collect', 'collection', result, 1_000);
  assert.deepEqual(
    readLibraryListCache('user-a', 'collect', 'collection', 2_000),
    result,
  );
  assert.equal(readLibraryListCache('user-b', 'collect', 'collection', 2_000), null);
});

test('drops an expired library list cache', () => {
  Object.assign(globalThis, {
    window: { sessionStorage: new MemoryStorage() },
  });
  writeLibraryListCache('user-a', 'like', 'collection', result, 1_000);
  assert.equal(
    readLibraryListCache('user-a', 'like', 'collection', 31 * 60 * 1_000),
    null,
  );
});

test('收藏台账校准后不读取旧 v4 快照，后续仅写入 v5 且平台缓存版本不变', () => {
  const storage = new MemoryStorage();
  Object.assign(globalThis, { window: { sessionStorage: storage } });
  storage.setItem('zhicui-library-list-v4:user-a:collect:collection', JSON.stringify({ savedAt: 1_000, result }));
  assert.equal(readLibraryListCache('user-a', 'collect', 'collection', 2_000), null);
  writeLibraryListCache('user-a', 'collect', 'collection', result, 2_000);
  assert.ok(storage.getItem('zhicui-library-list-v5:user-a:collect:collection'));
  assert.deepEqual(readLibraryListCache('user-a', 'collect', 'collection', 2_001), result);
  storage.setItem('zhicui-platform-library-list-v2:user-a', JSON.stringify({ savedAt: 1_000, items: [{ id: 'bili' }] }));
  assert.deepEqual(readPlatformLibraryCache('user-a', 2_000), [{ id: 'bili' }]);
});

test('keeps cross-platform items isolated by user', () => {
  Object.assign(globalThis, {
    window: { sessionStorage: new MemoryStorage() },
  });
  const items = [{ id: 'note-1', platform: 'bilibili' }] as never[];
  writePlatformLibraryCache('user-a', items, 1_000);
  assert.deepEqual(readPlatformLibraryCache('user-a', 2_000), items);
  assert.equal(readPlatformLibraryCache('user-b', 2_000), null);
});
