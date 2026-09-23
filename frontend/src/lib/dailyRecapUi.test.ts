import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dailyProgress from './dailyRecapProgress.ts';

type Tree = { type: unknown; props: Record<string, unknown>; key?: string };
type Deferred = { resolve(value: unknown): void; reject(reason: unknown): void; signal?: AbortSignal };

const fixture = (title = '昨日教程') => {
  const item = { id: 'douyin:video-1', video_id: 'video-1', note_id: 'note-1', platform: 'douyin', title,
    author_name: '样例作者', cover_url: '', source_url: '', source_modes: ['like', 'collect'], first_seen_at: '2026-09-09T09:00:00Z',
    can_extract: true, transcript_ready: false, ai_initialized: false, initial_import: false };
  return { date: '2026-09-09', timezone: 'Asia/Shanghai', time_basis: 'first_discovered', time_basis_label: '按知萃首次同步记录',
    message: '', total: 1, like_count: 1, collect_count: 1, ready_count: 0, pending_count: 1, initial_import_count: 0,
    items: [item], preview: [item], ready_note_ids: [], has_more: false };
};

type HarnessOptions = {
  kind?: 'yesterday' | 'today';
  launchToken?: number;
  videoReady?: boolean;
  profileKey?: string;
};

function harness(options: HarnessOptions = {}) {
  let slots: unknown[] = [];
  let cursor = 0;
  let pending: (() => void)[] = [];
  let owner: string | undefined;
  let libraryRevision = 0;
  let refresh = () => {};
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  const runtime = { user: { id: 'user-a', agent_profile_key: options.profileKey || 'profile-a' } as { id: string; agent_profile_key?: string } | null };
  const requests: Deferred[] = [];
  const preparations: (Deferred & { userId: string; progress: (text: string) => void; kind?: string; options?: Record<string, unknown> })[] = [];
  const syncCalls: Record<string, unknown>[] = [];
  const navigations: string[] = [];
  const props = {
    kind: options.kind || 'yesterday',
    launchToken: options.launchToken || 0,
    videoActions: {
      ready: options.videoReady !== false,
      visible: () => true,
      busy: new Set<string>(),
      userId: 'user-a',
    },
    videoInteractions: {},
  } as Record<string, unknown>;
  const cleanup = () => { effects.forEach((value) => value.cleanup?.()); effects.clear(); slots = []; };
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => { previous?.cleanup?.(); const cleanup = setup(); effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }); });
    },
  };
  const jsx = (type: unknown, props: Tree['props'], key?: string): Tree => ({ type, props, key });
  const exports: { default?: (props: Record<string, unknown>) => Tree | null } = {};
  const source = readFileSync(new URL('../components/DailyRecap.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  runInNewContext(js, { exports, Error, AbortController, setInterval: () => 1, clearInterval() {},
    require(name: string) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'next/link') return 'a';
      if (name === 'next/navigation') return { useRouter: () => ({ push: (href: string) => navigations.push(href) }) };
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => 'icon' });
      if (name === '@/components/LibraryCoverImage') return 'img';
      if (name === '@/components/HomeVideoActions') return { HomeVideoActionCard: 'div' };
      if (name === '@/lib/hooks/useWebBuildActivity') return { useWebBuildActivity: () => {} };
      if (name === '@/lib/hooks/AuthContext') return { useAuth: () => runtime };
      if (name === '@/lib/dailyRecapApi') return {
        dailyRecapTimezone: () => 'Asia/Shanghai', dailyRecapDateLabel: () => '9 月 9 日',
        dailyRecapItemHref: (item: { video_id: string }) => `/library/detail?id=${item.video_id}`,
        getDailyRecap: (_: string, signal: AbortSignal) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })),
        getDailyAnalysis: (_: string, signal: AbortSignal) => new Promise((resolve, reject) => requests.push({ resolve, reject, signal })),
      };
      if (name === '@/lib/libraryUpdates') return {
        getLibraryRevision: () => libraryRevision, isLibraryRevisionCurrent: (value: number) => value === libraryRevision,
        subscribeLibraryUpdates: (handler: () => void) => { refresh = handler; return () => { refresh = () => {}; }; },
      };
      if (name === '@/lib/prepareDailyRecap') return {
        prepareDailyRecap: (_: unknown, progress: (text: string) => void, signal: AbortSignal, userId: string, kind: string, prepareOptions: Record<string, unknown>) =>
          new Promise((resolve, reject) => preparations.push({ resolve, reject, signal, progress, userId, kind, options: prepareOptions })),
      };
      if (name === '@/lib/syncDailyAnalysisSources') return {
        syncDailyAnalysisSources: (syncOptions: Record<string, unknown>) => {
          syncCalls.push(syncOptions);
          return Promise.resolve({ warnings: [] });
        },
      };
      if (name === '@/lib/refreshDailyRecapMedia') return { refreshDailyRecapMedia: async () => ({ warnings: [] }) };
      if (name === '@/lib/dailyRecapProgress') return dailyProgress;
      if (name.endsWith('.module.css')) return new Proxy({}, { get: (_, key) => String(key) });
      throw new Error(name);
    },
  });
  const render = () => {
    const wrapper = exports.default!(props);
    if (owner !== wrapper?.key) { cleanup(); owner = wrapper?.key; }
    if (!wrapper) return null;
    cursor = 0; pending = [];
    const tree = (wrapper.type as (props: Tree['props']) => Tree)(wrapper.props);
    pending.forEach((setup) => setup());
    return tree;
  };
  return { runtime, requests, preparations, syncCalls, navigations, props, render, close: cleanup,
    updateLibrary() { libraryRevision++; refresh(); },
  };
}

function nodes(tree: unknown): Tree[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as Tree;
  return [node, ...nodes(node.props?.children)];
}
function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree === null || tree === undefined || typeof tree === 'boolean') return '';
  if (typeof tree !== 'object') return String(tree);
  return text((tree as Tree).props?.children);
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const button = (tree: unknown, label: string) => nodes(tree).find((node) => node.type === 'button' && text(node).includes(label))!;

test('加载、真实空记录与读取错误分开显示，空记录不会伪造昨天点赞数', async () => {
  const page = harness();
  try {
    assert.match(text(page.render()), /正在读取昨日记录/);
    page.requests.shift()!.reject(new Error('网络暂不可用'));
    await settle();
    assert.match(text(page.render()), /网络暂不可用/);
    assert.doesNotMatch(text(page.render()), /昨天没有新同步记录/);
    (button(page.render(), '重新读取').props.onClick as () => void)();
    page.render();
    page.requests.shift()!.resolve({ ...fixture(), total: 0, like_count: 0, collect_count: 0, items: [], preview: [] });
    await settle();
    const tree = page.render();
    assert.match(text(tree), /昨天没有新同步记录/);
    assert.equal(nodes(tree).filter((node) => node.props.href === '/library?sync=1').length, 1);
    assert.ok(!button(tree, '分析昨天并进入 AI'));
  } finally { page.close(); }
});

test('同步更新后丢弃旧响应，切换账号立即撤销旧请求与旧内容', async () => {
  const page = harness();
  try {
    page.render();
    const old = page.requests.shift()!;
    page.updateLibrary();
    page.render();
    old.resolve(fixture('已失效的旧视频'));
    page.requests.shift()!.resolve(fixture('最新视频'));
    await settle();
    assert.match(text(page.render()), /最新视频/);
    assert.doesNotMatch(text(page.render()), /已失效的旧视频/);
    page.runtime.user = { id: 'user-b' };
    assert.doesNotMatch(text(page.render()), /最新视频/);
    assert.equal(old.signal?.aborted, true);
    page.requests.shift()!.resolve(fixture('新账号视频'));
    await settle();
    assert.match(text(page.render()), /新账号视频/);
  } finally { page.close(); }
});

test('一键解析只启动一次并传入当前账号，展示进度，后台刷新不清除失败信息', async () => {
  const page = harness();
  try {
    page.render();
    page.requests.shift()!.resolve(fixture());
    await settle();
    const click = button(page.render(), '分析昨天并进入 AI').props.onClick as () => void;
    click(); click();
    assert.equal(page.preparations.length, 1);
    assert.equal(page.preparations[0].userId, 'user-a');
    assert.equal(button(page.render(), '正在整理昨日回顾').props.disabled, true);
    page.preparations[0].progress('正在并发准备，已完成 2 条');
    assert.match(text(page.render()), /正在并发准备，已完成 2 条/);
    page.preparations[0].reject(new Error('服务暂时繁忙'));
    await settle();
    page.render();
    page.requests.shift()!.resolve(fixture());
    await settle();
    assert.match(text(page.render()), /服务暂时繁忙/);
    assert.ok(button(page.render(), '重试分析'));
  } finally { page.close(); }
});

test('离开或切换账号后不接收提取结果、不跳转到旧账号问答', async () => {
  const page = harness();
  try {
    page.render();
    page.requests.shift()!.resolve(fixture());
    await settle();
    (button(page.render(), '分析昨天并进入 AI').props.onClick as () => void)();
    page.runtime.user = null;
    assert.equal(page.render(), null);
    assert.equal(page.preparations[0].signal?.aborted, true);
    page.preparations[0].resolve({ href: '/harness?thread=old-user' });
    await settle();
    assert.deepEqual(page.navigations, []);
  } finally { page.close(); }
});

test('同一视频既喜欢又收藏只用服务端去重总数，首次导入明确说明', async () => {
  const page = harness();
  try {
    page.render();
    page.requests.shift()!.resolve({ ...fixture(), initial_import_count: 1 });
    await settle();
    const tree = page.render();
    assert.match(text(tree), /1 条视频/);
    assert.match(text(tree), /喜欢 1收藏 1/);
    assert.match(text(tree), /平台未提供实际点赞、收藏时间/);
    assert.match(text(tree), /1 条来自首次导入/);
  } finally { page.close(); }
});

test('超过单次处理范围及历史导入状态未知时，未展开列表也明确说明', async () => {
  const page = harness();
  try {
    page.render();
    const data = fixture();
    page.requests.shift()!.resolve({ ...data, total: 150, has_more: true, initial_import_unknown_count: 3,
      items: Array.from({ length: 100 }, (_, index) => ({ ...data.items[0], id: `douyin:${index}` })),
    });
    await settle();
    const tree = page.render();
    assert.match(text(tree), /本次解析当前 100 条/);
    assert.match(text(tree), /部分旧记录无法区分是否为首次历史导入/);
    assert.equal(button(tree, '查看列表').props['aria-expanded'], false);
  } finally { page.close(); }
});

test('今日分析不会在挂载时自动运行，点击首页入口后空记录也会启动同步回调', async () => {
  const page = harness({ kind: 'today' });
  try {
    page.render();
    page.requests.shift()!.resolve({ ...fixture('今天的新收藏'), date: '2026-09-21', total: 0, like_count: 0, collect_count: 0, items: [], preview: [] });
    await settle();
    page.render();
    assert.equal(page.preparations.length, 0);
    page.props.launchToken = 1;
    page.render();
    assert.equal(page.preparations.length, 1);
    assert.equal(page.preparations[0].kind, 'today');
    assert.equal(page.preparations[0].userId, 'user-a');
    const beforePrepare = page.preparations[0].options?.beforePrepare as (() => Promise<unknown>) | undefined;
    assert.equal(typeof beforePrepare, 'function');
    await beforePrepare!();
    assert.equal(page.syncCalls.length, 1);
    assert.equal(page.syncCalls[0].userId, 'user-a');
    assert.equal(page.syncCalls[0].profileKey, 'profile-a');
  } finally { page.close(); }
});

test('今日分析准备中重复点击只消费新 token，不排队第二次同步，完成后进入知萃 AI', async () => {
  const page = harness({ kind: 'today', launchToken: 1 });
  try {
    page.render();
    page.requests.shift()!.resolve({ ...fixture('今天的新收藏'), date: '2026-09-21', total: 0, like_count: 0, collect_count: 0, items: [], preview: [] });
    await settle();
    page.render();
    assert.equal(page.preparations.length, 1);
    page.props.launchToken = 2;
    page.render();
    assert.equal(page.preparations.length, 1);
    page.preparations[0].resolve({ href: '/harness?thread=today-summary' });
    await settle();
    assert.deepEqual(page.navigations, ['/harness?thread=today-summary']);
  } finally { page.close(); }
});

test('今日分析等待视频操作权限就绪后才启动，并在账号切换时不重放旧入口', async () => {
  const page = harness({ kind: 'today', launchToken: 1, videoReady: false });
  try {
    page.render();
    page.requests.shift()!.resolve({ ...fixture('今天的新收藏'), date: '2026-09-21', total: 0, like_count: 0, collect_count: 0, items: [], preview: [] });
    await settle();
    page.render();
    assert.equal(page.preparations.length, 0);
    (page.props.videoActions as { ready: boolean }).ready = true;
    page.render();
    assert.equal(page.preparations.length, 1);
    const oldSignal = page.preparations[0].signal;
    page.runtime.user = { id: 'user-b', agent_profile_key: 'profile-b' };
    page.props.launchToken = 0;
    page.render();
    assert.equal(oldSignal?.aborted, true);
    page.requests.shift()!.resolve({ ...fixture('新账号的今日记录'), date: '2026-09-21', total: 0, like_count: 0, collect_count: 0, items: [], preview: [] });
    await settle();
    page.render();
    assert.equal(page.preparations.length, 1);
  } finally { page.close(); }
});
