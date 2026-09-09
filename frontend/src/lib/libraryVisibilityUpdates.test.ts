import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as updates from './libraryUpdates.ts';
import * as session from './authSession.ts';

type ApiResult = { success: boolean; data?: unknown; error?: string };
type VisibilityApi = {
  removeDouyinLibraryItems: (ids: string[], mode: string) => Promise<ApiResult>;
  restorePermanentlyHiddenDouyinItems: (ids: string[]) => Promise<ApiResult>;
};

// 执行完整 api.ts 与真实 request/sessionFetch，只替换网络响应和浏览器存储。
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const values: Record<string, string> = { zhicui_token: 'token-a' };
  const localStorage = { getItem: (key: string) => values[key] ?? null, removeItem: (key: string) => { delete values[key]; } };
  const cached: Record<string, string> = {
    'zhicui:workspace-home:v8:user-a': 'old-a',
    'zhicui:workspace-home:v8:user-b': 'old-b',
    'zhicui-library-list-v5:user-a:collect:collection': 'old-collect',
    'zhicui-library-list-v5:user-a:like:collection': 'old-like',
    unrelated: 'keep',
  };
  const sessionStorage = Object.assign(cached, { removeItem: (key: string) => { delete cached[key]; } });
  const window = Object.assign(new EventTarget(), { localStorage, sessionStorage });
  let events = 0;
  window.addEventListener(updates.LIBRARY_UPDATED_EVENT, () => { events += 1; });
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<Response>((done, failed) => { resolve = done; reject = failed; });
  const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return pending;
  };
  const originals = ['window', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetch });
  const api = {} as VisibilityApi;
  vm.runInNewContext(code, {
    exports: api, process: { env: {} }, window, localStorage, Headers, Request, Response, URLSearchParams,
    require(name: string) {
      if (name === './libraryUpdates') return updates;
      if (name === './authSession') return session;
      if (name === './douyinDesktopSync' || name === './platformImportBatch') return {};
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { api, values, cached, requests, reject, events: () => events,
    complete(status: number, payload: unknown) {
      resolve(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }));
    },
    close() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const action of ['hide', 'restore'] as const) {
  const label = action === 'hide' ? '永久隐藏' : '恢复隐藏';
  const run = (h: ReturnType<typeof harness>) => action === 'hide'
    ? h.api.removeDouyinLibraryItems(['video-a'], 'permanent')
    : h.api.restorePermanentlyHiddenDouyinItems(['video-a']);
  const path = action === 'hide' ? '/api/library/douyin/items/remove' : '/api/library/douyin/hidden-items/restore';

  for (const failure of [false, true]) {
    test(`${label}${failure ? '网络中断' : '成功'}后统一作废旧读取和全部来源缓存，不改变请求语义`, async () => {
      const h = harness();
      try {
        const revision = updates.getLibraryRevision();
        const task = run(h);
        assert.equal(h.events(), 0, '请求发出时不能提前伪装完成');
        assert.equal(h.requests[0].url, path);
        assert.equal(h.requests[0].headers.get('Authorization'), 'Bearer token-a');
        assert.deepEqual(h.requests[0].body, { aweme_ids: ['video-a'], ...(action === 'hide' ? { mode: 'permanent' } : {}) });
        if (failure) h.reject(new TypeError('Network unavailable'));
        else h.complete(200, { success: true, data: { aweme_ids: ['video-a'] } });
        assert.equal((await task).success, !failure);
        assert.equal(h.events(), 1);
        assert.equal(updates.isLibraryRevisionCurrent(revision), false);
        assert.equal(h.cached['zhicui:workspace-home:v8:user-a'], undefined);
        assert.equal(h.cached['zhicui-library-list-v5:user-a:collect:collection'], undefined);
        assert.equal(h.cached['zhicui-library-list-v5:user-a:like:collection'], undefined);
        assert.equal(h.cached.unrelated, 'keep');
        assert.equal(h.values.zhicui_token, 'token-a');
      } finally { h.close(); }
    });
  }

  test(`${label}返回403仍可重新确认资料，但不把失败变成功或退出账号`, async () => {
    const h = harness();
    try {
      const task = run(h);
      h.complete(403, { detail: '没有权限' });
      const result = await task;
      assert.equal(result.success, false);
      assert.equal(result.error, '没有权限');
      assert.equal(h.events(), 1);
      assert.equal(h.values.zhicui_token, 'token-a');
    } finally { h.close(); }
  });

  for (const status of [200, 401]) {
    test(`${label}期间切换账号，旧请求${status}迟到仅失效缓存，不替换新账号凭据或重发请求`, async () => {
      const h = harness();
      try {
        const task = run(h);
        h.values.zhicui_token = 'token-b';
        h.complete(status, { success: status === 200, data: { aweme_ids: ['video-a'] } });
        assert.equal((await task).success, status === 200);
        assert.equal(h.requests.length, 1);
        assert.equal(h.requests[0].headers.get('Authorization'), 'Bearer token-a');
        assert.equal(h.events(), 1);
        assert.equal(h.values.zhicui_token, 'token-b');
        assert.equal(h.cached['zhicui:workspace-home:v8:user-b'], undefined);
      } finally { h.close(); }
    });
  }
}
