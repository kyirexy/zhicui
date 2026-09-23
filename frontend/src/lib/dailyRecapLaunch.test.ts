import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as dailyProgress from './dailyRecapProgress.ts';
import type { DailyRecap, DailyRecapItem } from './dailyRecapApi.ts';
import type { DailyRecapKind, DailyRecapPreparationOptions } from './prepareDailyRecap.ts';

type Tree = { type: unknown; props: Record<string, unknown> };
type Component = (props: Record<string, unknown>) => Tree;
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void };
type Effect = { deps: unknown[]; cleanup?: () => void };
type Instance = { slots: unknown[]; effects: Map<number, Effect> };
type Preparation = Deferred<{ href: string }> & {
  recap: DailyRecap; report: (message: string) => void; signal: AbortSignal;
  userId: string; kind: DailyRecapKind; options: DailyRecapPreparationOptions;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nodes(tree: unknown): Tree[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object' || !('props' in tree)) return [];
  const node = tree as Tree;
  return [node, ...nodes(node.props.children)];
}

function text(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' && 'props' in tree ? text((tree as Tree).props.children) : '';
}

// 真实父组件与两个回顾组件各有独立 hooks 状态，提交 Effect 后再渲染状态更新。
// 只替换网络、导航等边界，按钮处理、launchToken 消费、请求锁和状态回传都执行生产代码。
function harness() {
  const instances = new Map<string, Instance>();
  let active: Instance;
  let cursor = 0;
  let dirty = true;
  let pending: Array<() => void> = [];
  let home: Tree;
  const cards = new Map<DailyRecapKind, Tree>();
  const cardProps = new Map<DailyRecapKind, Record<string, unknown>>();
  const runtime = { user: { id: 'user-a', agent_profile_key: 'profile-a' } };
  const actions = {
    ready: true, preferences: new Map(), busy: new Set(),
    visible: (_item: DailyRecapItem) => true,
  };
  const reads: Array<Deferred<DailyRecap> & { kind: DailyRecapKind }> = [];
  const preparations: Preparation[] = [];
  const pushes: string[] = [];
  const syncCalls: Array<{ userId: string; profileKey: string; signal: AbortSignal }> = [];
  const mediaCalls: Array<{ items: DailyRecapItem[]; options: { userId: string; profileKey: string; signal: AbortSignal } }> = [];
  const read = (kind: DailyRecapKind) => {
    const request = { ...deferred<DailyRecap>(), kind };
    reads.push(request);
    return request.promise;
  };
  const react = {
    useState(initial: unknown) {
      const owner = active;
      const index = cursor++;
      if (!(index in owner.slots)) {
        const slot = {
          value: typeof initial === 'function' ? initial() : initial,
          set(value: unknown) {
            const next = typeof value === 'function' ? value(slot.value) : value;
            if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; }
          },
        };
        owner.slots[index] = slot;
      }
      const slot = owner.slots[index] as { value: unknown; set: (value: unknown) => void };
      return [slot.value, slot.set];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in active.slots)) active.slots[index] = { current: initial };
      return active.slots[index];
    },
    useMemo(compute: () => unknown) { return compute(); },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const owner = active;
      const index = cursor++;
      const previous = owner.effects.get(index);
      if (previous && previous.deps.length === deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = setup();
        owner.effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
      });
    },
  };
  const jsx = (type: unknown, props: Tree['props']): Tree => ({ type, props });
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const never = () => new Promise(() => {});
  let Recap: Component;
  function load(file: string): Component {
    const exports: { default?: Component } = {};
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    } }).outputText;
    runInNewContext(js, {
      exports, AbortController, Error, URLSearchParams, sessionStorage: storage,
      setInterval: () => 1, clearInterval() {},
      require(name: string) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
        if (name === 'next/link') return 'a';
        if (name === 'next/navigation') return { useRouter: () => ({ push: (href: string) => pushes.push(href) }) };
        if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => 'icon' });
        if (name === '@/lib/hooks/AuthContext') return { useAuth: () => runtime };
        if (name === '@/lib/hooks/useHomeVideoActions') return { useHomeVideoActions: () => actions };
        if (name === '@/lib/hooks/useWebBuildActivity') return { useWebBuildActivity() {} };
        if (name === '@/lib/api') return {
          listAgentThreads: never, listAgentSources: never,
          listDouyinLibraryItems: never, listPlatformLibraryItems: never,
        };
        if (name === '@/lib/libraryUpdates') return {
          getLibraryRevision: () => 0, isLibraryRevisionCurrent: () => true,
          subscribeLibraryUpdates: () => () => {},
        };
        if (name === '@/lib/librarySyncSelection') return {
          readLibrarySyncSelections: () => ({}), subscribeLibrarySyncSelections: () => () => {},
        };
        if (name === '@/lib/homeSourceClassification') return { firstPopulatedHomeMode: () => 'collect' };
        if (name === '@/lib/platformLibraryOrder') return { sortPlatformLibrarySource: (items: unknown) => items };
        if (name === '@/lib/singleLinkImport') return { buildHomeLinkDestination: () => '/library' };
        if (name === '@/components/LibraryCoverImage') return 'img';
        if (name === '@/components/DailyRecap') return { __esModule: true, default: Recap };
        if (name === '@/components/HomeVideoActions') return {
          HomeVideoActionCard: 'video-actions', HomeVideoActionsLayer: 'actions-layer',
          useHomeVideoInteractions: () => ({}),
        };
        if (name === '@/lib/dailyRecapApi') return {
          dailyRecapTimezone: () => 'Asia/Shanghai', dailyRecapDateLabel: () => '9 月 22 日',
          dailyRecapItemHref: (item: DailyRecapItem) => `/library/detail?id=${item.video_id}`,
          getDailyRecap: () => read('yesterday'), getDailyAnalysis: () => read('today'),
        };
        if (name === '@/lib/prepareDailyRecap') return {
          prepareDailyRecap(recap: DailyRecap, report: Preparation['report'], signal: AbortSignal,
            userId: string, kind: DailyRecapKind, options: DailyRecapPreparationOptions) {
            const operation = { ...deferred<{ href: string }>(), recap, report, signal, userId, kind, options };
            preparations.push(operation);
            return operation.promise;
          },
        };
        if (name === '@/lib/syncDailyAnalysisSources') return {
          syncDailyAnalysisSources(options: typeof syncCalls[number]) {
            syncCalls.push(options);
            return Promise.resolve({ warnings: [] });
          },
        };
        if (name === '@/lib/refreshDailyRecapMedia') return {
          refreshDailyRecapMedia(items: DailyRecapItem[], options: typeof mediaCalls[number]['options']) {
            mediaCalls.push({ items, options });
            return Promise.resolve({ warnings: [] });
          },
        };
        if (name === '@/lib/dailyRecapProgress') return dailyProgress;
        if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
        throw new Error(`未配置组件依赖：${name}`);
      },
    });
    return exports.default!;
  }
  Recap = load('DailyRecap.tsx');
  const Home = load('WorkspaceActionHome.tsx');
  const renderComponent = (key: string, component: Component, props: Record<string, unknown>) => {
    if (!instances.has(key)) instances.set(key, { slots: [], effects: new Map() });
    active = instances.get(key)!;
    cursor = 0;
    return component(props);
  };
  const render = () => {
    let cycles = 0;
    do {
      assert.ok(++cycles < 30, '组件状态应在有限次渲染内稳定');
      dirty = false;
      pending = [];
      home = renderComponent('home', Home, {});
      for (const node of nodes(home).filter((node) => node.type === Recap)) {
        const kind = node.props.kind as DailyRecapKind;
        cardProps.set(kind, node.props);
        const content = Recap(node.props);
        cards.set(kind, renderComponent(kind, content.type as Component, content.props));
      }
      pending.forEach((effect) => effect());
    } while (dirty);
    return home;
  };
  const topButton = (kind: DailyRecapKind) => {
    const buttons = nodes(home).filter((node) => node.type === 'button' && node.props.className === 'coreFeature');
    const button = buttons[kind === 'yesterday' ? 0 : 1];
    assert.ok(button, `${kind} 顶部入口应为可执行按钮`);
    return button;
  };
  return {
    render, actions, reads, preparations, pushes, syncCalls, mediaCalls, cards, cardProps, topButton,
    click(kind: DailyRecapKind) {
      const button = topButton(kind);
      assert.ok(!button.props.disabled, '运行时顶部按钮应禁止重复点击');
      (button.props.onClick as () => void)();
      render();
    },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); render(); },
    close() { instances.forEach((instance) => instance.effects.forEach((effect) => effect.cleanup?.())); },
  };
}

function recap(items: DailyRecapItem[] = [video()]): DailyRecap {
  return {
    date: '2026-09-22', timezone: 'Asia/Shanghai', time_basis: 'first_discovered',
    time_basis_label: '首次同步', message: '', total: items.length,
    like_count: items.length, collect_count: 0, ready_count: 0, pending_count: items.length,
    initial_import_count: 0, items, preview: items.slice(0, 3), has_more: false, ready_note_ids: [],
  };
}

function video(): DailyRecapItem {
  return {
    id: 'video-a', video_id: 'video-a', note_id: null, platform: 'douyin', title: '昨天喜欢的视频',
    cover_url: '', source_url: 'https://www.douyin.com/video/video-a', source_modes: ['like'],
    first_seen_at: '2026-09-22T08:00:00+08:00', can_extract: true, transcript_ready: false,
    ai_initialized: false, initial_import: false,
  };
}

test('点击真实首页昨日入口，自动准备尚未提取的喜欢并在完成后跳转 AI', async () => {
  const page = harness();
  try {
    page.render();
    page.reads.find((request) => request.kind === 'yesterday')!.resolve(recap());
    await page.settle();
    assert.match(text(page.topButton('yesterday')), /看看昨天干了什么/);
    page.click('yesterday');
    assert.equal(page.cardProps.get('yesterday')!.launchToken, 1);
    assert.equal(page.cardProps.get('today')!.launchToken, 0);
    assert.equal(page.preparations.length, 1);
    const operation = page.preparations[0];
    assert.equal(operation.kind, 'yesterday');
    assert.equal(operation.userId, 'user-a');
    assert.equal(operation.recap.items[0].transcript_ready, false);
    assert.equal(operation.options.beforePrepare, undefined);
    await operation.options.beforeExtract!(operation.recap.items);
    assert.equal(page.mediaCalls.length, 1);
    assert.equal(page.mediaCalls[0].items[0].video_id, 'video-a');
    assert.equal(page.mediaCalls[0].options.profileKey, 'profile-a');
    assert.equal(page.mediaCalls[0].options.signal, operation.signal);
    assert.equal(page.topButton('yesterday').props.disabled, true);
    operation.report('文稿已处理 1/2 · 成功 0 · 失败 1 · 处理中 1 · 排队 0');
    page.render();
    assert.match(text(page.topButton('yesterday')), /已处理 1\/2/);
    assert.equal(nodes(page.cards.get('yesterday')).find((node) => node.props.role === 'progressbar')!.props['aria-valuenow'], 50);
    assert.equal(page.pushes.length, 0);
    operation.resolve({ href: '/harness?thread=yesterday-thread' });
    await page.settle();
    assert.deepEqual(page.pushes, ['/harness?thread=yesterday-thread']);
    assert.equal(page.preparations.length, 1);
  } finally { page.close(); }
});

test('昨日点击等待记录与隐藏偏好加载完成，只消费同一次 launch 一次', async () => {
  const page = harness();
  try {
    page.actions.ready = false;
    page.render();
    page.click('yesterday');
    assert.equal(page.preparations.length, 0);
    page.reads.find((request) => request.kind === 'yesterday')!.resolve(recap());
    await page.settle();
    assert.equal(page.preparations.length, 0);
    page.actions.ready = true;
    page.render();
    assert.equal(page.preparations.length, 1);
    page.render();
    await page.settle();
    assert.equal(page.preparations.length, 1);
  } finally { page.close(); }
});

test('运行中的重复 launch 不排队，失败后用户再点击才重新准备', async () => {
  const page = harness();
  try {
    page.render();
    page.reads.find((request) => request.kind === 'yesterday')!.resolve(recap());
    await page.settle();
    const handler = page.topButton('yesterday').props.onClick as () => void;
    page.click('yesterday');
    // 模拟在按钮禁用前已发出的第二次事件，检验子组件的请求锁与 token 消费。
    handler();
    page.render();
    assert.equal(page.cardProps.get('yesterday')!.launchToken, 2);
    assert.equal(page.preparations.length, 1);
    page.preparations[0].reject(new Error('文稿提取暂未完成，请重试'));
    await page.settle();
    assert.match(text(page.topButton('yesterday')), /文稿提取暂未完成，请重试/);
    page.reads.filter((request) => request.kind === 'yesterday').at(-1)!.resolve(recap());
    await page.settle();
    assert.equal(page.preparations.length, 1, '失败和刷新都不得触发此前重复点击的排队任务');
    assert.equal(page.pushes.length, 0);
    page.click('yesterday');
    assert.equal(page.preparations.length, 2);
    page.preparations[1].resolve({ href: '/harness?thread=retried-thread' });
    await page.settle();
    assert.deepEqual(page.pushes, ['/harness?thread=retried-thread']);
  } finally { page.close(); }
});

test('昨日首次读取失败后，顶部一次点击重新读取并自动进入 AI', async () => {
  const page = harness();
  try {
    page.render();
    page.reads.find((request) => request.kind === 'yesterday')!.reject(new Error('昨日记录暂未读取'));
    await page.settle();
    page.click('yesterday');
    assert.equal(page.preparations.length, 0);
    const requests = page.reads.filter((request) => request.kind === 'yesterday');
    assert.equal(requests.length, 2);
    requests[1].resolve(recap());
    await page.settle();
    assert.equal(page.preparations.length, 1);
    page.preparations[0].resolve({ href: '/harness?thread=recovered-thread' });
    await page.settle();
    assert.deepEqual(page.pushes, ['/harness?thread=recovered-thread']);
  } finally { page.close(); }
});

for (const hidden of [false, true]) {
  test(hidden ? '昨日资料全部隐藏时顶部显示中文状态，不创建空 AI 会话' : '昨日无新资料时顶部显示中文状态，不静默下滑', async () => {
    const page = harness();
    try {
      if (hidden) page.actions.visible = () => false;
      page.render();
      page.reads.find((request) => request.kind === 'yesterday')!.resolve(recap(hidden ? [video()] : []));
      await page.settle();
      page.click('yesterday');
      await page.settle();
      assert.equal(page.preparations.length, 0);
      assert.equal(page.pushes.length, 0);
      assert.match(text(page.topButton('yesterday')), hidden ? /昨日资料已隐藏/ : /昨天没有新同步的喜欢或收藏/);
      assert.equal(page.topButton('yesterday').props.disabled, false);
    } finally { page.close(); }
  });
}

test('今日入口保留自动同步回调，即使暂无资料也会准备并进入 AI', async () => {
  const page = harness();
  try {
    page.render();
    page.reads.find((request) => request.kind === 'today')!.resolve(recap([]));
    await page.settle();
    page.click('today');
    assert.equal(page.preparations.length, 1);
    assert.equal(page.cardProps.get('yesterday')!.launchToken, 0);
    const operation = page.preparations[0];
    assert.equal(operation.kind, 'today');
    await operation.options.beforePrepare!();
    assert.equal(page.syncCalls.length, 1);
    assert.equal(page.syncCalls[0].userId, 'user-a');
    assert.equal(page.syncCalls[0].profileKey, 'profile-a');
    assert.equal(page.syncCalls[0].signal, operation.signal);
    operation.resolve({ href: '/harness?thread=today-thread' });
    await page.settle();
    assert.deepEqual(page.pushes, ['/harness?thread=today-thread']);
  } finally { page.close(); }
});
