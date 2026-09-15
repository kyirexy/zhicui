import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  librarySyncSelectionPath, publishLibrarySyncSelection, readLibrarySyncSelections,
  subscribeLibrarySyncSelections, type LibrarySyncSelection,
} from './librarySyncSelection.ts';

function fakeWindow(blocked = false) {
  const entries = new Map<string, string>();
  const target = new EventTarget();
  Object.assign(target, { sessionStorage: {
    getItem: (key: string) => { if (blocked) throw new Error('blocked'); return entries.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (blocked) throw new Error('blocked'); entries.set(key, value); },
  } });
  return target;
}

function withWindow(run: (target: EventTarget) => void, blocked = false) {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = fakeWindow(blocked);
  Object.defineProperty(globalThis, 'window', { value: target, configurable: true });
  try { run(target); } finally {
    if (old) Object.defineProperty(globalThis, 'window', old); else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('同步开始立即广播分类，跨页面恢复且抖音/B站互不覆盖', () => withWindow(() => {
  const received: LibrarySyncSelection[] = [];
  const stop = subscribeLibrarySyncSelections('owner-1', (value) => received.push(value));
  publishLibrarySyncSelection('owner-1', 'douyin', 'like');
  assert.equal(received.at(-1)?.mode, 'like');
  publishLibrarySyncSelection('owner-1', 'bilibili', 'collect');
  assert.deepEqual(readLibrarySyncSelections('owner-1'), { douyin: 'like', bilibili: 'collect' });
  stop();
  publishLibrarySyncSelection('owner-1', 'douyin', 'post');
  assert.equal(received.length, 2, '卸载后的页面不处理迟到事件');
}));

test('账号切换、缺失账号及不支持的分类不会污染当前视图', () => withWindow((target) => {
  const received: LibrarySyncSelection[] = [];
  const stop = subscribeLibrarySyncSelections('owner-2', (value) => received.push(value));
  publishLibrarySyncSelection('other-2', 'douyin', 'like');
  publishLibrarySyncSelection(undefined, 'douyin', 'collect');
  publishLibrarySyncSelection('owner-2', 'bilibili', 'post');
  publishLibrarySyncSelection('owner-2', 'xiaohongshu', 'collect');
  target.dispatchEvent(new CustomEvent('zhicui:library-sync-selection', { detail: { userId: 'owner-2', platform: 'douyin', mode: 'all' } }));
  assert.deepEqual(received, []);
  assert.deepEqual(readLibrarySyncSelections('owner-2'), {});
  assert.deepEqual(readLibrarySyncSelections('other-2'), { douyin: 'like' });
  stop();
}));

test('sessionStorage不可用仍同步切换并在当前页面会话恢复', () => withWindow(() => {
  let received = false;
  const stop = subscribeLibrarySyncSelections('owner-3', () => { received = true; });
  publishLibrarySyncSelection('owner-3', 'douyin', 'collect');
  assert.equal(received, true);
  assert.deepEqual(readLibrarySyncSelections('owner-3'), { douyin: 'collect' });
  stop();
}, true));

test('分类URL替换平台和来源并保留其他参数及hash', () => {
  assert.equal(librarySyncSelectionPath('https://luxai.cn/library?platform=douyin&mode=post&keep=1#videos', {
    userId: 'owner', platform: 'bilibili', mode: 'collect',
  }), '/library?platform=bilibili&mode=collect&keep=1#videos');
});

const page = readFileSync(new URL('../app/library/page.tsx', import.meta.url), 'utf8').replace(/\r/g, '');
const compile = (source: string) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test('首页入口即使历史设置为直接同步作品、已登录或尚在读列表，也只打开选择框', () => {
  const open = page.slice(page.indexOf('  const openSourceManager ='), page.indexOf('  useEffect(() => {\n    if (quickSyncCheckedRef.current'));
  const entry = page.slice(page.indexOf('  useEffect(() => {\n    if (!quickSyncRequested'), page.indexOf('  const closeSourceManager ='));
  assert.ok(open && entry);
  for (const configured of [true, false]) for (const loading of [true, false]) {
    let opened = 0, started = 0;
    const selected: unknown[] = [];
    const context = {
      useEffect: (fn: () => void) => fn(), quickSyncRequested: true, loading, user: { id: 'owner' },
      refreshing: false, connected: true, loggedIn: true, platformFilter: 'all',
      sourceManagerDialogRef: { current: { open: false, showModal: () => { opened++; } } },
      sourceManagerRailRef: { current: null }, sourceManagerRestoreFocusRef: { current: false }, sourceManagerTabsRef: { current: null },
      setSourceManagerOpen: () => {}, setSourceManagerView: () => {}, setQuickSyncRequested: () => {},
      readLibraryQuickSyncPreferences: () => ({ configured, modes: ['post'], count: 100 }),
      setSourceManagerModes: (modes: unknown) => selected.push(modes), setSyncCount: () => {},
      syncCollectionRef: { current: () => { started++; } },
      window: { requestAnimationFrame: (fn: () => void) => fn() },
    };
    vm.runInNewContext(compile(open + entry), context);
    assert.equal(opened, 1); assert.equal(started, 0);
    assert.deepEqual(selected, [['post']], '历史范围只能用于选择框预填，不能代替本次确认');
  }
});

test('实际资料页分类事件同步更改URL与ref，并发文稿运行期间仍可切换，旧账号事件被拒绝', () => {
  const source = page.slice(page.indexOf('  const applySyncSelection ='), page.indexOf('  const initializePlatformSummary ='));
  const views: string[] = [];
  const modes: string[] = [];
  const paths: string[] = [];
  const state = { preserve: true };
  const context = {
    exports: {} as { apply: (value: LibrarySyncSelection) => void },
    useCallback: (fn: unknown) => fn, useEffect: () => {}, user: { id: 'owner' },
    activeRef: { current: true }, currentUserIdRef: { current: 'owner' }, batchExtractingRef: { current: true },
    sourceModeRef: { current: 'post' }, libraryRequestRef: { current: 1 },
    setPlatformFilter: (value: string) => views.push(value), setSourceMode: (value: string) => modes.push(value), setBiliSourceMode: (value: string) => modes.push(value),
    setSelected: () => {}, setSelectedPlatform: () => {}, setPreviewTarget: () => {}, setPlatformActionErrors: () => {},
    librarySyncSelectionPath, window: { location: { href: 'https://luxai.cn/library?mode=post' }, history: {
      state, replaceState: (next: unknown, _title: string, path: string) => { assert.equal(next, state); paths.push(path); },
    } },
  };
  vm.runInNewContext(compile(source + '\nexports.apply = applySyncSelection;'), context);
  context.exports.apply({ userId: 'owner', platform: 'douyin', mode: 'collect' });
  assert.equal(context.sourceModeRef.current, 'collect'); assert.equal(context.libraryRequestRef.current, 2);
  context.exports.apply({ userId: 'owner', platform: 'bilibili', mode: 'like' });
  context.exports.apply({ userId: 'other', platform: 'douyin', mode: 'post' });
  assert.deepEqual(views, ['douyin', 'bilibili']); assert.deepEqual(modes, ['collect', 'like']);
  assert.deepEqual(paths, ['/library?mode=collect&platform=douyin', '/library?mode=like&platform=bilibili']);
});

test('B站真实采集入口在等待官网前即发布当前来源，已有任务仍先恢复不重复采集', () => {
  const panel = readFileSync(new URL('../components/PlatformLibraryPanel.tsx', import.meta.url), 'utf8');
  const source = panel.slice(panel.indexOf('  const syncAccount = async'), panel.indexOf('  const retryBilibiliSync ='));
  assert.match(source, /if \(!stillCurrent\(\)\) return;\s*publishLibrarySyncSelection\(requestedUserId, platform, mode\);[\s\S]*?await bridge.collectPlatformAccount/);
  assert.ok(source.indexOf('hasUnresolvedBilibiliSource') < source.indexOf('publishLibrarySyncSelection'));
  const settings = readFileSync(new URL('../components/QuickSyncSettingsCard.tsx', import.meta.url), 'utf8');
  assert.match(settings, /每次同步前仍会打开选择框确认/);
  assert.doesNotMatch(settings, /会直接执行|保存并启用/);
});

test('执行B站真实同步函数：收藏/喜欢均在采集Promise完成前切分类，拒绝重复提交不改变已有任务', async () => {
  const panel = readFileSync(new URL('../components/PlatformLibraryPanel.tsx', import.meta.url), 'utf8');
  const source = panel.slice(panel.indexOf('  const syncAccount = async'), panel.indexOf('  const retryBilibiliSync ='));
  for (const mode of ['collect', 'like']) for (const unresolved of [false, true]) {
    const selections: string[] = [];
    let captures = 0, recovered = 0;
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finish = resolve; });
    const noOp = () => {};
    const context = {
      exports: {} as { run: (platform: string, modes: string[]) => Promise<void> },
      window: { zhicuiDesktop: { collectPlatformAccount: () => { captures++; return pending; } } },
      accountBridgeAvailable: true, user: { id: 'owner', agent_profile_key: 'profile' }, accountAction: '',
      resultsRef: { current: [] }, jobRefreshRef: { current: 0 }, mountedRef: { current: true }, currentUserIdRef: { current: 'owner' },
      hasUnresolvedBilibiliSource: () => unresolved, refreshImportResults: async () => { recovered++; },
      setFeedbackView: noOp, setAccountAction: noOp, setResults: noOp, setRefreshingResults: noOp, setError: noOp,
      readLibraryQuickSyncPreferences: () => ({ count: 50 }), updateAccountConnection: noOp,
      capturePlatformSyncSnapshot: () => ({}), accountConnections: { bilibili: { connected: true } },
      publishLibrarySyncSelection: (owner: string, platform: string, next: string) => {
        assert.equal(captures, 0); assert.equal(owner, 'owner'); assert.equal(platform, 'bilibili'); selections.push(next);
      },
    };
    vm.runInNewContext(compile(source + '\nexports.run = syncAccount;'), context);
    const job = context.exports.run('bilibili', [mode]);
    assert.deepEqual(selections, [mode], '恢复已有任务时也展示用户正在查看的来源');
    assert.equal(captures, unresolved ? 0 : 1);
    finish({ success: false, error: '官方列表未就绪' });
    await job;
    assert.equal(recovered, unresolved ? 1 : 0);
  }
});
