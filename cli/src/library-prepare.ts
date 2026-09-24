import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentApiClient, runFromEnvelope, runIdOf } from './api-client.js';
import { withOwnedCredentialGate } from './credentials.js';
import { CliError, usageError } from './errors.js';
import { downloadLibraryFile } from './media-download.js';
import { isJsonObject, isTerminalStatus, type AgentEnvelope, type JsonObject } from './types.js';

type Progress = (stage: string, data: JsonObject) => void;
interface PrepareState extends JsonObject {
  kind: 'zhicui-library-prepare';
  version: 1;
  api_origin: string;
  source_url: string;
  operation_id: string;
  created_at: string;
}

function object(value: unknown): JsonObject { return isJsonObject(value) ? value : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function resultOf(envelope: AgentEnvelope): JsonObject {
  const data = object(envelope.data);
  const run = object(envelope.run ?? data.run);
  return object(data.result ?? run.data ?? run.result ?? data);
}

function checkOutcome(envelope: AgentEnvelope): void {
  const run = runFromEnvelope(envelope);
  const status = run?.status || envelope.status;
  if (status === 'waiting_for_user') throw new CliError('WAITING_FOR_USER', '请在知萃中完成本次确认，再以 --resume 继续');
  if (status === 'canceled') throw new CliError('RUN_CANCELED', '视频准备任务已取消');
  if (status !== 'failed' && !envelope.error) return;
  const error = object(run?.error ?? envelope.error);
  const code = text(error.code) || 'REMOTE_FAILURE';
  throw new CliError(code, code === 'NO_AUDIO' ? '此视频无可提取音频' : '视频提取未完成，请在知萃查看原因后以 --resume 重试', {
    details: { terminal_failure: status === 'failed' },
  });
}

async function waitForRun(client: AgentApiClient, runId: string, timeoutMs: number, stage: string, progress: Progress): Promise<AgentEnvelope> {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  while (Date.now() < deadline) {
    const envelope = await client.getRun(runId, Math.max(1, deadline - Date.now()));
    const status = runFromEnvelope(envelope)?.status || envelope.status;
    checkOutcome(envelope);
    if (isTerminalStatus(status)) return envelope;
    for await (const event of client.events(runId, after, Math.max(1, deadline - Date.now()))) {
      if (event.sequence <= after) continue;
      after = event.sequence;
      progress(stage, { run_id: runId, sequence: after, status: event.status || 'running' });
      if (event.status === 'waiting_for_user' || event.terminal || isTerminalStatus(event.status)) break;
    }
    await delay(Math.min(200, Math.max(1, deadline - Date.now())));
  }
  throw new CliError('TIMEOUT', '视频准备超时，已保存进度；使用相同链接、目录和 --resume 继续');
}

async function ownedFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
    throw new CliError('PREPARE_STATE_INVALID', '素材目录中的恢复文件无效');
  }
  return readFile(path);
}

async function verifyFile(path: string, expectedHash: string, expectedBytes?: number): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 * 1024
    || (expectedBytes !== undefined && info.size !== expectedBytes)) {
    throw new CliError('MEDIA_CHANGED', '本地素材已被修改，请换一个新目录重新准备');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expectedHash) throw new CliError('MEDIA_CHANGED', '本地素材已被修改，请换一个新目录重新准备');
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function publishText(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.part`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
    await file.close();
    await link(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function prepareLibraryMedia(
  client: AgentApiClient,
  options: { url: string; output: string; resume: boolean; timeoutMs: number; idempotencyKey?: string },
  progress: Progress,
): Promise<JsonObject> {
  let sourceUrl: URL;
  try { sourceUrl = new URL(options.url); } catch { throw usageError('请提供完整的抖音或 B站视频链接'); }
  if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password
    || !/(^|\.)(douyin\.com|iesdouyin\.com|bilibili\.com|b23\.tv)$/u.test(sourceUrl.hostname)) {
    throw usageError('仅支持 HTTPS 抖音或 B站公开视频链接');
  }
  const capabilities = await client.capabilities();
  for (const actionId of ['library.import_link', 'library.transcript.generate', 'library.media.download']) {
    const action = capabilities.actions.find((entry) => entry.id === actionId);
    if (!action) {
      const published = await client.describeAction(actionId).catch(() => null);
      if (published?.available) {
        throw new CliError('SCOPE_DENIED', '视频准备需要 library:read 和 library:write；请重新授权或创建包含这些权限的 PAT');
      }
      throw new CliError('ACTION_NOT_AVAILABLE', '当前服务尚未开放完整的视频准备能力');
    }
    if (!action.available) throw new CliError('ACTION_NOT_AVAILABLE', '当前服务暂时无法准备视频素材');
  }
  const directory = resolve(options.output);
  const statePath = resolve(directory, '.zhicui-prepare.json');
  let state: PrepareState;
  if (options.resume) {
    try { state = JSON.parse((await ownedFile(statePath, 64 * 1024)).toString('utf8')); }
    catch { throw new CliError('PREPARE_STATE_INVALID', '没有找到有效恢复记录，请使用原素材目录'); }
    if (state.kind !== 'zhicui-library-prepare' || state.version !== 1 || state.api_origin !== client.options.baseUrl
      || state.source_url !== options.url || !text(state.operation_id)) {
      throw new CliError('PREPARE_STATE_INVALID', '恢复记录与当前链接或服务不匹配');
    }
  } else {
    try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('OUTPUT_EXISTS', '素材目录已存在；使用新目录，或对原任务加 --resume');
      throw usageError('无法创建素材目录，请确认父目录已存在且可写');
    }
    state = { kind: 'zhicui-library-prepare', version: 1, api_origin: client.options.baseUrl,
      source_url: options.url, operation_id: options.idempotencyKey || randomUUID(), created_at: new Date().toISOString() };
  }
  const lockPath = resolve(directory, '.prepare.lock');
  const save = async () => {
    const temporary = resolve(directory, `.prepare-state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, statePath);
    } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  };
  const invoke = async (action: string, input: JsonObject, stage: 'import' | 'transcript'): Promise<JsonObject> => {
    const runKey = `${stage}_run_id`;
    let envelope: AgentEnvelope;
    try {
      if (text(state[runKey])) {
        envelope = await waitForRun(client, text(state[runKey]), options.timeoutMs, stage, progress);
      } else {
        const attempt = Number(state[`${stage}_attempt`] || 0);
        const key = `prepare-${createHash('sha256').update(`${state.operation_id}:${stage}:${attempt}`).digest('hex')}`;
        envelope = await client.invoke(action, input, key, true);
        const runId = runIdOf(runFromEnvelope(envelope));
        if (runId) { state[runKey] = runId; await save(); }
        checkOutcome(envelope);
        if (runId && !isTerminalStatus(runFromEnvelope(envelope)?.status || envelope.status)) {
          envelope = await waitForRun(client, runId, options.timeoutMs, stage, progress);
        }
      }
      checkOutcome(envelope);
      return resultOf(envelope);
    } catch (error) {
      // 只对已确认失败的任务创建下一次尝试；网络中断和超时仍续读原 Run。
      if (error instanceof CliError && object(error.details).terminal_failure === true) {
        delete state[runKey];
        state[`${stage}_attempt`] = Number(state[`${stage}_attempt`] || 0) + 1;
        await save();
      }
      throw error;
    }
  };
  return withOwnedCredentialGate(lockPath, async () => {
    // 在持锁后重读，避免同时恢复的第二个进程写回过期快照。
    if (options.resume) {
      state = JSON.parse((await ownedFile(statePath, 64 * 1024)).toString('utf8'));
      if (state.kind !== 'zhicui-library-prepare' || state.version !== 1 || state.source_url !== options.url
        || state.api_origin !== client.options.baseUrl || !text(state.operation_id)) {
        throw new CliError('PREPARE_STATE_INVALID', '恢复记录与当前链接或服务不匹配');
      }
    }
    await save();
    if (!text(state.note_id)) {
      progress('import', {});
      const imported = await invoke('library.import_link', { url: options.url }, 'import');
      const item = object(imported.item ?? imported.note);
      const noteId = text(item.note_id || item.id);
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(noteId)) throw new CliError('REMOTE_FAILURE', '导入结果缺少有效资料 ID');
      Object.assign(state, { note_id: noteId, video_id: text(item.video_id), title: text(item.title), platform: text(item.platform) });
      await save();
    }
    const noteId = text(state.note_id);
    const transcriptPath = resolve(directory, 'transcript.txt');
    if (!state.transcript_status && state.pending_transcript && await exists(transcriptPath)) {
      const pending = object(state.pending_transcript);
      await verifyFile(transcriptPath, text(pending.sha256), Number(pending.bytes));
      state.transcript_status = 'ready';
      state.transcript_sha256 = pending.sha256!;
      delete state.pending_transcript;
      await save();
    }
    if (!state.transcript_status) {
      progress('transcript', { note_id: noteId });
      try {
        const transcript = await invoke('library.transcript.generate', { note_id: noteId }, 'transcript');
        const note = object(transcript.note ?? transcript.item ?? transcript);
        if (note.state === 'no_audio' || note.transcript_status === 'no_audio') {
          throw new CliError('NO_AUDIO', '此视频无可提取音频');
        }
        const raw = text(note.transcript_raw ?? note.transcript);
        if (!raw.trim()) throw new CliError('TRANSCRIPT_UNAVAILABLE', '暂未提取到文稿，可保留素材后再尝试');
        state.pending_transcript = { bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') };
        await save();
        await publishText(transcriptPath, raw);
        state.transcript_status = 'ready';
        state.transcript_sha256 = createHash('sha256').update(raw).digest('hex');
        delete state.pending_transcript;
      } catch (error) {
        if (error instanceof CliError && error.code === 'NO_AUDIO') state.transcript_status = 'no_audio';
        else {
          throw error;
        }
      }
      await save();
    }
    if (!state.media && state.pending_media && await exists(resolve(directory, 'source.mp4'))) {
      const pending = object(state.pending_media);
      await verifyFile(resolve(directory, 'source.mp4'), text(pending.sha256), Number(pending.bytes));
      state.media = pending;
      delete state.pending_media;
      await save();
    }
    if (!state.media) {
      progress('download', { note_id: noteId });
      let lastProgress = 0;
      const media = await downloadLibraryFile(client, noteId, resolve(directory, 'source.mp4'), (bytes, totalBytes) => {
        if (Date.now() - lastProgress < 1_000 && bytes !== totalBytes) return;
        lastProgress = Date.now();
        progress('download', { bytes, total_bytes: totalBytes });
      }, async (prepared) => {
        state.pending_media = { file: 'source.mp4', ...prepared };
        await save();
      });
      state.media = { file: 'source.mp4', bytes: media.bytes, sha256: media.sha256, content_type: media.content_type };
      delete state.pending_media;
      await save();
    }
    const media = object(state.media);
    // 恢复时再次核对素材，避免把被替换或截断的文件交给后续工具。
    await verifyFile(resolve(directory, 'source.mp4'), text(media.sha256), Number(media.bytes));
    if (state.transcript_status === 'ready') await verifyFile(resolve(directory, 'transcript.txt'), text(state.transcript_sha256));
    const manifest: JsonObject = {
      format: 'zhicui.hypit-source.v1', source_url: options.url, note_id: noteId,
      video_id: state.video_id || '', platform: state.platform || '', title: state.title || '',
      created_at: state.created_at, media,
      transcript: { status: state.transcript_status || 'unavailable',
        ...(state.transcript_status === 'ready' ? { file: 'transcript.txt', sha256: state.transcript_sha256 || '' } : {}) },
    };
    const manifestPath = resolve(directory, 'manifest.json');
    await publishText(manifestPath, JSON.stringify(manifest, null, 2)).catch(async (error: NodeJS.ErrnoException) => {
      if (!options.resume || error.code !== 'EEXIST') throw error;
      const existing = JSON.parse((await ownedFile(manifestPath, 64 * 1024)).toString('utf8'));
      if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw new CliError('MANIFEST_CHANGED', '素材清单已被修改，原文件保持不变');
    });
    progress('ready', { note_id: noteId });
    return { action: 'library.prepare', status: 'succeeded', note_id: noteId, directory,
      media: resolve(directory, 'source.mp4'), manifest: manifestPath, transcript_status: state.transcript_status || 'unavailable',
      ...(state.transcript_status === 'ready' ? { transcript: resolve(directory, 'transcript.txt') } : {}) };
  }, 1_000).catch((error: unknown) => {
    if (error instanceof CliError && error.message === '等待本机凭据文件读写超时，请稍后重试') {
      throw new CliError('PREPARE_BUSY', '此目录已有视频准备任务；请等它结束后重试');
    }
    throw error;
  });
}
