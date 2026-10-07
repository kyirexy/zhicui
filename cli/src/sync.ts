import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiClient, runFromEnvelope, runIdOf } from './api-client.js';
import { configRoot, withOwnedCredentialGate } from './credentials.js';
import { CliError, usageError } from './errors.js';
import { RestrictedLocalAdapter } from './local-adapter.js';
import { collectedItems, checkRecapCapabilities } from './recap.js';
import { isJsonObject, isTerminalStatus, type AgentEnvelope, type JsonObject } from './types.js';

export interface SyncOptions { platform: string; mode: string; limit: number; timeoutMs: number; resume?: string }
interface Batch { offset: number; attempt: number; run?: string; result?: JsonObject; failed?: boolean }
interface Source {
  platform: string; mode: string; attempt: number; localRun?: string; retryCapture?: boolean;
  items?: JsonObject[]; batches: Batch[]; coverage?: string; orderReliable?: boolean; observedAt?: string; warning?: string;
  readCount?: number;
}
interface Checkpoint {
  version: 1; id: string; user: string; fingerprint: string; platform: string; mode: string; limit: number;
  status: string; createdAt: string; updatedAt: string; sources: Source[];
}
const obj = (value: unknown): JsonObject => isJsonObject(value) ? value : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
function result(envelope: AgentEnvelope): JsonObject {
  const data = obj(envelope.data), run = obj(envelope.run ?? data.run);
  return obj(data.result ?? run.data ?? run.result ?? data);
}
const terminal = (value: AgentEnvelope) => runFromEnvelope(value)?.status || value.status || 'succeeded';

/** 固定任务、固定批次；先落本机检查点，再调用会产生副作用的接口。 */
export async function synchronize(client: AgentApiClient, options: SyncOptions,
  progress: (stage: string, data: JsonObject) => void, local = new RestrictedLocalAdapter()): Promise<JsonObject> {
  if (!['douyin', 'bilibili', 'all'].includes(options.platform) || !['like', 'collect', 'all'].includes(options.mode)
    || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) throw usageError('平台 douyin/bilibili/all，来源 like/collect/all，条数 1–500');
  if (options.resume && !/^sync-[a-f0-9-]{36}$/u.test(options.resume)) throw usageError('同步任务 ID 无效');
  const caps = await checkRecapCapabilities(client), identity = caps.user_hash;
  if (!identity) throw new CliError('INVALID_OUTPUT', '服务未提供账号绑定标识');
  if (!caps.actions.some(action => action.id === 'library.sync.progress')) throw new CliError('UPDATE_REQUIRED', '请更新知萃服务以使用可续跑同步');
  const namespace = createHash('sha256').update(`${client.options.baseUrl}:${client.options.credentials.profile}:${identity}`).digest('hex');
  const directory = join(configRoot(), 'sync', namespace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const read = async (id: string): Promise<Checkpoint> => {
    const value = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')) as Checkpoint;
    if (value.version !== 1 || value.user !== identity || value.id !== id) throw new CliError('LOCAL_USER_MISMATCH', '同步检查点不属于当前账号');
    return value;
  };
  let resumed: Checkpoint | undefined;
  if (options.resume) {
    try { resumed = await read(options.resume); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError('RESOURCE_NOT_FOUND', '本机没有该同步检查点，请在发起任务的配置下续跑');
      throw error;
    }
  }
  const fingerprint = resumed?.fingerprint || createHash('sha256').update(JSON.stringify([options.platform, options.mode, options.limit])).digest('hex');
  const invokedAt = Date.now();
  return withOwnedCredentialGate(join(directory, `${fingerprint}.lock`), async () => {
    let task = resumed && await read(resumed.id);
    if (!task) {
      const candidates: Checkpoint[] = [];
      for (const file of await readdir(directory)) {
        if (!/^sync-[a-f0-9-]{36}\.json$/u.test(file)) continue;
        const candidate = await read(file.slice(0, -5));
        const unfinished = candidate.status !== 'completed' && (candidate.status !== 'partial' || candidate.sources.some(source => !source.items || source.batches.some(batch => batch.failed)));
        if (candidate.fingerprint === fingerprint && (unfinished || Date.parse(candidate.updatedAt) >= invokedAt)) candidates.push(candidate);
      }
      task = candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }
    if (!task) {
      const platforms = options.platform === 'all' ? ['douyin', 'bilibili'] : [options.platform];
      const modes = options.mode === 'all' ? ['like', 'collect'] : [options.mode];
      task = { version: 1, id: `sync-${randomUUID()}`, user: identity, fingerprint, platform: options.platform,
        mode: options.mode, limit: options.limit, createdAt: new Date().toISOString(), updatedAt: '', status: 'restoring',
        sources: platforms.flatMap(platform => modes.map(mode => ({ platform, mode, attempt: 0, batches: [] }))) };
    }
    const current = task;
    const save = async () => {
      current.updatedAt = new Date().toISOString();
      const path = join(directory, `${current.id}.json`), temp = `${path}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(current), { mode: 0o600 });
      await rename(temp, path);
    };
    const counts = (): JsonObject => {
      const outputs = current.sources.flatMap(source => source.batches.map(batch => batch.result || {}));
      const count = (key: string) => outputs.reduce((sum, value) => sum + Number(value[key] || 0), 0);
      return { task_id: current.id, platform: current.platform, mode: current.mode, stage: current.status,
        requested: current.limit * current.sources.length, read: current.sources.reduce((sum, source) => sum + (source.items?.length || source.readCount || 0), 0),
        saved: count('accepted'), created: count('created'), reused: count('reused'), skipped: count('skipped'), failed: count('failed'),
        coverage: current.sources.every(source => source.coverage === 'complete') ? 'complete' : current.sources.some(source => source.coverage === 'partial' || !source.items) ? 'partial' : 'limited',
        batch_ids: outputs.map(value => str(value.sync_run_id)).filter(Boolean) };
    };
    const verify = async () => {
      const value = await client.capabilities();
      if (value.user_hash !== identity) throw new CliError('LOCAL_USER_MISMATCH', '账号已切换，原任务已暂停');
      if (!['library.activity.record', 'library.sync.progress', 'local.platform.sync'].every(id => value.actions.some(a => a.id === id))) throw new CliError('SCOPE_DENIED', '同步授权已撤销或权限不足');
      return value;
    };
    let lastReport = 0;
    // 心跳与阶段更新串行发送，旧心跳不能在完成回包之后覆盖最终状态。
    let reporting: Promise<unknown> = Promise.resolve();
    const publish = () => {
      const operation = reporting.then(async () => {
        await verify();
        return client.invoke('library.sync.progress', counts());
      });
      reporting = operation.catch(() => undefined);
      return operation;
    };
    const report = async (stage: string, extra: JsonObject = {}, force = true) => {
      current.status = stage;
      await save();
      const data = { ...counts(), ...extra, resume_command: `zhicui sync resume ${current.id}` };
      progress(`sync.${stage}`, data);
      if (force || Date.now() - lastReport > 20_000) {
        await publish();
        lastReport = Date.now();
      }
    };
    const response = (): JsonObject => ({ ...counts(), run_id: current.id, completed: current.status === 'completed',
      resume_command: `zhicui sync resume ${current.id}`, observed_at: current.createdAt,
      sources: current.sources.map(source => ({ platform: source.platform, mode: source.mode, read: source.items?.length || 0,
        coverage: source.coverage || 'partial', order_reliable: source.orderReliable || false, warning: source.warning || '',
        items: source.items || [], batches: source.batches.map(batch => ({ run_id: batch.run || '', ...batch.result })) })),
      message: '已同步最近清单；首次同步日期不等于平台点赞日期。同步不等待下载或提取文稿。' });
    if (current.status === 'completed') return response();
    const deadline = Date.now() + options.timeoutMs;
    const budget = () => {
      if (Date.now() >= deadline) throw new CliError(current.status === 'waiting_for_user' ? 'WAITING_FOR_USER' : 'TIMEOUT', '任务进度已保存，可继续原任务');
      return deadline - Date.now();
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatBusy = false;
    let invalidated: unknown;
    try {
      await report('restoring');
      const connected = await local.ensureConnected(identity);
      if (!connected.available) throw new CliError(str(connected.code) || 'DESKTOP_BRIDGE_UNAVAILABLE', str(connected.message) || '本机连接未就绪');
      if (Number(connected.max_sync_items || 100) < current.limit) throw new CliError('DESKTOP_UPDATE_REQUIRED', '已安装客户端版本过旧，请升级后续跑同一任务');
      // 平台读取较久也更新云端心跳；接口撤销或账号切换会停止后续保存。
      heartbeat = setInterval(() => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void publish().catch(error => {
          if (error instanceof CliError && ['LOCAL_USER_MISMATCH', 'SCOPE_DENIED', 'INVALID_CREDENTIAL', 'CREDENTIAL_REVOKED', 'AUTH_REQUIRED'].includes(error.code)) invalidated = error;
        }).finally(() => { heartbeatBusy = false; });
      }, 20_000);
      const callLocal = async (id: string, input: JsonObject, key?: string) => {
        if (invalidated) throw invalidated;
        const latest = await verify(), action = latest.actions.find(a => a.id === id);
        if (!action) throw new CliError('SCOPE_DENIED', '缺少本机同步权限');
        return local.invoke(action, input, budget(), key, identity);
      };
      for (const source of current.sources) {
        if (!source.items) {
          await report('reading', { active_platform: source.platform, active_mode: source.mode });
          if (source.retryCapture) {
            source.attempt++;
            delete source.localRun;
            delete source.retryCapture;
            progress('sync.rereading', { run_id: current.id, message: '上次平台读取已中断，将重新分页读取并按作品 ID 去重，不沿用失效游标。' });
            await save();
          }
          let envelope = source.localRun
            ? await callLocal('local.platform.status', { platform: source.platform, run_id: source.localRun })
            : await callLocal('local.platform.sync', { platform: source.platform, mode: source.mode, limit: current.limit }, `${current.id}-${source.platform}-${source.mode}-${source.attempt}`);
          if (source.localRun && obj(envelope.data).status === 'idle') {
            // 客户端的保留记录已清理；下次从清单重新读取，仍复用原云端任务。
            source.retryCapture = true;
            await save();
            throw new CliError('LOCAL_CAPTURE_INTERRUPTED', '本机采集记录已过期，续跑将重新读取清单并去重');
          }
          let job = obj(envelope.data);
          const id = str(job.run_id || envelope.run_id);
          if (!id || (source.localRun && source.localRun !== id)) throw new CliError('LOCAL_ACTION_CHANGED', '本机任务记录不可用，请恢复原客户端');
          source.localRun = id;
          await save();
          let previous = '';
          while (!isTerminalStatus(str(job.status)) || (job.status === 'succeeded' && !job.result)) {
            source.readCount = Math.min(current.limit, Math.max(0, Number(job.read_count || 0)));
            const key = `${job.status}:${job.stage}:${job.message}`;
            if (key !== previous) {
              await report(job.stage === 'needs-action' ? 'waiting_for_user' : 'reading', { local_run_id: id, message: str(job.message) });
              previous = key;
            }
            await delay(Math.min(1000, budget()));
            envelope = await callLocal('local.platform.status', { platform: source.platform, run_id: id });
            job = obj(envelope.data);
            if (job.run_id !== id) throw new CliError('LOCAL_ACTION_CHANGED', '本机任务记录已变化');
          }
          const captured = obj(job.result);
          if (job.status !== 'succeeded' || captured.success !== true) {
            source.retryCapture = true;
            await save();
            throw new CliError(str(captured.code) || 'PLATFORM_SYNC_FAILED', str(captured.error || job.message) || '平台读取未完成');
          }
          const items = collectedItems(captured, source.platform, current.limit);
          if (!items.length && captured.coverage !== 'complete') throw new CliError('EMPTY_SYNC_UNCONFIRMED', '没有确认清单为空，请完成平台验证后续跑');
          source.items = items;
          source.coverage = ['complete', 'limited', 'partial'].includes(str(captured.coverage)) ? str(captured.coverage) : 'partial';
          source.orderReliable = captured.orderReliable === true;
          source.observedAt = new Date().toISOString();
          source.warning = str(captured.warning);
          source.batches = Array.from({ length: Math.ceil(items.length / 100) }, (_, index) => ({ offset: index * 100, attempt: 0 }));
          await save();
        }
        for (const batch of source.batches) {
          if (batch.result && !Number(batch.result.failed || 0)) continue;
          // 只在服务端明确失败后创建下一次尝试；网络超时仍查询/重放原批次。
          if (batch.failed) { batch.attempt++; delete batch.run; delete batch.failed; delete batch.result; await save(); }
          await report('saving', { active_platform: source.platform, active_mode: source.mode });
          await verify();
          let saved = batch.run ? await client.getRun(batch.run, budget())
            : await client.invoke('library.activity.record', { task_id: current.id, platform: source.platform, mode: source.mode,
              items: source.items!.slice(batch.offset, batch.offset + 100), source_rank_offset: batch.offset,
              coverage: source.coverage || 'partial', order_reliable: source.orderReliable === true },
            `${current.id}-${source.platform}-${source.mode}-batch-${batch.offset}-${batch.attempt}`);
          batch.run = runIdOf(runFromEnvelope(saved)) || str(saved.run_id);
          await save();
          while (!isTerminalStatus(terminal(saved))) {
            if (!batch.run) throw new CliError('INVALID_OUTPUT', '保存接口未提供运行标识');
            await delay(Math.min(1000, budget()));
            await verify();
            saved = await client.getRun(batch.run, budget());
          }
          if (terminal(saved) !== 'succeeded' || saved.error) {
            batch.failed = true; await save();
            throw new CliError('SYNC_SAVE_FAILED', '该批保存未完成，续跑时保留其他已成功批次');
          }
          batch.result = result(saved);
          batch.failed = Number(batch.result.failed || 0) > 0;
          await report('saving');
        }
      }
      const partial = current.sources.some(source => source.coverage === 'partial' || source.batches.some(batch => batch.failed));
      await report(partial ? 'partial' : 'completed');
      return response();
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      if (error instanceof CliError && ['LOCAL_USER_MISMATCH', 'SCOPE_DENIED', 'INVALID_CREDENTIAL', 'CREDENTIAL_REVOKED', 'AUTH_REQUIRED'].includes(error.code)) {
        const cancel = caps.actions.find(action => action.id === 'local.platform.cancel');
        if (cancel) for (const source of current.sources.filter(item => item.localRun && !item.items)) {
          // 只取消此任务的本机读取；已切账号时桌面身份校验会拒绝，不碰新账号任务。
          await local.invoke(cancel, { run_id: source.localRun! }, 3000, undefined, identity).catch(() => undefined);
        }
      }
      current.status = current.status === 'waiting_for_user' ? current.status : 'paused';
      await save();
      await publish().catch(() => undefined);
      const failure = error instanceof CliError ? error : new CliError('SYNC_INTERRUPTED', '同步已暂停，检查点已保存');
      throw new CliError(failure.code, failure.message, { details: { ...(isJsonObject(failure.details) ? failure.details : {}),
        run_id: current.id, resume_command: `zhicui sync resume ${current.id}`, progress: counts() } });
    } finally { if (heartbeat) clearInterval(heartbeat); }
  }, options.timeoutMs);
}
