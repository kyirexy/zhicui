import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { DailyRecapItem } from './dailyRecapApi';
import type { PlatformAccountCollectRequest, PlatformAccountItem, PlatformAccountResult, PlatformAccountStatus, PlatformAccountSyncCancelRequest } from './desktopRuntime';

function load<T>(path: string, context: Record<string, unknown> = {}): T {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(js, { exports, Error, URL, ...context });
  return exports as T;
}
const validators = load<{
  validatePlatformAccountCollectRequest: (request: PlatformAccountCollectRequest) => PlatformAccountCollectRequest;
  validatePlatformAccountSyncCancelRequest: (request: PlatformAccountSyncCancelRequest) => PlatformAccountSyncCancelRequest;
}>('../../../desktop/src/security.ts');
const feedback = load<typeof import('./platformSyncFeedback')>('./platformSyncFeedback.ts');

function recap(videoId: string, overrides: Partial<DailyRecapItem> = {}): DailyRecapItem {
  return { id: `douyin:${videoId}`, note_id: null, video_id: videoId, platform: 'douyin',
    title: '昨日视频', cover_url: '', source_url: `https://www.douyin.com/video/${videoId}`,
    source_modes: ['collect'], first_seen_at: '2026-09-22T08:00:00Z', can_extract: true,
    transcript_ready: false, ai_initialized: false, initial_import: false, ...overrides };
}
function media(videoId: string): PlatformAccountItem {
  return { videoId, sourceUrl: `https://www.douyin.com/video/${videoId}`, title: '昨日视频',
    caption: '', authorName: '', coverUrl: '', publishedAt: '', durationSeconds: 12, sourceRank: 1,
    ephemeralMediaUrl: `https://v.douyinvod.com/${videoId}` };
}
function harness(options: {
  desktop?: boolean;
  version?: string;
  existing?: string[];
  onCollect?: (request: PlatformAccountCollectRequest) => PlatformAccountResult | void | Promise<PlatformAccountResult | void>;
} = {}) {
  let token = 'user-a-token';
  const requests: PlatformAccountCollectRequest[] = [];
  const cancels: PlatformAccountSyncCancelRequest[] = [];
  const listeners = new Set<(status: PlatformAccountStatus) => void>();
  const progress: string[] = [];
  const sync = load<typeof import('./douyinDesktopSync')>('./douyinDesktopSync.ts');
  sync.toLocalDouyinSyncItems((options.existing || []).map(media));
  const bridge = {
    getRuntimeInfo: async () => ({ version: options.version || '1.2.0' }),
    collectPlatformAccount: async (request: PlatformAccountCollectRequest) => {
      validators.validatePlatformAccountCollectRequest(request);
      requests.push(request);
      const result = await options.onCollect?.(request);
      return result || { success: true, platform: 'douyin', mode: request.mode,
        coverage: 'complete', items: [media(request.mode)] };
    },
    cancelPlatformAccountSync: async (request: PlatformAccountSyncCancelRequest) => {
      validators.validatePlatformAccountSyncCancelRequest(request);
      cancels.push(request);
      return { success: true, platform: 'douyin' };
    },
    onPlatformAccountStatus: (listener: (status: PlatformAccountStatus) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const module = load<typeof import('./refreshDailyRecapMedia')>('./refreshDailyRecapMedia.ts', {
    crypto: { randomUUID },
    window: { zhicuiDesktop: options.desktop === false ? undefined : bridge,
      localStorage: { setItem: () => { throw new Error('不得持久化探测资料'); } } },
    require(name: string) {
      if (name === './authSession') return { readStoredToken: () => token };
      if (name === './desktopRuntime') return { supportsPlatformAccountSync: (value: unknown) => Boolean(value) };
      if (name === './douyinDesktopSync') return sync;
      if (name === './platformSyncFeedback') return feedback;
      throw new Error(`不允许调用持久化或其它接口：${name}`);
    },
  });
  return { requests, cancels, listeners, progress, sync, setToken: (value: string) => { token = value; },
    run: (items: DailyRecapItem[], overrides: Partial<Parameters<typeof module.refreshDailyRecapMedia>[1]> = {}) =>
      module.refreshDailyRecapMedia(items, { userId: 'user-a', profileKey: 'profile-a',
        onProgress: (message) => progress.push(message), ...overrides }) };
}

test('缺少播放地址时按收藏、喜欢自动打开浏览器，使用真实桌面合同允许的批次参数', async () => {
  const h = harness();
  const items = [recap('collect'), recap('like', { source_modes: ['like'] })];
  const original = JSON.stringify(items);
  const result = await h.run(items);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(h.requests.map((request) => request.mode), ['collect', 'like']);
  for (const request of h.requests) {
    assert.equal(request.platform, 'douyin');
    assert.equal(request.interactive, true);
    assert.equal(request.limit, 100);
    assert.match(request.sessionKey!, /^[A-Za-z0-9_-]{16,80}$/);
  }
  assert.notEqual(h.requests[0].sessionKey, h.requests[1].sessionKey);
  assert.equal(JSON.stringify(items), original, '原始来源及首次发现日期保持不变');
  assert.equal(h.listeners.size, 0);
  assert.equal(h.cancels.length, 0);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['collect', 'like']).length, 2);
});

test('已有缓存、已解析、无音频、不可提取和 B站条目都无需重新探测', async () => {
  const h = harness({ existing: ['cached'] });
  const result = await h.run([recap('cached'), recap('ready', { transcript_ready: true }),
    recap('silent', { transcript_status: 'no_audio' }), recap('legacy-silent', { transcript_source: 'no-audio' }),
    recap('unavailable', { can_extract: false }),
    recap('bili', { platform: 'bilibili' })]);
  assert.equal(result.warnings.length, 0);
  assert.equal(h.requests.length, 0);
});

test('只缓存本次目标，目标已全部覆盖就不再扫描另一列表', async () => {
  const h = harness({ onCollect: () => ({ success: true, platform: 'douyin',
    items: [media('both'), media('unrelated')] }) });
  const result = await h.run([recap('both', { source_modes: ['collect', 'like'] })]);
  assert.equal(result.warnings.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['both']).length, 1);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['unrelated']).length, 0);
});

test('已有目标缓存不会被当前读取里无地址的条目覆盖清空', async () => {
  const h = harness({ existing: ['cached'], onCollect: () => ({ success: true, platform: 'douyin',
    items: [{ ...media('cached'), ephemeralMediaUrl: '' }, media('collect')] }) });
  await h.run([recap('cached'), recap('collect')]);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['cached', 'collect']).length, 2);
});

test('不支持桌面或无效会话返回可行动提示，保留服务端读取路径', async () => {
  for (const h of [harness({ desktop: false }), harness({ version: '1.1.8' })]) {
    const result = await h.run([recap('collect')]);
    assert.match(result.warnings[0], /桌面端.*服务端读取/);
    assert.equal(h.requests.length, 0);
  }
  for (const profileKey of ['guest', '', 'bad:profile']) {
    const h = harness();
    assert.equal((await h.run([recap('collect')], { profileKey })).warnings.length, 1);
    assert.equal(h.requests.length, 0);
  }
});

test('一个列表失败后继续另一个列表，失败原因清理 Electron 包装且明确未覆盖数量', async () => {
  const h = harness({ onCollect: (request) => {
    if (request.mode === 'collect') throw new Error("Error invoking remote method 'desktop:collect-platform-account': Error: 请重新登录抖音后重试");
  } });
  const result = await h.run([recap('collect'), recap('like', { source_modes: ['like'] })]);
  assert.equal(h.requests.length, 2);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /重新登录/);
  assert.doesNotMatch(result.warnings.join(''), /Error invoking|desktop:/);
  assert.match(result.warnings[1], /还有 1 条视频未取得有效播放地址/);
});

test('不可信播放地址不进入缓存并提示未覆盖，不能伪称同步完整', async () => {
  const h = harness({ onCollect: () => ({ success: true, platform: 'douyin', coverage: 'complete',
    items: [{ ...media('collect'), ephemeralMediaUrl: 'https://untrusted.example/video.mp4' }] }) });
  const result = await h.run([recap('collect')]);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['collect']).length, 0);
  assert.match(result.warnings[0], /还有 1 条视频/);
});

test('取消只取消当前合法批次，迟到结果不会缓存且监听器释放', async () => {
  const controller = new AbortController();
  const h = harness({ onCollect: () => { controller.abort(); } });
  await assert.rejects(() => h.run([recap('collect')], { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.cancels.length, 1);
  assert.equal(h.cancels[0].sessionKey, h.requests[0].sessionKey);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['collect']).length, 0);
  assert.equal(h.listeners.size, 0);
});

test('切换账号中止旧批次，不能将旧账号的播放地址缓存给新账号', async () => {
  const h = harness({ onCollect: () => { h.setToken('user-b-token'); } });
  await assert.rejects(() => h.run([recap('collect')]), /账号已切换/);
  assert.equal(h.cancels.length, 1);
  assert.equal(h.sync.getEphemeralDouyinMediaSources(['collect']).length, 0);
  assert.equal(h.listeners.size, 0);
});

test('浏览器取消探测后不继续其它模式', async () => {
  const h = harness({ onCollect: () => ({ success: false, platform: 'douyin', cancelled: true }) });
  await assert.rejects(() => h.run([recap('both', { source_modes: ['collect', 'like'] })]), { name: 'AbortError' });
  assert.equal(h.requests.length, 1);
  assert.equal(h.listeners.size, 0);
});
