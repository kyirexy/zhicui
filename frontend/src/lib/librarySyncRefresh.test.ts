import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { mergeSyncedItems } from './libraryIncrementalSync.ts';
import { findNewLibraryItems } from './librarySyncDiff.ts';
import { capturePlatformSyncSnapshot } from './platformSyncSnapshot.ts';

type Item = { aweme_id: string; title: string };
type Result = { refreshed: Item[] | null; overview: { items: Item[]; total: number } | null; newlyVisible: Item[]; error: string };

// 执行真实单来源同步函数，模拟本机采集期间其他入口隐藏资料后的完整列表。
const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('  const collectOneSource = async'), page.indexOf('  const syncCollection = async'));
const code = ts.transpileModule(`${source}\nexports.run = collectOneSource;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(desktop: boolean, refreshed: Item[], refreshSucceeds = true) {
  const previous = Array.from({ length: 100 }, (_, index) => ({ aweme_id: `saved-${index}`, title: `旧资料 ${index}` }));
  let reads = 0;
  let ingests = 0;
  const job = { job_id: 'sync', status: 'success', success: 1, total: 1 };
  const noOp = () => {};
  const context = {
    exports: {} as { run: (mode: string, count: number, report: (message: string) => void, current: () => boolean) => Promise<Result> },
    user: { id: 'user-a', agent_profile_key: 'profile-a' }, currentUserIdRef: { current: 'user-a' },
    SOURCE_MODES: [{ value: 'collect', label: '收藏' }, { value: 'like', label: '喜欢' }, { value: 'post', label: '作品' }],
    sourceSorts: { collect: 'collection', like: 'collection' }, batchExtractingRef: { current: false },
    desktopLocalDouyin: desktop, desktopVersion: '1.1.4', ALL_LIBRARY_ITEMS: 0,
    setCollectionJob: noOp, setSourceReadability: noOp, persistDesktopDouyinConnection: noOp,
    mergeSyncedItems, findNewLibraryItems, capturePlatformSyncSnapshot,
    toLocalDouyinSyncItems: (items: unknown[]) => items,
    getLibraryRevision: () => 3, hasDouyinSyncFailureDiagnostic: () => false,
    nonNegativeInteger: (value: number) => Math.max(0, value || 0), formatCollectionSyncMessage: () => '已同步',
    listDouyinLibraryItems: async (limit: number) => {
      assert.equal(limit, 0, '完整列表必须保持无限条数请求');
      reads += 1;
      const items = reads === 1 ? previous : refreshed;
      return { success: reads === 1 || refreshSucceeds, data: { items, total: items.length, source_total: items.length } };
    },
    window: { zhicuiDesktop: { collectPlatformAccount: async () => ({
      success: true, items: [{ videoId: 'new' }], coverage: 'limited', orderReliable: true,
    }) } },
    ingestLocalDouyinLibrary: async () => {
      ingests += 1;
      return { success: true, data: { accepted: 1, ready: 0, quarantined: 0, created: 1, reused: 0, created_video_ids: ['new'], video_ids: ['new'] } };
    },
    collectDouyinLibrary: async () => ({ success: true, data: job }),
    waitForCollectionJob: async () => ({ job, error: '' }),
  };
  vm.runInNewContext(code, context);
  return { context, previous, ingests: () => ingests, run: (mode = 'collect') => context.exports.run(mode, 50, noOp, () => true) };
}

for (const desktop of [true, false]) {
  const entry = desktop ? '本机同步' : '兼容同步';
  for (const mode of ['collect', 'like', 'post']) {
    test(`${entry}/${mode}：完整刷新保留服务器历史尾部，但不会复活采集期间隐藏的旧资料`, async () => {
      const retained = Array.from({ length: 99 }, (_, index) => ({ aweme_id: `saved-${index + 1}`, title: `旧资料 ${index + 1}` }));
      const authoritative = [{ aweme_id: 'new', title: '新增' }, ...retained];
      const h = harness(desktop, authoritative);
      const result = await h.run(mode);
      assert.equal(result.error, '');
      assert.deepEqual(result.refreshed?.map((item) => item.aweme_id), authoritative.map((item) => item.aweme_id));
      assert.equal(result.refreshed?.some((item) => item.aweme_id === 'saved-0'), false);
      assert.equal(result.overview?.items.length, result.overview?.total);
      assert.deepEqual(result.newlyVisible.map((item) => item.aweme_id), ['new']);
      assert.equal(h.previous.length, 100, '基线仅用于比较新增，不得被修改');
    });
  }

  test(`${entry}：权威刷新返回空列表时，不用同步前快照填回全部历史资料`, async () => {
    const result = await harness(desktop, []).run();
    assert.deepEqual(result.refreshed, []);
    assert.equal(result.overview?.total, 0);
  });

  test(`${entry}：刷新失败明确返回失败，不能将旧列表伪装成同步后的结果`, async () => {
    const result = await harness(desktop, [], false).run();
    assert.equal(result.refreshed, null);
    assert.equal(result.overview, null);
    assert.match(result.error, /刷新/);
  });
}

test('本机采集期间切换账号后不登记旧账号的资料', async () => {
  const h = harness(true, []);
  h.context.window.zhicuiDesktop.collectPlatformAccount = async () => {
    h.context.currentUserIdRef.current = 'user-b';
    return { success: true, items: [{ videoId: 'old-user-video' }], coverage: 'limited', orderReliable: true };
  };
  await assert.rejects(h.run(), /账号已切换/);
  assert.equal(h.ingests(), 0);
});
