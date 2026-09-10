import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DailyRecap, DailyRecapItem } from './dailyRecapApi';

type Api = typeof import('./dailyRecapApi');

function loadApi(response: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const exports = {} as Api;
  const source = readFileSync(new URL('./dailyRecapApi.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(js, { exports, URLSearchParams, Error, process: { env: { NEXT_PUBLIC_API_URL: 'https://test.example' } },
    require(name: string) {
      assert.equal(name, './authSession');
      return { readStoredToken: () => 'test-token', sessionFetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init }); return { ok: status >= 200 && status < 300, json: async () => response };
      } };
    },
  });
  return { api: exports, calls };
}

test('日期不受时区转换影响，视频详情只使用内部资料路由', () => {
  const { api } = loadApi(null);
  assert.equal(api.dailyRecapDateLabel('2026-09-09'), '9 月 9 日');
  assert.equal(api.dailyRecapDateLabel('invalid'), '');
  assert.equal(api.dailyRecapItemHref({ platform: 'douyin', video_id: 'abc&next=bad', note_id: null }), '/library/detail?id=abc%26next%3Dbad');
  assert.equal(api.dailyRecapItemHref({ platform: 'bilibili', video_id: 'BV1', note_id: 'note/one' }), '/library/detail?note=note%2Fone');
  assert.equal(api.dailyRecapItemHref({ platform: 'bilibili', video_id: 'BV1', note_id: null }), '/library?platform=bilibili');
});

test('读取携带身份、禁止缓存、支持处理中固定日期，移动端封面补全API域名', async () => {
  const item = { id: 'bilibili:BV1', cover_url: '/api/media/cover' } as DailyRecapItem;
  const data = { items: [item], preview: [item], date: '2026-09-09' } as DailyRecap;
  const { api, calls } = loadApi({ success: true, data });
  const controller = new AbortController();
  const recap = await api.getDailyRecap('Asia/Shanghai', controller.signal, '2026-09-09');
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://test.example');
  assert.equal(url.searchParams.get('timezone'), 'Asia/Shanghai');
  assert.equal(url.searchParams.get('date'), '2026-09-09');
  assert.equal(calls[0].init.cache, 'no-store');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer test-token');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(recap.items[0].cover_url, 'https://test.example/api/media/cover');
  assert.equal(recap.preview[0].cover_url, recap.items[0].cover_url);
});

test('后端失败不会伪装成空记录', async () => {
  const { api } = loadApi({ success: false, error: '服务暂时繁忙' }, 503);
  await assert.rejects(api.getDailyRecap('Asia/Shanghai'), /服务暂时繁忙/);
  const invalid = loadApi(null, 502);
  await assert.rejects(invalid.api.getDailyRecap('Asia/Shanghai'), /昨日回顾暂时未能读取/);
});
