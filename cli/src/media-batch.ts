import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgentApiClient } from './api-client.js';
import { withOwnedCredentialGate } from './credentials.js';
import { CliError, exitCodeForError, normalizeUnknownError, usageError } from './errors.js';
import { downloadLibraryFile } from './media-download.js';
import { normalizePrepareLink } from './prepare-flow.js';
import { isJsonObject, type JsonObject } from './types.js';

type MediaKind = 'video' | 'audio';
type Receipt = { bytes: number; sha256: string; content_type: string };
type Entry = { url: string; title: string; file: string; status: string; attempts: number;
  media?: Receipt; pending_media?: Receipt; video_id?: string; error_code?: string; retry_not_before?: string };
type Batch = { format: string; api_origin: string; user_hash: string; input_hash: string; kind: MediaKind;
  created_at: string; updated_at: string; items: Entry[] };
const FORMAT = 'zhicui.media-batch.v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): JsonObject => isJsonObject(value) ? value : {};

async function regularJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw usageError('清单必须是小于 4 MB 的普通 JSON 文件');
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')); }
  catch { throw usageError('清单 JSON 格式无效'); }
}

export async function readBatchInput(path: string, kind: MediaKind): Promise<Entry[]> {
  const data = await regularJson(path);
  const items = Array.isArray(data) ? data : object(data).items;
  if (!Array.isArray(items) || !items.length || items.length > 1000) throw usageError('清单须为 1–1000 条链接数组，或包含 items 数组的对象');
  const unique = new Map<string, Entry>();
  for (const raw of items) {
    const input = typeof raw === 'string' ? raw : object(raw).url;
    if (typeof input !== 'string') throw usageError('每条清单须为链接字符串，或包含 url 字段的对象');
    const url = normalizePrepareLink(input);
    // 分享链接只按已确认的 URL 去重，不凭短链猜作品身份或发布日期。
    if (unique.has(url)) continue;
    const title = typeof object(raw).title === 'string' ? String(object(raw).title).slice(0, 1000) : '';
    unique.set(url, { url, title, file: `${hash(url).slice(0, 24)}.${kind === 'audio' ? 'mp3' : 'mp4'}`, status: 'pending', attempts: 0 });
  }
  return [...unique.values()];
}

async function verifyMedia(path: string, receipt: Receipt): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || !Number.isSafeInteger(receipt.bytes) || info.size !== receipt.bytes
    || !/^[a-f0-9]{64}$/u.test(receipt.sha256)) throw new CliError('MEDIA_CHANGED', '批次素材大小或类型已改变，原文件保持不变');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  if (digest.digest('hex') !== receipt.sha256) throw new CliError('MEDIA_CHANGED', '批次素材校验失败，原文件保持不变');
}

/** 串行复用正式下载接口；清单只记录取回证据，不将下载完成冒充视频分析完成。 */
export async function downloadMediaBatch(client: AgentApiClient,
  options: { input: string; output: string; resume: boolean; kind: MediaKind },
  progress: (stage: string, data: JsonObject) => void = () => undefined,
): Promise<JsonObject> {
  client = await client.bindCurrentSession();
  const entries = await readBatchInput(options.input, options.kind);
  const inputHash = hash(JSON.stringify(entries.map(({ url, title }) => ({ url, title }))));
  const initial = await client.capabilities();
  if (!initial.user_hash) throw new CliError('IDENTITY_UNAVAILABLE', '服务未返回账号标识，无法安全接续下载批次');
  const available = initial.actions.find((action) => action.id === 'library.media.resolve');
  if (!available) {
    const publicData = await client.publicCapabilities();
    const published = Array.isArray(publicData.actions) && publicData.actions.some((item) => object(item).id === 'library.media.resolve');
    throw new CliError(published ? 'SCOPE_DENIED' : 'ACTION_NOT_AVAILABLE', published
      ? '当前授权缺少视频读取权限；先用 zhicui doctor 确认缺少范围' : '当前服务尚未开放视频下载');
  }
  if (!available.available) throw new CliError('ACTION_NOT_AVAILABLE', '下载能力暂时不可用，请用 zhicui doctor 检查');
  const directory = resolve(options.output);
  if (!options.resume) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('OUTPUT_EXISTS', '批次目录已存在；接续原清单请加 --resume');
      throw usageError('无法创建批次目录，请确认父目录存在');
    }
  }
  const dirInfo = await lstat(directory);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw usageError('批次目录必须为普通本地目录');
  return withOwnedCredentialGate(resolve(directory, '.batch.lock'), async () => {
    const manifest = resolve(directory, 'manifest.json');
    let state: Batch = { format: FORMAT, api_origin: client.options.baseUrl, user_hash: initial.user_hash!, input_hash: inputHash,
      kind: options.kind, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), items: entries };
    if (options.resume) {
      const saved = object(await regularJson(manifest));
      if (saved.format !== FORMAT || saved.api_origin !== client.options.baseUrl || saved.user_hash !== initial.user_hash
        || saved.input_hash !== inputHash || saved.kind !== options.kind || !Array.isArray(saved.items)
        || saved.items.length !== entries.length || saved.items.some((raw, index) => {
          const item = object(raw); return item.url !== entries[index].url || item.file !== entries[index].file
            || !['pending', 'downloading', 'ready', 'failed', 'paused'].includes(String(item.status))
            || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0;
        })) throw new CliError('BATCH_STATE_INVALID', '原批次与当前账号、链接或输出类型不符；不会覆盖已有文件');
      state = saved as unknown as Batch;
    }
    const save = async () => {
      state.updated_at = new Date().toISOString();
      const temporary = resolve(directory, `.manifest-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(state, null, 2), { flag: 'wx', mode: 0o600 });
        await rename(temporary, manifest);
      } finally { await rm(temporary, { force: true }).catch(() => undefined); }
    };
    await save();
    let downloaded = 0, reused = 0, paused = false, stopCode: string | null = null;
    // 限流是整批门槛；不能先重试靠前的失败项，直到遇到后面的限流项才停。
    const cooldown = state.items.map(item => Date.parse(item.retry_not_before || '')).filter(Number.isFinite).sort((a,b) => b-a)[0];
    if (cooldown > Date.now()) {
      paused = true; stopCode = 'RATE_LIMITED';
      progress('cooldown', { retry_not_before: new Date(cooldown).toISOString() });
    }
    for (const item of state.items) {
      if (paused) break;
      const output = resolve(directory, item.file);
      const info = await lstat(output).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) {
        const receipt = item.media || item.pending_media;
        if (!receipt) throw new CliError('OUTPUT_EXISTS', '目录中存在没有校验记录的素材，未覆盖');
        await verifyMedia(output, receipt);
        item.media = receipt; item.status = 'ready'; delete item.pending_media; delete item.error_code;
        reused++; await save(); progress('reused', { file: output, completed: downloaded + reused, total: entries.length }); continue;
      }
      if (item.status === 'ready') throw new CliError('MEDIA_CHANGED', '已完成的素材已被移走，请恢复原文件或使用新批次目录');
      // 每条下载前重新确认账号；切换账号后不能继续旧身份的批次。
      if ((await client.capabilities()).user_hash !== state.user_hash) throw new CliError('LOCAL_USER_MISMATCH', '账号已改变，已停止原下载批次');
      item.attempts++; item.status = 'downloading'; delete item.error_code; delete item.retry_not_before;
      await save(); progress('resolving', { url: item.url, completed: downloaded + reused, total: entries.length });
      try {
        const envelope = await client.invoke('library.media.resolve', { url: item.url, ...(options.kind === 'audio' ? { kind: 'audio' } : {}) });
        const data = object(object(envelope.data).result ?? envelope.data);
        if (typeof data.media_id !== 'string' || (options.kind === 'audio' && data.kind !== 'audio')) {
          throw new CliError('REMOTE_FAILURE', '服务未返回有效下载入口');
        }
        if (typeof data.title === 'string') item.title = data.title.slice(0, 1000);
        if (typeof data.video_id === 'string') item.video_id = data.video_id;
        let last = 0;
        const receipt = await downloadLibraryFile(client, 'fast', output, (bytes, total) => {
          if (Date.now() - last < 1000 && bytes !== total) return;
          last = Date.now(); progress('downloading', { file: output, bytes, total_bytes: total });
        }, async (pending) => { item.pending_media = pending; await save(); }, data.media_id, options.kind);
        item.media = { bytes: receipt.bytes, sha256: receipt.sha256, content_type: receipt.content_type };
        delete item.pending_media; item.status = 'ready'; downloaded++;
        await save(); progress('ready', { file: output, completed: downloaded + reused, total: entries.length });
      } catch (error) {
        const failure = normalizeUnknownError(error);
        item.error_code = failure.code; item.status = 'failed';
        const rate = ['RATE_LIMITED', 'TOO_MANY_REQUESTS', 'HTTP_429'].includes(failure.code);
        const stop = rate || [3, 4, 5, 8, 9].includes(failure.exitCode)
          || /AUTH|VERIFY|VERIFICATION|CAPTCHA|CHALLENGE|ACCOUNT|LOGIN|STATE|OUTPUT|MEDIA_CHANGED/u.test(failure.code);
        if (rate) item.retry_not_before = new Date(Date.now() + Math.max(1, failure.retryAfterSeconds || 60) * 1000).toISOString();
        if (stop) { item.status = 'paused'; paused = true; stopCode = failure.code; }
        await save(); progress(stop ? 'paused' : 'failed', { url: item.url, code: failure.code,
          ...(item.retry_not_before ? { retry_not_before: item.retry_not_before } : {}) });
        if (stop) break;
      }
    }
    const ready = state.items.filter((item) => item.status === 'ready').length;
    return { action: 'media.batch', status: ready === entries.length ? 'succeeded' : paused ? 'paused' : 'partial',
      directory, manifest, total: entries.length, ready, downloaded, reused, pending: entries.length - ready,
      failed: state.items.filter((item) => item.status === 'failed').length, kind: options.kind,
      stop_code: stopCode, exit_code: ready === entries.length ? 0 : stopCode ? exitCodeForError(stopCode) : 7,
      retry_not_before: state.items.map(item => item.retry_not_before || '').sort().at(-1) || null,
      analysis_status: 'not_performed',
      evidence_note: '仅证明清单内素材已下载；不代表博主目录完整、文稿已提取或画面已分析。',
      resume_argv: ['download', 'batch', '--input', resolve(options.input), '--output', directory, '--resume', ...(options.kind === 'audio' ? ['--audio'] : [])] };
  }, 1000).catch((error: unknown) => {
    if (error instanceof CliError && error.message === '等待本机凭据文件读写超时，请稍后重试') throw new CliError('BATCH_BUSY', '该批次正在下载，请等原进程结束');
    throw error;
  });
}
