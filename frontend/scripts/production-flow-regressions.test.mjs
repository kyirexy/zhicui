import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

// 运行真实组件逻辑；只替换 Hook 调度、网络与宿主 API，不依赖浏览器或新增测试框架。
function hooks(seed = []) {
  const states = [], refs = [], effects = [];
  let si = 0, ri = 0, ei = 0, writes = 0;
  const react = {
    ...React,
    useState(initial) {
      const index = si++;
      if (!(index in states)) states[index] = index in seed ? seed[index] : typeof initial === 'function' ? initial() : initial;
      return [states[index], next => { writes++; states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useRef(initial) { return refs[ri++] ??= { current: initial }; },
    useEffect(effect, deps) {
      const index = ei++;
      const previous = effects[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        previous?.cleanup?.();
        effects[index] = { deps, pending: effect };
      }
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
  };
  return {
    react, states,
    get writes() { return writes; },
    render(Component, props = {}) {
      si = ri = ei = 0;
      const result = Component(props);
      for (const effect of effects) if (effect.pending) { effect.cleanup = effect.pending(); effect.pending = null; }
      return result;
    },
    unmount() { for (const effect of effects) effect?.cleanup?.(); },
  };
}

function load(relativePath, harness, mocks = {}) {
  const source = readFileSync(fileURLToPath(new URL(`../src/${relativePath}`, import.meta.url)), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText;
  const module = { exports: {} };
  const localRequire = id => {
    if (id === 'react') return harness.react;
    if (id in mocks) return mocks[id];
    if (id.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_target, key) => key }) };
    return require(id);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

function buttons(tree, text) {
  const result = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === 'button' && JSON.stringify(node.props.children).includes(text)) result.push(node);
    visit(node.props?.children);
  }
  visit(tree);
  return result;
}

test('创作草稿先估价，展示报价后才允许确认；初次失败显示错误', async () => {
  const draft = { id: 'job-a', status: 'draft', svml_text: '<svml/>', pricing: {}, requirement_text: 'demo' };
  const h = hooks([[], draft, '', '', false, '']);
  const calls = [];
  const api = {
    listVideoCreationJobs: async () => ({ success: true, data: [] }),
    estimateVideoCreationJob: async id => { calls.push(['estimate', id]); return { success: true, data: { ...draft, pricing: { estimate: 1.2 }, quote_token: 'quoted-a' } }; },
    confirmVideoCreationJob: async (...args) => { calls.push(['confirm', ...args]); return { success: true, data: { ...draft, status: 'queued' } }; },
  };
  const Component = load('components/studio/StudioWorkspace.tsx', h, {
    '@/lib/api': api, '@/lib/hooks/AuthContext': { useAuth: () => ({ user: null, loading: true }) },
    './StudioVideoResult': { __esModule: true, default: () => null },
  }).default;
  let tree = h.render(Component);
  assert.equal(buttons(tree, '确认并开始渲染').length, 0);
  buttons(tree, '获取渲染估价')[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = h.render(Component);
  assert.match(renderToStaticMarkup(tree), /1\.20/);
  assert.deepEqual(calls, [['estimate', 'job-a']]);
  buttons(tree, '确认并开始渲染')[0].props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], ['confirm', 'job-a', 'quoted-a']);
  h.unmount();

  const failure = hooks([[], null, '', '', false, '创作工坊暂未开启']);
  const Failed = load('components/studio/StudioWorkspace.tsx', failure, {
    '@/lib/api': {}, '@/lib/hooks/AuthContext': { useAuth: () => ({ user: null, loading: true }) },
    './StudioVideoResult': { __esModule: true, default: () => null },
  }).default;
  assert.match(renderToStaticMarkup(failure.render(Failed)), /role="alert">创作工坊暂未开启/);
  failure.unmount();
});

test('解析换账号会重建上下文，取消旧请求且拒绝迟到事件与回包', async () => {
  const previousStorage = globalThis.sessionStorage;
  const storage = new Map([['vc-home-card', 'old-private-card']]);
  globalThis.sessionStorage = { removeItem: key => storage.delete(key) };
  try {
    let user = { id: 'account-a' };
    const pending = [];
    const h = hooks();
    const module = load('lib/hooks/ExtractionContext.tsx', h, {
      './AuthContext': { useAuth: () => ({ user }) },
      '@/lib/api': { extractVideoStream: (url, progress, signal) => new Promise(resolve => pending.push({ url, progress, signal, resolve })) },
    });
    const accountA = module.ExtractionProvider({ children: null });
    let tree = h.render(accountA.type, accountA.props);
    assert.equal(storage.has('vc-home-card'), false);
    const first = tree.props.value.startExtraction('https://example.com/a');
    pending[0].progress({ step: 'transcribe', status: 'done', message: '完成', data: { transcript: '账号 A 私人原文' } });
    tree = h.render(accountA.type, accountA.props);
    assert.equal(tree.props.value.transcript, '账号 A 私人原文');
    user = null;
    assert.notEqual(module.ExtractionProvider({ children: null }).key, accountA.key);
    user = { id: 'account-b' };
    assert.notEqual(module.ExtractionProvider({ children: null }).key, accountA.key);
    h.unmount();
    assert.equal(pending[0].signal.aborted, true);
    const writes = h.writes;
    pending[0].progress({ step: 'done', status: 'done', message: '完成', data: { id: 'old-card' } });
    pending[0].resolve({ success: false, error: 'old-error' });
    await first;
    assert.equal(h.writes, writes);
    assert.equal(storage.has('vc-home-card'), false);
  } finally { globalThis.sessionStorage = previousStorage; }
});

test('切换创作任务后，旧轮询响应不能把当前任务切回去', async () => {
  const previousWindow = globalThis.window;
  let tick, finish;
  globalThis.window = { setInterval: fn => { tick = fn; return 1; }, clearInterval() {} };
  try {
    const oldJob = { id: 'old-job', status: 'drafting', pricing: {}, requirement_text: 'old' };
    const selected = { id: 'new-job', status: 'draft', pricing: {}, requirement_text: 'new', svml_text: '<svml/>' };
    const h = hooks([[], oldJob, '', '', false, '']);
    const Component = load('components/studio/StudioWorkspace.tsx', h, {
      '@/lib/api': { getVideoCreationJob: () => new Promise(resolve => { finish = resolve; }) },
      '@/lib/hooks/AuthContext': { useAuth: () => ({ user: null, loading: true }) },
      './StudioVideoResult': { __esModule: true, default: () => null },
    }).default;
    h.render(Component);
    const pending = tick();
    h.states[1] = selected;
    h.render(Component);
    finish({ success: true, data: { ...oldJob, status: 'draft' } });
    await pending;
    assert.equal(h.states[1].id, 'new-job');
    h.unmount();
  } finally { globalThis.window = previousWindow; }
});

test('同账号新解析不被已取消的旧解析覆盖', async () => {
  const pending = [];
  const h = hooks();
  const module = load('lib/hooks/ExtractionContext.tsx', h, {
    './AuthContext': { useAuth: () => ({ user: { id: 'a' } }) },
    '@/lib/api': { extractVideoStream: (_url, progress, signal) => new Promise(resolve => pending.push({ progress, signal, resolve })) },
  });
  const wrapper = module.ExtractionProvider({ children: null });
  let tree = h.render(wrapper.type, wrapper.props);
  const first = tree.props.value.startExtraction('old');
  const second = tree.props.value.startExtraction('new');
  assert.equal(pending[0].signal.aborted, true);
  pending[1].progress({ step: 'transcribe', status: 'done', message: '新内容', data: { transcript: 'new' } });
  pending[0].progress({ step: 'transcribe', status: 'done', message: '旧内容', data: { transcript: 'old' } });
  pending[0].resolve({ success: false, error: 'old-error' });
  await first;
  tree = h.render(wrapper.type, wrapper.props);
  assert.equal(tree.props.value.transcript, 'new');
  assert.equal(tree.props.value.error, null);
  pending[1].resolve({ success: true });
  await second;
  h.unmount();
});

test('成品仅使用鉴权下载后的 Blob，卸载时取消请求并回收 URL', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const revoked = [];
  URL.createObjectURL = () => 'blob:local-only';
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    let request;
    const h = hooks();
    const Component = load('components/studio/StudioVideoResult.tsx', h, {
      '@/lib/api': { downloadVideoCreationJob: (id, signal) => new Promise(resolve => { request = { id, signal, resolve }; }) },
    }).default;
    let tree = h.render(Component, { jobId: 'job-a' });
    assert.doesNotMatch(renderToStaticMarkup(tree), /\/api\/video-creation/);
    buttons(tree, '加载并播放成品')[0].props.onClick();
    request.resolve(new Blob(['video'], { type: 'video/mp4' }));
    await new Promise(resolve => setImmediate(resolve));
    tree = h.render(Component, { jobId: 'job-a' });
    assert.match(renderToStaticMarkup(tree), /src="blob:local-only"/);
    h.unmount();
    assert.deepEqual(revoked, ['blob:local-only']);

    const delayed = hooks();
    const Delayed = load('components/studio/StudioVideoResult.tsx', delayed, {
      '@/lib/api': { downloadVideoCreationJob: (_id, signal) => new Promise(resolve => { request = { signal, resolve }; }) },
    }).default;
    buttons(delayed.render(Delayed, { jobId: 'job-b' }), '加载并播放成品')[0].props.onClick();
    delayed.unmount();
    assert.equal(request.signal.aborted, true);
    const writes = delayed.writes;
    request.resolve(new Blob(['old']));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(delayed.writes, writes);
  } finally { globalThis.window = previousWindow; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});

test('成品请求使用 API_BASE、Bearer 与现有 sessionFetch 续期机制', async () => {
  const oldWindow = globalThis.window, oldStorage = globalThis.localStorage;
  const oldBase = process.env.NEXT_PUBLIC_API_URL;
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => 'saved-token' };
  process.env.NEXT_PUBLIC_API_URL = 'https://api.example.test';
  try {
    let captured;
    const expectedBlob = new Blob(['checked']);
    const module = load('lib/api.ts', hooks(), {
      './authSession': { sessionFetch: async (url, init) => { captured = { url, init }; return new Response('ok'); } },
      './videoDownload': { readVideoDownload: async () => expectedBlob },
      './libraryUpdates': {}, './douyinDesktopSync': {}, './platformImportBatch': {}, './bilibiliImportJobs': {},
    });
    const controller = new AbortController();
    assert.equal(await module.downloadVideoCreationJob('job/a', controller.signal), expectedBlob);
    assert.equal(captured.url, 'https://api.example.test/api/video-creation/jobs/job%2Fa/video');
    assert.equal(captured.init.headers.get('Authorization'), 'Bearer saved-token');
    assert.equal(captured.init.signal, controller.signal);
    assert.equal(captured.init.redirect, 'error');
    assert.equal(captured.init.cache, 'no-store');
  } finally {
    globalThis.window = oldWindow; globalThis.localStorage = oldStorage;
    if (oldBase === undefined) delete process.env.NEXT_PUBLIC_API_URL; else process.env.NEXT_PUBLIC_API_URL = oldBase;
  }
});
