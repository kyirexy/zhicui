import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { dialog, type BrowserWindow } from 'electron';
import type {
  PlatformAccountCollectRequest,
  PlatformAccountProvider,
  PlatformAccountRequest,
  PlatformAccountResult,
  PlatformAccountStatus,
  DesktopMediaSettings,
} from './contract';
import type { DesktopMediaLibrary } from './media-library';
import type { PlatformAccountConnector } from './platform-account';
import { desktopUserHash } from './desktop-core';
import { supportsDesktopBridge } from './platform-runtime';
import {
  validateAwemeId,
  validatePlatformAccountCollectRequest,
  validatePlatformAccountRequest,
} from './security';
import {
  checkForDesktopUpdates,
  getDesktopUpdateState,
  installDesktopUpdate,
} from './updater';

const BRIDGE_API_VERSION = 'v1' as const;
const DESCRIPTOR_FILE = 'desktop-agent-bridge.json';
const DESCRIPTOR_TTL_MS = 60 * 60 * 1000;
const DESCRIPTOR_REFRESH_MS = 20 * 60 * 1000;
const MAX_REQUEST_BYTES = 64 * 1024;

const LOCAL_ACTIONS = Object.freeze([
  'local.status',
  'local.capabilities.get',
  'local.platform.login',
  'local.platform.status',
  'local.platform.sync',
  'local.platform.collect',
  'local.platform.cancel',
  'local.platform.disconnect',
  'local.platform.logout',
  'local.platform.rebind',
  'local.media.settings.get',
  'local.media.directory.choose',
  'local.media.delete',
  'local.media.open',
  'local.client.update.check',
  'local.client.update.install',
  'local.update.check',
  'local.update.install',
]);

type LocalRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'canceled';

type JsonRecord = Record<string, unknown>;

interface PlatformJob {
  runId: string;
  action: string;
  key: string;
  platform: PlatformAccountProvider;
  status: LocalRunStatus;
  stage: PlatformAccountStatus['stage'];
  message: string;
  startedAt: string;
  updatedAt: string;
  result?: PlatformAccountResult;
}

interface LocalUiJob {
  runId: string;
  action: string;
  status: LocalRunStatus;
  message: string;
  startedAt: string;
  updatedAt: string;
  data?: JsonRecord;
}

interface BridgeDescriptor {
  api_version: typeof BRIDGE_API_VERSION;
  url: string;
  token: string;
  user_hash: string;
  expires_at: string;
}

export interface DesktopAgentActionBridgeOptions {
  descriptorDirectory: string;
  version: string;
  channel: string;
  platformAccounts: PlatformAccountConnector;
  getMediaLibrary: () => DesktopMediaLibrary | null;
  getWindow: () => BrowserWindow | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function safeError(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = String(candidate?.code || 'LOCAL_ACTION_FAILED')
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 64) || 'LOCAL_ACTION_FAILED';
  const message = String(candidate?.message || error || '本机 Action 执行失败')
    .split(/\r?\n/, 1)[0]
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[本机路径]')
    .replace(/((?:cookie|jwt|api[_-]?key|token))\s*[=:]\s*[^\s;,]+/gi, '$1=[已隐藏]')
    .slice(0, 220);
  return { code, message: message || '本机 Action 执行失败' };
}

function platformKey(request: PlatformAccountRequest): string {
  return `${request.profileKey}:${request.platform}`;
}

function platformRequest(input: JsonRecord, activeProfileKey: string): PlatformAccountRequest {
  rejectExtraKeys(input, ['platform', 'profile_key', 'profileKey']);
  const requestedProfileKey = String(input.profile_key || input.profileKey || '').trim();
  if (requestedProfileKey && desktopUserHash(requestedProfileKey) !== desktopUserHash(activeProfileKey)) {
    const error = new Error('本机 Agent 与桌面端当前登录账号不一致') as Error & { code: string };
    error.code = 'LOCAL_USER_MISMATCH';
    throw error;
  }
  return validatePlatformAccountRequest({
    platform: String(input.platform || '') as PlatformAccountProvider,
    profileKey: activeProfileKey,
  });
}

function collectRequest(input: JsonRecord, activeProfileKey: string): PlatformAccountCollectRequest {
  rejectExtraKeys(input, ['platform', 'profile_key', 'profileKey', 'mode', 'limit']);
  return validatePlatformAccountCollectRequest({
    ...platformRequest({
      platform: input.platform,
      profile_key: input.profile_key || input.profileKey,
    }, activeProfileKey),
    mode: String(input.mode || '') as PlatformAccountCollectRequest['mode'],
    limit: Number(input.limit),
  });
}

function mediaId(input: JsonRecord): string {
  rejectExtraKeys(input, ['aweme_id', 'awemeId']);
  return validateAwemeId(input.aweme_id || input.awemeId);
}

function rejectExtraKeys(input: JsonRecord, allowed: string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(input).some((key) => !allow.has(key))) {
    const error = new Error('本机 Action 输入包含未允许字段') as Error & { code: string };
    error.code = 'INVALID_INPUT';
    throw error;
  }
}

function publicMediaSettings(settings: DesktopMediaSettings): JsonRecord {
  return {
    auto_save_on_play: settings.autoSaveOnPlay,
    directory_configured: Boolean(settings.directory),
    using_default_directory: settings.directory === settings.defaultDirectory,
  };
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function secureTokenEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_REQUEST_BYTES) {
      const error = new Error('本机 Action 请求过大') as Error & { code: string };
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
  const body = record(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('本机 Action 请求必须是 JSON 对象') as Error & { code: string };
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const input = body.input ?? {};
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    const error = new Error('本机 Action input 必须是 JSON 对象') as Error & { code: string };
    error.code = 'INVALID_INPUT';
    throw error;
  }
  rejectExtraKeys(body, ['input']);
  return input as JsonRecord;
}

export class DesktopAgentActionBridge {
  private server: Server | null = null;
  private token = '';
  private tokenExpiresAt = 0;
  private descriptor: BridgeDescriptor | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private activePlatformJob: PlatformJob | null = null;
  private activeUiJob: LocalUiJob | null = null;
  private activeProfileKey = '';
  private bindQueue: Promise<void> = Promise.resolve();
  private readonly latestPlatformJobs = new Map<string, PlatformJob>();

  constructor(private readonly options: DesktopAgentActionBridgeOptions) {}

  async start(): Promise<boolean> {
    if (!supportsDesktopBridge(process.platform) || this.server) return false;
    this.token = randomBytes(32).toString('base64url');
    this.tokenExpiresAt = Date.now() + DESCRIPTOR_TTL_MS;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as AddressInfo;
    this.descriptor = {
      api_version: BRIDGE_API_VERSION,
      url: `http://127.0.0.1:${address.port}`,
      token: this.token,
      user_hash: '',
      expires_at: new Date(Date.now() + DESCRIPTOR_TTL_MS).toISOString(),
    };
    if (this.activeProfileKey) {
      this.descriptor.user_hash = desktopUserHash(this.activeProfileKey);
      await this.writeDescriptor();
    }
    this.refreshTimer = setInterval(() => {
      if (!this.descriptor || !this.activeProfileKey) return;
      this.token = randomBytes(32).toString('base64url');
      this.tokenExpiresAt = Date.now() + DESCRIPTOR_TTL_MS;
      this.descriptor.token = this.token;
      this.descriptor.expires_at = new Date(this.tokenExpiresAt).toISOString();
      void this.writeDescriptor();
    }, DESCRIPTOR_REFRESH_MS);
    this.refreshTimer.unref?.();
    return true;
  }

  bindUser(profileKey: string | null): Promise<boolean> {
    const operation = this.bindQueue.then(() => this.applyUserBinding(profileKey));
    this.bindQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async applyUserBinding(profileKey: string | null): Promise<boolean> {
    const normalized = String(profileKey || '').trim();
    if (normalized) {
      validatePlatformAccountRequest({ platform: 'douyin', profileKey: normalized });
    }
    if (normalized === this.activeProfileKey) return true;

    if (this.activePlatformJob && !['succeeded', 'failed', 'canceled'].includes(this.activePlatformJob.status)) {
      await this.options.platformAccounts.cancel().catch(() => undefined);
      this.activePlatformJob.status = 'canceled';
      this.activePlatformJob.stage = 'cancelled';
      this.activePlatformJob.message = '知萃账号已切换，本机平台操作已取消';
      this.activePlatformJob.updatedAt = new Date().toISOString();
    }
    if (this.activeUiJob && !['succeeded', 'failed', 'canceled'].includes(this.activeUiJob.status)) {
      this.activeUiJob.status = 'canceled';
      this.activeUiJob.message = '知萃账号已切换，本机用户交互已取消';
      this.activeUiJob.updatedAt = new Date().toISOString();
    }
    this.activeUiJob = null;

    if (!normalized && this.descriptor) {
      await this.removeOwnedDescriptor();
    }
    this.options.getMediaLibrary()?.bindProfile(normalized || null);
    this.activeProfileKey = normalized;
    this.token = randomBytes(32).toString('base64url');
    this.tokenExpiresAt = Date.now() + DESCRIPTOR_TTL_MS;
    if (!this.descriptor) return true;
    this.descriptor.token = this.token;
    this.descriptor.user_hash = normalized ? desktopUserHash(normalized) : '';
    this.descriptor.expires_at = new Date(this.tokenExpiresAt).toISOString();
    if (!normalized) {
      return true;
    }
    await this.writeDescriptor();
    return true;
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await this.removeOwnedDescriptor();
    this.descriptor = null;
    this.token = '';
    this.tokenExpiresAt = 0;
    if (this.activeUiJob && !['succeeded', 'failed', 'canceled'].includes(this.activeUiJob.status)) {
      this.activeUiJob.status = 'canceled';
      this.activeUiJob.message = '知萃客户端已退出，本机用户交互已取消';
      this.activeUiJob.updatedAt = new Date().toISOString();
    }
    this.activeUiJob = null;
    this.options.getMediaLibrary()?.bindProfile(null);
  }

  recordPlatformStatus(status: PlatformAccountStatus): void {
    const job = this.activePlatformJob;
    if (!job || job.platform !== status.platform) return;
    job.stage = status.stage;
    job.message = status.message;
    job.updatedAt = new Date().toISOString();
    if (status.stage === 'browser-open' || status.stage === 'waiting' || status.stage === 'needs-action') {
      job.status = 'waiting_for_user';
    } else if (status.stage === 'success') {
      job.status = 'succeeded';
    } else if (status.stage === 'cancelled') {
      job.status = 'canceled';
    } else if (status.stage === 'error') {
      job.status = 'failed';
    } else {
      job.status = 'running';
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const actionMatch = request.url?.match(/^\/v1\/actions\/([^/?]+)\/invoke$/);
    if (!isLoopback(request.socket.remoteAddress)) {
      response.destroy();
      return;
    }
    if (request.method !== 'POST' || !actionMatch) {
      sendJson(response, 404, this.envelope('local.unknown', requestId, 'failed', null, {
        code: 'ACTION_NOT_FOUND', message: '本机 Action 不存在',
      }));
      return;
    }
    const providedToken = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (
      !providedToken
      || Date.now() >= this.tokenExpiresAt
      || !secureTokenEqual(this.token, providedToken)
    ) {
      sendJson(response, 401, this.envelope('local.unknown', requestId, 'failed', null, {
        code: 'LOCAL_AUTH_INVALID', message: '本机桥接凭证无效或已过期',
      }));
      return;
    }
    const action = actionMatch[1];
    if (!(LOCAL_ACTIONS as readonly string[]).includes(action)) {
      sendJson(response, 404, this.envelope(action, requestId, 'failed', null, {
        code: 'ACTION_NOT_ALLOWED', message: '该本机 Action 不在固定白名单中',
      }));
      return;
    }
    try {
      const input = await readJsonBody(request);
      const result = await this.invoke(action, input);
      const resultRecord = record(result.data);
      const resultError = result.status === 'failed'
        ? safeError({
          code: resultRecord.code || 'LOCAL_ACTION_FAILED',
          message: resultRecord.error || resultRecord.message || '本机 Action 执行失败',
        })
        : null;
      sendJson(response, 200, this.envelope(
        action,
        requestId,
        result.status,
        result.data,
        resultError,
        result.runId,
      ));
    } catch (error) {
      const safe = safeError(error);
      sendJson(response, safe.code === 'INVALID_INPUT' ? 400 : 409, this.envelope(
        action, requestId, 'failed', null, safe,
      ));
    }
  }

  private async invoke(
    action: string,
    input: JsonRecord,
  ): Promise<{ status: LocalRunStatus; data: unknown; runId?: string }> {
    if (action === 'local.status' || action === 'local.capabilities.get') {
      rejectExtraKeys(input, []);
      return {
        status: 'succeeded',
        data: {
          available: true,
          user_bound: Boolean(this.activeProfileKey),
          user_hash: this.activeProfileKey ? desktopUserHash(this.activeProfileKey) : null,
          platform: process.platform,
          version: this.options.version,
          channel: this.options.channel,
          actions: [...LOCAL_ACTIONS],
          last_user_interaction: this.activeUiJob ? this.publicUiJob(this.activeUiJob) : null,
        },
      };
    }
    if (!this.activeProfileKey && (
      action.startsWith('local.platform.') || action.startsWith('local.media.')
    )) {
      const error = new Error('请先在知萃桌面端登录账号') as Error & { code: string };
      error.code = 'LOCAL_USER_NOT_BOUND';
      throw error;
    }
    if (action === 'local.platform.status') {
      const request = platformRequest(input, this.activeProfileKey);
      const job = this.latestPlatformJobs.get(platformKey(request));
      return {
        status: 'succeeded',
        data: job ? this.publicJob(job) : {
          platform: request.platform,
          status: 'idle',
          message: '当前没有进行中的本机平台操作',
        },
        runId: job?.runId,
      };
    }
    if (action === 'local.platform.login') {
      const request = platformRequest(input, this.activeProfileKey);
      return this.startPlatformJob(action, request, () => (
        this.options.platformAccounts.login(request)
      ), 'waiting_for_user');
    }
    if (action === 'local.platform.collect' || action === 'local.platform.sync') {
      const request = collectRequest(input, this.activeProfileKey);
      return this.startPlatformJob(action, request, () => (
        this.options.platformAccounts.collect(request)
      ), 'running');
    }
    if (action === 'local.platform.cancel') {
      rejectExtraKeys(input, []);
      const result = await this.options.platformAccounts.cancel();
      if (this.activePlatformJob) {
        this.activePlatformJob.status = 'canceled';
        this.activePlatformJob.stage = 'cancelled';
        this.activePlatformJob.message = '用户已取消本机平台操作';
        this.activePlatformJob.updatedAt = new Date().toISOString();
        this.activePlatformJob.result = result;
      }
      return { status: 'canceled', data: result, runId: this.activePlatformJob?.runId };
    }
    if (action === 'local.platform.disconnect' || action === 'local.platform.logout') {
      const request = platformRequest(input, this.activeProfileKey);
      if (!await this.confirm(
        '断开本机平台账号？',
        '这会删除当前知萃用户在这台电脑保存的平台登录会话，已有云端资料不会丢失。',
      )) return { status: 'canceled', data: { canceled: true } };
      const result = await this.options.platformAccounts.disconnect(request);
      return { status: result.success ? 'succeeded' : 'failed', data: result };
    }
    if (action === 'local.platform.rebind') {
      const request = platformRequest(input, this.activeProfileKey);
      return this.startPlatformJob(action, request, async () => {
        const disconnected = await this.options.platformAccounts.disconnect(request);
        if (!disconnected.success) return disconnected;
        return this.options.platformAccounts.login(request);
      }, 'waiting_for_user');
    }
    const mediaLibrary = this.options.getMediaLibrary();
    if (action.startsWith('local.media.') && !mediaLibrary) {
      const error = new Error('本地媒体服务尚未就绪') as Error & { code: string };
      error.code = 'LOCAL_CAPABILITY_UNAVAILABLE';
      throw error;
    }
    if (action === 'local.media.settings.get') {
      rejectExtraKeys(input, []);
      return { status: 'succeeded', data: publicMediaSettings(mediaLibrary!.getSettings()) };
    }
    if (action === 'local.media.directory.choose') {
      rejectExtraKeys(input, []);
      return this.startUiJob(
        action,
        '等待用户在知萃桌面端选择本地保存目录',
        async () => {
          const before = mediaLibrary!.getSettings().directory;
          const settings = await mediaLibrary!.chooseDirectory(this.options.getWindow());
          const changed = settings.directory !== before;
          return {
            status: changed ? 'succeeded' : 'canceled',
            message: changed ? '本地保存目录已更新' : '用户已取消目录选择',
            data: publicMediaSettings(settings),
          };
        },
      );
    }
    if (action === 'local.media.open') {
      const awemeId = mediaId(input);
      if (mediaLibrary!.getAsset(awemeId).status !== 'cached') {
        const error = new Error('当前知萃账号没有这个本机视频文件') as Error & {
          code: string;
        };
        error.code = 'LOCAL_MEDIA_NOT_OWNED';
        throw error;
      }
      const opened = await mediaLibrary!.reveal(awemeId);
      return { status: opened ? 'succeeded' : 'failed', data: { aweme_id: awemeId, opened } };
    }
    if (action === 'local.media.delete') {
      const awemeId = mediaId(input);
      if (mediaLibrary!.getAsset(awemeId).status !== 'cached') {
        const error = new Error('当前知萃账号没有这个本机视频文件') as Error & {
          code: string;
        };
        error.code = 'LOCAL_MEDIA_NOT_OWNED';
        throw error;
      }
      if (!await this.confirm(
        '删除本机视频文件？',
        '只删除这台电脑上的缓存文件；云端资料和文稿不会被删除。',
      )) return { status: 'canceled', data: { aweme_id: awemeId, canceled: true } };
      const asset = await mediaLibrary!.remove(awemeId);
      return {
        status: 'succeeded',
        data: { aweme_id: awemeId, removed: asset.status === 'remote' },
      };
    }
    if (action === 'local.update.check' || action === 'local.client.update.check') {
      rejectExtraKeys(input, []);
      return { status: 'succeeded', data: await checkForDesktopUpdates() };
    }
    if (action === 'local.update.install' || action === 'local.client.update.install') {
      rejectExtraKeys(input, []);
      const state = getDesktopUpdateState();
      if (state.status !== 'downloaded') {
        return { status: 'failed', data: { ...state, code: 'UPDATE_NOT_READY' } };
      }
      if (!await this.confirm(
        '安装知萃客户端更新？',
        '客户端会关闭并安装已经下载的更新，未发送的内容请先保存。正式发布前仍需通过代码签名验收。',
      )) return { status: 'canceled', data: { canceled: true } };
      return { status: 'succeeded', data: installDesktopUpdate() };
    }
    const error = new Error('该本机 Action 尚未实现') as Error & { code: string };
    error.code = 'ACTION_NOT_AVAILABLE';
    throw error;
  }

  private startUiJob(
    action: string,
    message: string,
    execute: () => Promise<{
      status: 'succeeded' | 'failed' | 'canceled';
      message: string;
      data: JsonRecord;
    }>,
  ): { status: 'waiting_for_user'; data: JsonRecord; runId: string } {
    if (this.activeUiJob && !['succeeded', 'failed', 'canceled'].includes(this.activeUiJob.status)) {
      const error = new Error('已有需要用户操作的本机任务正在进行') as Error & { code: string };
      error.code = 'LOCAL_ACTION_BUSY';
      throw error;
    }
    const now = new Date().toISOString();
    const job: LocalUiJob = {
      runId: randomUUID(),
      action,
      status: 'waiting_for_user',
      message,
      startedAt: now,
      updatedAt: now,
    };
    this.activeUiJob = job;
    void execute().then((completion) => {
      if (job.status === 'canceled') return;
      job.status = completion.status;
      job.message = completion.message;
      job.data = completion.data;
      job.updatedAt = new Date().toISOString();
    }).catch((error) => {
      if (job.status === 'canceled') return;
      const safe = safeError(error);
      job.status = 'failed';
      job.message = safe.message;
      job.data = { code: safe.code };
      job.updatedAt = new Date().toISOString();
    });
    return { status: 'waiting_for_user', data: this.publicUiJob(job), runId: job.runId };
  }

  private publicUiJob(job: LocalUiJob): JsonRecord {
    return {
      run_id: job.runId,
      action: job.action,
      status: job.status,
      message: job.message,
      started_at: job.startedAt,
      updated_at: job.updatedAt,
      data: job.data || null,
    };
  }

  private startPlatformJob(
    action: string,
    request: PlatformAccountRequest,
    execute: () => Promise<PlatformAccountResult>,
    initialStatus: LocalRunStatus,
  ): { status: LocalRunStatus; data: unknown; runId: string } {
    if (this.activePlatformJob && !['succeeded', 'failed', 'canceled'].includes(this.activePlatformJob.status)) {
      const error = new Error('已有平台账号操作正在进行') as Error & { code: string };
      error.code = 'LOCAL_ACTION_BUSY';
      throw error;
    }
    const now = new Date().toISOString();
    const job: PlatformJob = {
      runId: randomUUID(),
      action,
      key: platformKey(request),
      platform: request.platform,
      status: initialStatus,
      stage: initialStatus === 'waiting_for_user' ? 'waiting' : 'starting',
      message: initialStatus === 'waiting_for_user'
        ? '已打开官方登录页面，等待用户完成操作'
        : '本机平台任务已开始',
      startedAt: now,
      updatedAt: now,
    };
    this.activePlatformJob = job;
    this.latestPlatformJobs.set(job.key, job);
    void execute().then((result) => {
      job.result = result;
      job.status = result.cancelled ? 'canceled' : result.success ? 'succeeded' : 'failed';
      job.stage = result.cancelled ? 'cancelled' : result.success ? 'success' : 'error';
      job.message = result.success ? '本机平台任务已完成' : result.error || '本机平台任务失败';
      job.updatedAt = new Date().toISOString();
    }).catch((error) => {
      const safe = safeError(error);
      job.status = 'failed';
      job.stage = 'error';
      job.message = safe.message;
      job.updatedAt = new Date().toISOString();
    });
    return { status: job.status, data: this.publicJob(job), runId: job.runId };
  }

  private publicJob(job: PlatformJob): JsonRecord {
    return {
      run_id: job.runId,
      action: job.action,
      platform: job.platform,
      status: job.status,
      stage: job.stage,
      message: job.message,
      started_at: job.startedAt,
      updated_at: job.updatedAt,
      result: job.result ? {
        success: job.result.success,
        connected: job.result.connected,
        canceled: job.result.cancelled,
        code: job.result.code,
        error: job.result.error,
        count: job.result.count,
        urls: job.result.urls,
        items: job.result.items?.map(({
          ephemeralMediaUrl: _secretMediaUrl,
          coverUrl: _temporaryCoverUrl,
          ...item
        }) => ({
          ...item,
          cover_available: Boolean(_temporaryCoverUrl),
        })),
      } : null,
    };
  }

  private envelope(
    action: string,
    requestId: string,
    status: LocalRunStatus,
    data: unknown,
    error: { code: string; message: string } | null,
    runId?: string,
  ): JsonRecord {
    return {
      api_version: BRIDGE_API_VERSION,
      action,
      request_id: requestId,
      run_id: runId || null,
      status,
      data,
      error,
      meta: { execution_location: 'local_windows' },
    };
  }

  private async confirm(title: string, detail: string): Promise<boolean> {
    const owner = this.options.getWindow();
    const options = {
      type: 'warning' as const,
      title: '知萃 Agent 请求确认',
      message: title,
      detail,
      buttons: ['取消', '继续'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result = owner
      ? await dialog.showMessageBox(owner, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  }

  private descriptorPath(): string {
    return join(this.options.descriptorDirectory, DESCRIPTOR_FILE);
  }

  private async writeDescriptor(): Promise<void> {
    if (!this.descriptor) return;
    await mkdir(this.options.descriptorDirectory, { recursive: true });
    const target = this.descriptorPath();
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.descriptor), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    try {
      await rename(temporary, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM') throw error;
      await unlink(target).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await rename(temporary, target);
    }
    await chmod(target, 0o600).catch(() => undefined);
  }

  private async removeOwnedDescriptor(): Promise<void> {
    const target = this.descriptorPath();
    try {
      const current = JSON.parse(await readFile(target, 'utf8')) as Partial<BridgeDescriptor>;
      if (current.token !== this.descriptor?.token) return;
      await unlink(target);
    } catch {
      // 已由退出清理或其他实例接管时无需处理。
    }
  }
}

export const LOCAL_AGENT_ACTION_IDS = LOCAL_ACTIONS;
