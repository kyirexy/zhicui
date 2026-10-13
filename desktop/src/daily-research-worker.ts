import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DesktopZhicuiSession, PlatformAccountCollectRequest, PlatformAccountResult,
  PlatformAccountStatus, PlatformAccountSyncCancelRequest } from './contract';

type Coverage = 'complete' | 'limited' | 'partial';
type Metadata = Record<string, unknown>;
interface Claim {
  run_id: string; lease_token: string;
  request: { platforms: string[]; source_modes: string[]; limit: number; task_id: string };
}
interface BatchResult { accepted: number; created: number; reused: number; skipped: number; failed: number }
interface Source {
  platform: 'douyin'; source_mode: 'like' | 'collect'; items?: Metadata[];
  coverage: Coverage; order_reliable: boolean; read: number; batches: Record<string, BatchResult>;
  error?: string; capture_failed?: number;
}
interface Checkpoint { version: 1; user: string; run_id: string; request: Claim['request']; sources: Source[]; completed?: boolean }
interface Identity { user: string; profile: string }
interface Active {
  identity: Identity; generation: number; claim: Claim; device: string; checkpoint: Checkpoint;
  source?: Source; sessionKey?: string; stage: 'syncing' | 'waiting_for_user'; message: string;
  controller: AbortController; progress: Promise<unknown>; invalid?: boolean;
}
interface Dependencies {
  directory: string; origin: string;
  getAccessToken: (expectedUserId: string) => string | null;
  collect: (request: PlatformAccountCollectRequest) => Promise<PlatformAccountResult>;
  cancel: (request: PlatformAccountSyncCancelRequest) => Promise<unknown>;
  ownsSession: (sessionKey: string) => boolean;
  fetch?: typeof fetch; pollMs?: number; heartbeatMs?: number;
  onError?: (message: string) => void;
}

class ResearchRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.slice(0, limit) : '';

/** 只保存公开作品元数据，不落盘平台凭据、签名封面或临时播放地址。 */
export function dailyResearchMetadata(result: PlatformAccountResult, limit: number): Metadata[] {
  const output = new Map<string, Metadata>();
  for (const item of result.items || []) {
    if (!/^\d{5,32}$/.test(item.videoId)) throw new Error('平台返回的作品标识无效');
    if (!output.has(item.videoId)) output.set(item.videoId, {
      video_id: item.videoId, title: text(item.title, 500), author_name: text(item.authorName, 200),
      caption: text(item.caption, 2000),
      ...(item.publishedAt ? { published_at: text(item.publishedAt, 64) } : {}),
      ...(Number.isInteger(item.durationSeconds) && item.durationSeconds >= 0
        ? { duration_seconds: Math.min(86400, item.durationSeconds) } : {}),
      ...(item.engagement ? { engagement: Object.fromEntries(Object.entries(item.engagement).filter(([key, value]) =>
        ['likes', 'comments', 'shares', 'collects', 'views'].includes(key)
        && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000000000)) } : {}),
    });
  }
  for (const raw of result.urls || []) {
    const url = new URL(raw), id = /^\/video\/(\d{5,32})\/?$/.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || url.hostname !== 'www.douyin.com' || url.port || url.username || url.password || !id) {
      throw new Error('平台返回的作品链接无效');
    }
    if (!output.has(id)) output.set(id, { video_id: id });
  }
  if (output.size > limit) throw new Error('平台返回条数超过任务上限');
  return [...output.values()];
}

/** 云端负责定时；此消费者仅在桌面在线且同一知萃账号已登录时领取工作。 */
export class DailyResearchWorker {
  private identity: Identity | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private operation: Promise<void> | null = null;
  private active: Active | null = null;
  private stopped = false;
  private device: Promise<string> | null = null;
  private transport: typeof fetch;
  constructor(private readonly dependencies: Dependencies) { this.transport = dependencies.fetch || fetch; }
  get busy(): boolean { return this.operation !== null; }

  async bindSession(session: DesktopZhicuiSession | null): Promise<void> {
    const next = session?.user.agent_profile_key ? { user: session.user.id, profile: session.user.agent_profile_key } : null;
    if (next?.user === this.identity?.user && next?.profile === this.identity?.profile) return;
    this.identity = next;
    this.generation++;
    const active = this.active;
    active?.controller.abort();
    // 只取消本消费者拥有的抖音会话，不触碰手动同步或切换后的账号。
    if (active?.sessionKey) await this.dependencies.cancel({ sessionKey: active.sessionKey }).catch(() => undefined);
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.runOnce(); }, this.dependencies.pollMs ?? 30_000);
    this.timer.unref?.();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.generation++;
    this.active?.controller.abort();
    if (this.active?.sessionKey) await this.dependencies.cancel({ sessionKey: this.active.sessionKey }).catch(() => undefined);
  }

  runOnce(): Promise<void> {
    if (this.operation) return this.operation;
    if (this.stopped || !this.identity || !this.dependencies.getAccessToken(this.identity.user)) return Promise.resolve();
    const identity = this.identity, generation = this.generation;
    const work = this.execute(identity, generation).catch((error: unknown) => {
      if (generation === this.generation && !this.stopped) {
        this.dependencies.onError?.(error instanceof ResearchRequestError ? error.message : '每日研究连接中断，进度已保留，将在桌面在线时继续');
      }
    }).finally(() => { if (this.operation === work) this.operation = null; });
    this.operation = work;
    return work;
  }

  recordPlatformStatus(status: PlatformAccountStatus): void {
    const active = this.active;
    if (!active?.sessionKey || !active.source || status.platform !== active.source.platform
      || (status.mode && status.mode !== active.source.source_mode) || !this.current(active)
      || !this.dependencies.ownsSession(active.sessionKey)) return;
    active.source.read = Math.max(active.source.read, Math.min(active.claim.request.limit, count(status.readCount)));
    const next = status.stage === 'needs-action' || status.stage === 'waiting' ? 'waiting_for_user' : 'syncing';
    // 验证状态必须立即回传；普通逐页进度由心跳合并，避免制造大量请求。
    const changed = next !== active.stage;
    active.stage = next;
    active.message = text(status.message, 500);
    if (changed) void this.report(active).catch(() => undefined);
  }

  private current(active: Pick<Active, 'generation' | 'identity'>): boolean {
    return !this.stopped && active.generation === this.generation && this.identity?.user === active.identity.user
      && this.identity?.profile === active.identity.profile;
  }
  private assertCurrent(active: Pick<Active, 'generation' | 'identity'>): void {
    if (!this.current(active) || !this.dependencies.getAccessToken(active.identity.user)) throw new Error('账号已切换或桌面离线');
  }
  private async request(identity: Identity, generation: number, path: string, body: unknown, controller?: AbortController): Promise<unknown> {
    this.assertCurrent({ identity, generation });
    const token = this.dependencies.getAccessToken(identity.user)!;
    const response = await this.transport(`${this.dependencies.origin}/api/daily-research/desktop/${path}`, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    this.assertCurrent({ identity, generation });
    const payload = await response.json().catch(() => null) as { success?: boolean; data?: unknown; error?: unknown; detail?: unknown } | null;
    this.assertCurrent({ identity, generation });
    if (!response.ok || !payload?.success) throw new ResearchRequestError(response.status,
      response.status === 401 ? '知萃会话正在重新确认，任务进度已保留' : response.status === 409 ? '每日研究任务已更新，将重新确认进度' : '每日研究服务暂时不可用，进度已保留');
    return payload.data;
  }
  private async deviceId(): Promise<string> {
    if (!this.device) this.device = (async () => {
      await mkdir(this.dependencies.directory, { recursive: true });
      const path = join(this.dependencies.directory, 'device-id');
      try {
        const value = (await readFile(path, 'utf8')).trim();
        if (/^[a-f0-9-]{36}$/.test(value)) return value;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const value = randomUUID();
      await writeFile(path, value, { mode: 0o600 });
      return value;
    })().catch(error => { this.device = null; throw error; });
    return this.device;
  }
  private checkpointPath(identity: Identity): string {
    const key = createHash('sha256').update(`${this.dependencies.origin}:${identity.user}:${identity.profile}`).digest('hex');
    return join(this.dependencies.directory, `${key}.json`);
  }
  private async save(active: Active): Promise<void> {
    // 临时离线仍保存已采集结果；账号切换则禁止把旧结果写入新身份。
    if (!this.current(active)) throw new Error('知萃账号已切换');
    const path = this.checkpointPath(active.identity), temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(active.checkpoint), { mode: 0o600 });
    await rename(temporary, path);
  }
  private validateClaim(raw: unknown): Claim {
    const value = raw as Claim;
    if (!value || !/^[A-Za-z0-9-]{1,64}$/.test(value.run_id) || !value.lease_token || value.lease_token.length > 200
      || value.request?.task_id !== value.run_id || !Array.isArray(value.request.platforms)
      || value.request.platforms.length !== 1 || value.request.platforms[0] !== 'douyin'
      || !Array.isArray(value.request.source_modes) || !value.request.source_modes.length
      || value.request.source_modes.some(mode => !['like', 'collect'].includes(mode))
      || new Set(value.request.source_modes).size !== value.request.source_modes.length
      || !Number.isInteger(value.request.limit) || value.request.limit < 1 || value.request.limit > 500) {
      throw new Error('每日研究任务格式无效或需要更新桌面端');
    }
    return value;
  }
  private counts(active: Active): BatchResult & { read: number } {
    const results = active.checkpoint.sources.flatMap(source => Object.values(source.batches));
    const total = (key: keyof BatchResult) => results.reduce((sum, result) => sum + count(result[key]), 0);
    return { read: active.checkpoint.sources.reduce((sum, source) => sum + source.read, 0), accepted: total('accepted'),
      created: total('created'), reused: total('reused'), skipped: total('skipped'),
      failed: total('failed') + active.checkpoint.sources.reduce((sum, source) => sum + count(source.capture_failed), 0) };
  }
  private context(active: Active): Record<string, unknown> {
    return { run_id: active.claim.run_id, lease_token: active.claim.lease_token, device_id: active.device };
  }
  private report(active: Active): Promise<unknown> {
    const work = active.progress.then(async () => {
      if (active.invalid) throw new Error('任务租约需要重新确认');
      const totals = this.counts(active);
      return this.request(active.identity, active.generation, 'progress', { ...this.context(active), stage: active.stage,
        message: active.message, ...(active.source ? { platform: active.source.platform, source_mode: active.source.source_mode } : {}),
        read: totals.read, saved: totals.accepted, created: totals.created, reused: totals.reused, failed: totals.failed }, active.controller);
    }).catch(async error => {
      if (error instanceof ResearchRequestError && [401, 403, 404, 409, 410].includes(error.status)) {
        active.invalid = true;
        if (active.sessionKey) await this.dependencies.cancel({ sessionKey: active.sessionKey }).catch(() => undefined);
      }
      throw error;
    });
    active.progress = work.catch(() => undefined);
    return work;
  }
  private async execute(identity: Identity, generation: number): Promise<void> {
    const device = await this.deviceId();
    const raw = await this.request(identity, generation, 'claim', { device_id: device, capabilities_version: 1 });
    if (!raw) return;
    const claim = this.validateClaim(raw);
    let checkpoint: Checkpoint | undefined;
    try {
      const saved = JSON.parse(await readFile(this.checkpointPath(identity), 'utf8')) as Checkpoint;
      if (saved.version === 1 && saved.user === identity.user && saved.run_id === claim.run_id
        && JSON.stringify(saved.request) === JSON.stringify(claim.request)) checkpoint = saved;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    checkpoint ||= { version: 1, user: identity.user, run_id: claim.run_id, request: claim.request,
      sources: claim.request.source_modes.map(mode => ({ platform: 'douyin', source_mode: mode as Source['source_mode'],
        coverage: 'partial', order_reliable: false, read: 0, batches: {} })) };
    const active: Active = { identity, generation, claim, device, checkpoint, stage: 'syncing', message: '正在同步喜欢和收藏',
      controller: new AbortController(), progress: Promise.resolve() };
    this.active = active;
    let heartbeatBusy = false;
    const heartbeat = setInterval(() => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      void this.report(active).catch(() => undefined).finally(() => { heartbeatBusy = false; });
    }, this.dependencies.heartbeatMs ?? 20_000);
    heartbeat.unref?.();
    try {
      await this.save(active);
      for (const source of checkpoint.sources) {
        this.assertCurrent(active);
        if (active.invalid) throw new Error('任务租约需要重新确认');
        active.source = source;
        if (!source.items) {
          active.stage = 'syncing';
          active.message = `正在读取${source.source_mode === 'like' ? '喜欢' : '收藏'}，最多 ${claim.request.limit} 条`;
          await this.report(active);
          active.sessionKey = randomUUID();
          let captured: PlatformAccountResult;
          try {
            captured = await this.dependencies.collect({ platform: 'douyin', mode: source.source_mode,
              profileKey: identity.profile, limit: claim.request.limit, interactive: false, sessionKey: active.sessionKey });
          } finally { active.sessionKey = undefined; }
          if (!this.current(active)) throw new Error('知萃账号已切换');
          if (active.invalid) throw new Error('任务租约需要重新确认');
          // 手动操作占用时留待下轮领取，不能取消它或把它当成本任务失败。
          if (captured.code === 'LOCAL_ACTION_BUSY') throw new Error('平台账号正在同步，稍后继续每日研究');
          if (!captured.success || captured.cancelled) {
            source.error = text(captured.error || captured.code || '平台采集未完成', 500);
            source.coverage = 'partial';
            source.capture_failed = source.read;
            source.items = [];
          } else {
            source.items = dailyResearchMetadata(captured, claim.request.limit);
            source.coverage = captured.coverage || 'partial';
            source.order_reliable = captured.orderReliable === true;
            source.read = source.items.length;
            if (!source.items.length && captured.coverage !== 'complete') source.error = '尚未确认平台列表为空，请完成平台验证';
            else if (captured.warning && source.coverage === 'partial') source.error = text(captured.warning, 500);
          }
          await this.save(active);
        }
        for (let offset = 0; offset < source.items.length; offset += 100) {
          const batchId = `${claim.run_id}-${source.platform}-${source.source_mode}-${offset}`;
          if (source.batches[batchId]) continue;
          active.stage = 'syncing';
          active.message = `正在保存${source.source_mode === 'like' ? '喜欢' : '收藏'} ${offset + 1}–${Math.min(offset + 100, source.items.length)} 条`;
          await this.report(active);
          const result = await this.request(identity, generation, 'batch', { ...this.context(active), batch_id: batchId,
            platform: source.platform, source_mode: source.source_mode, items: source.items.slice(offset, offset + 100),
            coverage: source.coverage, order_reliable: source.order_reliable, source_rank_offset: offset }, active.controller) as Partial<BatchResult>;
          if (!result || ['accepted', 'created', 'reused', 'skipped', 'failed'].some(key =>
            !Number.isSafeInteger(result[key as keyof BatchResult]) || Number(result[key as keyof BatchResult]) < 0)
            || Number(result.accepted) + Number(result.skipped) + Number(result.failed) !== source.items.slice(offset, offset + 100).length) {
            throw new Error('保存结果尚未确认，稍后重试同一批次');
          }
          source.batches[batchId] = { accepted: count(result.accepted), created: count(result.created), reused: count(result.reused),
            skipped: count(result.skipped), failed: count(result.failed) };
          await this.save(active);
        }
      }
      clearInterval(heartbeat);
      await active.progress;
      this.assertCurrent(active);
      if (active.invalid) throw new Error('任务租约需要重新确认');
      const sources = checkpoint.sources.map(source => {
        const results = Object.values(source.batches), total = (key: keyof BatchResult) => results.reduce((sum, row) => sum + row[key], 0);
        return { platform: source.platform, source_mode: source.source_mode, coverage: source.coverage, read: source.read,
          saved: total('accepted'), created: total('created'), reused: total('reused'), failed: total('failed') + count(source.capture_failed),
          ...(source.error ? { error: source.error } : {}) };
      });
      await this.request(identity, generation, 'complete', { ...this.context(active),
        coverage: sources.some(source => source.coverage === 'partial' || source.failed) ? 'partial'
          : sources.some(source => source.coverage === 'limited') ? 'limited' : 'complete', sources }, active.controller);
      checkpoint.completed = true;
      await this.save(active);
    } finally {
      clearInterval(heartbeat);
      await active.progress;
      if (this.active === active) this.active = null;
    }
  }
}
