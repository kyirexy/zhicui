import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as classification from './homeSourceClassification.ts';
import * as updates from './libraryUpdates.ts';
import { sortPlatformLibrarySource } from './platformLibraryOrder.ts';

type Tree = { type: unknown; props: Record<string, unknown> };
type Request = { key: string; resolve: (result: unknown) => void };

// 执行真实首页组件及 Effect 清理，用可控制响应次序复现同步和账号切换竞态。
function harness() {
  const slots: unknown[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  let cursor = 0;
  let pending: (() => void)[] = [];
  const runtime = { user: { id: 'user-a' } as { id: string } | null };
  const requests: Request[] = [];
  const request = (key: string) => new Promise((resolve) => requests.push({ key, resolve }));
  const storage: Record<string, string | ((key: string, value?: string) => unknown)> = {};
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const window = Object.assign(browser, { sessionStorage: storage });
  const originals = ['window', 'document'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useMemo(compute: () => unknown) { return compute(); },
    useEffect(setup: () => void | (() => void), deps: unknown[]) {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
      pending.push(() => {
        previous?.cleanup?.();
        const cleanup = setup();
        effects.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
      });
    },
  };
  const jsx = (type: unknown, props: Tree['props']): Tree => ({ type, props });
  const exports: { default?: () => Tree } = {};
  const source = readFileSync(new URL('../components/WorkspaceActionHome.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  runInNewContext(js, { exports, window, document, sessionStorage: storage, URLSearchParams,
    require(name: string) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === 'next/link') return 'a';
      if (name === 'next/navigation') return { useRouter: () => ({ push() {} }) };
      if (name === '@phosphor-icons/react') return new Proxy({}, { get: () => 'icon' });
      if (name === '@/lib/hooks/AuthContext') return { useAuth: () => runtime };
      if (name === '@/lib/api') return {
        listAgentThreads: () => request('threads'), listAgentSources: () => request('sources'),
        listDouyinLibraryItems: (_: number, mode: string) => request(`douyin_${mode}`),
        listPlatformLibraryItems: (_: string, mode: string) => request(`bilibili_${mode}`),
      };
      if (name === '@/lib/libraryUpdates') return updates;
      if (name === '@/lib/homeSourceClassification') return classification;
      if (name === '@/lib/platformLibraryOrder') return { sortPlatformLibrarySource };
      if (name === '@/lib/singleLinkImport') return { buildHomeLinkDestination: () => '/library' };
      if (name === '@/components/LibraryCoverImage') return 'img';
      if (name === '@/components/DailyRecap') return 'daily-recap';
      if (name.endsWith('.module.css')) return {};
      throw new Error(name);
    },
  });
  const render = () => {
    cursor = 0; pending = [];
    const tree = exports.default!();
    pending.forEach((effect) => effect());
    return tree;
  };
  const hrefs = (tree: unknown): string[] => {
    if (Array.isArray(tree)) return tree.flatMap(hrefs);
    if (!tree || typeof tree !== 'object') return [];
    const props = (tree as Tree).props || {};
    return [...(typeof props.href === 'string' ? [props.href] : []), ...hrefs(props.children)];
  };
  return { runtime, requests, render, links: () => hrefs(render()), storage,
    close() {
      effects.forEach((effect) => effect.cleanup?.());
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const result = (id: string) => ({ success: true, data: {
  items: [{ aweme_id: id, title: id }], source_total: 1,
} });

test('真实首页忽略同步前旧响应，刷新失败保留其他分类，退出后旧账号不回填', async () => {
  const page = harness();
  try {
    page.render();
    const original = page.requests.splice(0);
    original.find((request) => request.key === 'douyin_collect')!.resolve(result('saved'));
    await settle();
    assert.ok(page.links().includes('/library/detail?id=saved'));
    updates.notifyLibraryUpdated();
    original.find((request) => request.key === 'bilibili_collect')!.resolve({ success: true, data: {
      items: [{ id: 'stale', title: 'stale' }], total: 1,
    } });
    original.filter((request) => !['douyin_collect', 'bilibili_collect', 'douyin_like'].includes(request.key))
      .forEach((request) => request.resolve({ success: false }));
    await settle();
    assert.ok(!page.links().includes('/library/detail?note=stale'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    page.render();
    const refreshed = page.requests.splice(0);
    refreshed.find((request) => request.key === 'douyin_collect')!.resolve({ success: false });
    refreshed.find((request) => request.key === 'bilibili_collect')!.resolve({ success: true, data: {
      items: [{ id: 'new-bili', title: 'new-bili' }], total: 1,
    } });
    await settle();
    assert.ok(page.links().includes('/library/detail?id=saved'));
    assert.ok(page.links().includes('/library/detail?note=new-bili'));
    page.runtime.user = { id: 'user-b' };
    page.render();
    original.find((request) => request.key === 'douyin_like')!.resolve(result('old-user'));
    await settle();
    assert.ok(!page.links().some((href) => /saved|new-bili|old-user/.test(href)));
    assert.equal(page.storage['zhicui:workspace-home:v8:user-a'], undefined);
  } finally { page.close(); }
});

test('台账校准发布后首页不显示旧 v7 预览，网络返回后写入 v8 快照', async () => {
  const page = harness();
  try {
    const keys = ['douyin_collect', 'douyin_like', 'douyin_post', 'bilibili_collect', 'bilibili_like', 'bilibili_import'];
    const channelPreviews = Object.fromEntries(keys.map((key) => [key, key === 'douyin_collect'
      ? [{ key: 'old', href: '/library/detail?id=wrong-old-rank', title: '旧排名', cover: '', author: '' }]
      : []]));
    page.storage['zhicui:workspace-home:v7:user-a'] = JSON.stringify({
      savedAt: Date.now(), threads: [], readyCount: 1, channelPreviews,
      channelTotals: Object.fromEntries(keys.map((key) => [key, 0])),
      activeModes: { douyin: 'collect', bilibili: 'collect' },
    });
    page.render();
    assert.ok(!page.links().includes('/library/detail?id=wrong-old-rank'));
    page.requests.splice(0).forEach((request) => request.resolve(request.key === 'douyin_collect'
      ? result('corrected-rank') : { success: false }));
    await settle();
    assert.ok(page.links().includes('/library/detail?id=corrected-rank'));
    assert.ok(!page.links().includes('/library/detail?id=wrong-old-rank'));
    assert.match(String(page.storage['zhicui:workspace-home:v8:user-a']), /corrected-rank/);
  } finally { page.close(); }
});
