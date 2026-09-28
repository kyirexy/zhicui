import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiClient, runFromEnvelope, runIdOf } from './api-client.js';
import { CliError, usageError } from './errors.js';
import { RestrictedLocalAdapter } from './local-adapter.js';
import { isJsonObject, isTerminalStatus, type AgentCapabilities, type AgentEnvelope, type JsonObject } from './types.js';

export const RECAP_SCOPES = ['account:read', 'library:read', 'library:write', 'local:invoke', 'ask:read', 'ask:run'];
const REQUIRED = ['library.recap.get', 'library.activity.record', 'local.platform.status', 'local.platform.sync'];
function object(value: unknown): JsonObject { return isJsonObject(value) ? value : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function result(envelope: AgentEnvelope): JsonObject {
  const data = object(envelope.data), run = object(envelope.run ?? data.run);
  return object(data.result ?? run.data ?? run.result ?? data);
}

export async function checkRecapCapabilities(client: AgentApiClient): Promise<AgentCapabilities> {
  const capabilities = await client.capabilities();
  if (capabilities.feature_enabled === false) throw new CliError('INTERFACE_DISABLED', '知萃接入暂不可用，请稍后重试');
  const missing = REQUIRED.filter(id => !capabilities.actions.some(action => action.id === id));
  if (missing.length) {
    const published = await client.publicCapabilities();
    const available = object(published.data ?? published);
    const ids = Array.isArray(available.actions) ? available.actions.map(value => object(value).id) : [];
    const scopeMissing = missing.every(id => ids.includes(id));
    throw new CliError(scopeMissing ? 'SCOPE_DENIED' : 'ACTION_NOT_AVAILABLE', scopeMissing
      ? '同步需要本机调用与资料整理授权，请加 --connect 并在浏览器确认'
      : '当前服务尚未开放完整回顾流程，请更新知萃后重试', { details: { missing_actions: missing } });
  }
  return capabilities;
}

export interface RecapOptions {
  day: string;
  platform: string;
  mode: string;
  timezone: string;
  limit: number;
  timeoutMs: number;
}

/** 只投影公开文本与规范作品 ID，不传平台凭据、封面签名或媒体地址。 */
export function collectedItems(value: JsonObject, platform: string, limit: number): JsonObject[] {
  const items = new Map<string, JsonObject>();
  const pattern = platform === 'douyin' ? /^\d{5,32}$/u : /^BV[0-9A-Za-z]{3,30}$/u;
  for (const raw of Array.isArray(value.items) ? value.items : []) {
    const item = object(raw), id = text(item.videoId);
    if (!pattern.test(id)) throw new CliError('INVALID_OUTPUT', '本机采集返回了与平台不符的作品');
    items.set(id, { video_id: id, title: text(item.title).slice(0, 500),
      author_name: text(item.authorName).slice(0, 200), caption: text(item.caption).slice(0, 2000) });
  }
  for (const raw of Array.isArray(value.urls) ? value.urls : []) {
    let url: URL;
    try { url = new URL(text(raw)); } catch { throw new CliError('INVALID_OUTPUT', '采集作品链接无效'); }
    const host = platform === 'douyin' ? 'www.douyin.com' : 'www.bilibili.com';
    const id = /^\/video\/([A-Za-z0-9]+)\/?$/u.exec(url.pathname)?.[1] || '';
    if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password || !pattern.test(id)) {
      throw new CliError('INVALID_OUTPUT', '采集结果包含非官方作品链接');
    }
    if (!items.has(id)) items.set(id, { video_id: id });
  }
  if (items.size > limit) throw new CliError('INVALID_OUTPUT', '采集返回条数超过本次请求上限');
  return [...items.values()];
}

export async function refreshRecap(
  client: AgentApiClient, options: RecapOptions,
  progress: (stage: string, data: JsonObject) => void,
  local = new RestrictedLocalAdapter(),
): Promise<JsonObject> {
  if (!['today', 'yesterday'].includes(options.day) || !['like', 'collect', 'all'].includes(options.mode)
      || !['douyin', 'bilibili', 'all'].includes(options.platform) || !Number.isInteger(options.limit)
      || options.limit < 1 || options.limit > 100) throw usageError('日期 today/yesterday，平台 douyin/bilibili/all，来源 like/collect/all，条数 1–100');
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: options.timezone }).format(); }
  catch { throw usageError('时区无效'); }
  const capabilities = await checkRecapCapabilities(client);
  const identity = capabilities.user_hash;
  const available = await local.status(identity);
  if (!available.available) throw new CliError(text(available.code) || 'DESKTOP_BRIDGE_UNAVAILABLE', '请启动知萃桌面客户端并登录同一账号，再同步回顾');
  const deadline = Date.now() + options.timeoutMs;
  let activeRun: JsonObject = {};
  const budget = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CliError('TIMEOUT', '同步回顾超时；已保存资料会保留，请按返回的 Run ID 查询进度', { details: activeRun });
    return remaining;
  };
  const callLocal = async (id: string, input: JsonObject): Promise<AgentEnvelope> => {
    // 每一步重新校验当前身份与权限，避免中途切换账号、撤销授权后继续同步。
    const current = await client.capabilities();
    if (current.user_hash !== identity) throw new CliError('LOCAL_USER_MISMATCH', '账号已切换，请重新开始回顾');
    const action = current.actions.find(item => item.id === id);
    if (!action) throw new CliError('SCOPE_DENIED', '当前授权已不能执行平台同步');
    return local.invoke(action, input, budget(), undefined, identity);
  };
  const platforms = options.platform === 'all' ? ['douyin', 'bilibili'] : [options.platform];
  const modes = options.mode === 'all' ? ['like', 'collect'] : [options.mode];
  const synced: JsonObject[] = [], warnings: JsonObject[] = [];
  for (const platform of platforms) {
    for (const mode of modes) {
      progress('sync.starting', { platform, mode, limit: options.limit });
      let localRunId = '';
      try {
        const started = await callLocal('local.platform.sync', { platform, mode, limit: options.limit });
        localRunId = text(started.run_id) || text(object(started.data).run_id);
        if (!localRunId) throw new CliError('INVALID_OUTPUT', '本机同步未返回运行标识');
        activeRun = { run_id: localRunId, execution_location: 'local_windows', platform };
        let job = object(started.data), previous = '';
        while (!isTerminalStatus(text(job.status)) || (job.status === 'succeeded' && !job.result)) {
          budget();
          const message = text(job.message);
          if (message !== previous) {
            progress('sync.progress', { platform, mode, run_id: localRunId, status: text(job.status), message });
            previous = message;
          }
          if (job.status === 'waiting_for_user' && job.stage !== 'browser-open') {
            throw new CliError('WAITING_FOR_USER', message || '请在知萃的平台窗口完成验证', { details: { platform, run_id: localRunId } });
          }
          await delay(Math.min(1000, budget()));
          const current = await callLocal('local.platform.status', { platform });
          job = object(current.data);
          if (job.run_id !== localRunId) throw new CliError('LOCAL_ACTION_CHANGED', '本机同步任务已被其他操作替换，请查看客户端');
        }
        const captured = object(job.result);
        if (job.status !== 'succeeded' || captured.success !== true) {
          throw new CliError(text(captured.code) || 'PLATFORM_SYNC_FAILED', text(captured.error) || text(job.message) || '平台同步未完成');
        }
        const items = collectedItems(captured, platform, options.limit);
        if (!items.length) throw new CliError('EMPTY_SYNC_UNCONFIRMED', '本机没有返回可确认的作品，不能据此认定列表为空');
        progress('sync.saving', { platform, mode, total: items.length });
        const current = await client.capabilities();
        if (current.user_hash !== identity) throw new CliError('LOCAL_USER_MISMATCH', '账号已切换，未保存其他账号的采集结果');
        let saved = await client.invoke('library.activity.record', { platform, mode, items }, `recap-${localRunId}-${randomUUID()}`);
        const runId = runIdOf(runFromEnvelope(saved)) || text(saved.run_id);
        activeRun = { run_id: runId, execution_location: 'cloud' };
        while (!isTerminalStatus(runFromEnvelope(saved)?.status || saved.status)) {
          if (!runId) throw new CliError('INVALID_OUTPUT', '清单保存未返回运行标识');
          progress('sync.saving', { platform, mode, run_id: runId, total: items.length });
          await delay(Math.min(1000, budget()));
          saved = await client.getRun(runId, budget());
        }
        const output = result(saved);
        if ((runFromEnvelope(saved)?.status || saved.status) !== 'succeeded' || saved.error || !(Number(output.accepted) + Number(output.skipped || 0))) {
          throw new CliError('SYNC_SAVE_FAILED', '平台清单未能保存，请查询该运行', { details: { run_id: runId } });
        }
        synced.push({ platform, mode, run_id: runId, accepted: output.accepted, created: output.created ?? 0,
          reused: output.reused ?? 0, ready: output.ready ?? 0, failed: output.failed ?? 0, coverage: 'partial' });
        if (Number(output.failed) > 0) warnings.push({ platform, mode, code: 'PARTIAL_SAVE', message: '部分作品未保存' });
        progress('sync.saved', synced[synced.length - 1]);
      } catch (error) {
        if (!(error instanceof CliError)) throw error;
        if (['WAITING_FOR_USER', 'TIMEOUT', 'LOCAL_USER_MISMATCH', 'SCOPE_DENIED', 'AUTH_REQUIRED', 'INVALID_CREDENTIAL', 'LOCAL_ACTION_BUSY'].includes(error.code)) throw error;
        warnings.push({ platform, mode, run_id: localRunId, code: error.code, message: error.message });
        progress('sync.warning', warnings[warnings.length - 1]);
        // 登录失效、风控或采集失败后不再尝试同一平台的另一来源。
        break;
      }
    }
  }
  if (!synced.length) throw new CliError('SYNC_FAILED', '平台同步未成功，不能把旧记录当作最新回顾', { details: { warnings } });
  progress('recap.reading', { day: options.day });
  const current = await client.capabilities();
  if (current.user_hash !== identity) throw new CliError('LOCAL_USER_MISMATCH', '账号已切换，请重新查询回顾');
  const recap = result(await client.invoke('library.recap.get', { day: options.day, timezone: options.timezone,
    mode: options.mode, platform: options.platform, limit: 100 }));
  return { ...recap, sync: { completed: warnings.length === 0, sources: synced, warnings, requested_limit: options.limit },
    message: '已先同步最近清单。回顾按首次同步日期统计；今天补发现的旧视频不会被归为昨天点赞。' };
}
