import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteShowcaseCase,
  listAdminShowcaseCases,
  listPublicShowcaseCases,
  loadAdminShowcaseCaseMedia,
  SHOWCASE_GIF_MAX_BYTES,
  SHOWCASE_MP4_MAX_BYTES,
  updateShowcaseCase,
  uploadShowcaseCaseMedia,
  validateShowcaseMedia,
  validateShowcasePublication,
  type ShowcaseCase,
  type ShowcaseCaseInput,
} from './showcaseCases.ts';
import { resolveClientAuthPolicy } from './clientAuthPolicy.ts';

const fixture: ShowcaseCase = {
  id: 3, title: '测试录屏案例', industry: '教育', person_name: '匿名讲师', role: '讲师',
  summary: '本地测试内容', challenge: '', workflow: '', outcome: '',
  source_url: '', source_label: '', authenticity_confirmed: true, published: true,
  sort_order: 0, media_url: '/api/showcase-cases/3/media', poster_url: null,
  media_type: 'video/mp4', media_size: 512, updated_at: '2026-09-06T00:00:00Z',
};

const input: ShowcaseCaseInput = {
  title: fixture.title, industry: fixture.industry, person_name: fixture.person_name,
  role: fixture.role, summary: fixture.summary, challenge: '', workflow: '', outcome: '',
  source_url: '', source_label: '', authenticity_confirmed: true, published: false, sort_order: 0,
};

function replaceGlobal(key: string, value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, key, original);
    else Reflect.deleteProperty(globalThis, key);
  };
}

function mockLogin(token: string | null = 'local-test-token'): () => void {
  return replaceGlobal('window', { localStorage: { getItem: () => token } });
}

test('公开案例列表不带账号凭据，来源为空时安全归一化', async (context) => {
  let called = false;
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    called = true;
    assert.match(url, /\/api\/showcase-cases$/);
    assert.equal(new Headers(options.headers).get('Authorization'), null);
    assert.equal(options.cache, 'no-store');
    return Response.json({ success: true, data: [{ ...fixture, source_url: null }], error: null });
  });
  const items = await listPublicShowcaseCases();
  assert.equal(called, true);
  assert.equal(items[0].id, 3);
  assert.equal(items[0].source_url, '');
});

test('HTTP 或业务 envelope 错误必须拒绝，不能当作空列表成功', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => Response.json({ success: false, data: null, error: '服务暂不可用' }));
  await assert.rejects(listPublicShowcaseCases(), /服务暂不可用/);
  context.mock.method(globalThis, 'fetch', async () => new Response('代理错误页', { status: 502 }));
  await assert.rejects(listPublicShowcaseCases(), /502/);
  context.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: {} }));
  await assert.rejects(listPublicShowcaseCases(), /列表格式异常/);
});

test('管理员修改用 Bearer 认证且原样传递最终发布确认', async (context) => {
  const restore = mockLogin();
  try {
    context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.match(url, /\/api\/admin\/showcase-cases\/3$/);
      assert.equal(options.method, 'PATCH');
      assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer local-test-token');
      assert.deepEqual(JSON.parse(String(options.body)), { published: true, authenticity_confirmed: true });
      return Response.json({ success: true, data: fixture });
    });
    const saved = await updateShowcaseCase(3, { published: true, authenticity_confirmed: true });
    assert.equal(saved.published, true);
  } finally { restore(); }
});

test('登录失效时管理员请求不会匿名发送', async (context) => {
  const restore = mockLogin(null);
  const fetchMock = context.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: [] }));
  try {
    await assert.rejects(listAdminShowcaseCases(), /重新登录/);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { restore(); }
});

test('删除失败保留服务器错误，删除成功可接收空 data', async (context) => {
  const restore = mockLogin();
  try {
    context.mock.method(globalThis, 'fetch', async () => Response.json({ success: false, error: '无法删除素材' }, { status: 500 }));
    await assert.rejects(deleteShowcaseCase(3), /无法删除素材/);
    context.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: null }));
    await assert.doesNotReject(deleteShowcaseCase(3));
  } finally { restore(); }
});

test('草稿素材从受保护端点获取 blob，不把 Bearer 放入 URL', async (context) => {
  const restore = mockLogin();
  try {
    context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      assert.match(url, /\/api\/admin\/showcase-cases\/3\/media$/);
      assert.doesNotMatch(url, /token|Bearer/);
      assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer local-test-token');
      return new Response(new Blob(['local-media'], { type: 'video/mp4' }));
    });
    const blob = await loadAdminShowcaseCaseMedia(3);
    assert.equal(await blob.text(), 'local-media');
  } finally { restore(); }
});

test('MP4 与 GIF 大小边界、空文件和格式不匹配均正确限制', () => {
  assert.equal(validateShowcaseMedia({ name: 'demo.mp4', type: 'video/mp4', size: SHOWCASE_MP4_MAX_BYTES }), null);
  assert.match(validateShowcaseMedia({ name: 'demo.mp4', type: 'video/mp4', size: SHOWCASE_MP4_MAX_BYTES + 1 }) || '', /100 MB/);
  assert.equal(validateShowcaseMedia({ name: 'demo.GIF', type: '', size: SHOWCASE_GIF_MAX_BYTES }), null);
  assert.match(validateShowcaseMedia({ name: 'demo.gif', type: 'image/gif', size: SHOWCASE_GIF_MAX_BYTES + 1 }) || '', /20 MB/);
  assert.match(validateShowcaseMedia({ name: 'demo.mp4', type: 'video/mp4', size: 0 }) || '', /文件为空/);
  assert.match(validateShowcaseMedia({ name: 'demo.mp4', type: 'text/html', size: 20 }) || '', /仅支持/);
  assert.match(validateShowcaseMedia({ name: 'demo.html', type: 'video/mp4', size: 20 }) || '', /仅支持/);
});

test('发布必须具备标题、行业、简介、素材和本次真实授权确认', () => {
  assert.equal(validateShowcasePublication(input, true), null);
  for (const key of ['title', 'industry', 'summary'] as const) {
    assert.ok(validateShowcasePublication({ ...input, [key]: ' ' }, true));
  }
  assert.match(validateShowcasePublication(input, false) || '', /录屏/);
  assert.match(validateShowcasePublication({ ...input, authenticity_confirmed: false }, true) || '', /授权/);
});

class FakeUpload {
  static latest: FakeUpload;
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  headers = new Headers();
  url = '';
  body: FormData | null = null;
  status = 200;
  timeout = 0;
  responseText = '';
  constructor() { FakeUpload.latest = this; }
  open(method: string, url: string) { assert.equal(method, 'POST'); this.url = url; }
  setRequestHeader(key: string, value: string) { this.headers.set(key, value); }
  send(body: FormData) { this.body = body; }
  abort() { this.onabort?.(); }
  respond(status: number, payload: unknown) { this.status = status; this.responseText = JSON.stringify(payload); this.onload?.(); }
}

test('素材上传携带认证和 multipart 文件，并报告进度与服务端失败', async () => {
  const restoreLogin = mockLogin();
  const restoreXhr = replaceGlobal('XMLHttpRequest', FakeUpload);
  try {
    const progress: number[] = [];
    const file = new File(['local'], 'demo.mp4', { type: 'video/mp4' });
    const pending = uploadShowcaseCaseMedia(3, file, { onProgress: (value) => progress.push(value) });
    const xhr = FakeUpload.latest;
    assert.match(xhr.url, /\/api\/admin\/showcase-cases\/3\/media$/);
    assert.equal(xhr.headers.get('Authorization'), 'Bearer local-test-token');
    assert.equal(xhr.headers.get('Content-Type'), null);
    assert.equal((xhr.body?.get('file') as File).name, 'demo.mp4');
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.respond(200, { success: true, data: fixture });
    assert.equal((await pending).id, 3);
    assert.deepEqual(progress, [25]);
    const failure = uploadShowcaseCaseMedia(3, file);
    FakeUpload.latest.respond(400, { success: false, error: '视频文件无法解码' });
    await assert.rejects(failure, /无法解码/);
    const controller = new AbortController();
    const cancelled = uploadShowcaseCaseMedia(3, file, { signal: controller.signal });
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
  } finally { restoreXhr(); restoreLogin(); }
});

test('首页案例管理在浏览器保留登录守卫，但不触发客户端下载墙', () => {
  const policy = resolveClientAuthPolicy('/admin/showcase-cases', {
    desktop: false, nativeMobile: false, development: false,
  });
  assert.equal(policy.publicRoute, false);
  assert.equal(policy.browserClientGate, false);
  assert.equal(policy.clientOnlyRoute, false);
});
