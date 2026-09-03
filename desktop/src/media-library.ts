import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  app,
  BrowserWindow,
  dialog,
  net,
  shell,
} from 'electron';
import type {
  DesktopMediaAsset,
  DesktopMediaDownloadResult,
  DesktopMediaSaveRequest,
  DesktopMediaSettings,
} from './contract';
import { desktopUserHash } from './desktop-core';
import { validateAwemeId } from './security';

interface PersistedMediaSettings {
  autoSaveOnPlay: boolean;
  directory: string;
}

interface MediaIndexRecord {
  awemeId: string;
  title: string;
  videoPath: string;
  coverPath?: string;
  sizeBytes: number;
  savedAt: string;
}

interface PersistedMediaIndex {
  version: 1;
  assets: Record<string, MediaIndexRecord>;
}

interface MediaProfileState {
  profileHash: string;
  settingsPath: string;
  indexPath: string;
  settings: PersistedMediaSettings;
  index: PersistedMediaIndex;
  transient: Map<string, DesktopMediaAsset>;
}

export interface DesktopMediaLibraryOptions {
  userDataDirectory?: string;
  videosDirectory?: string;
  openPath?: (path: string) => Promise<string>;
  showItemInFolder?: (path: string) => void;
}

interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
}

const INDEX_VERSION = 1;
const MIN_FREE_SPACE_BYTES = 128 * 1024 * 1024;
const PROFILE_DIRECTORY_NAME = 'desktop-media-profiles';

export function desktopMediaProfileDirectory(
  userDataDirectory: string,
  profileKey: string,
): string {
  return join(
    userDataDirectory,
    PROFILE_DIRECTORY_NAME,
    desktopUserHash(profileKey),
  );
}

function jsonOrFallback<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeFilePart(value: string): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim()
    .slice(0, 64);
  return normalized || '知萃视频';
}

function contentExtension(contentType: string, fallback: string): string {
  const normalized = contentType.toLowerCase().split(';')[0].trim();
  const extensions: Record<string, string> = {
    'image/avif': '.avif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
  };
  return extensions[normalized] || fallback;
}

function contentTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  const types: Record<string, string> = {
    '.avif': 'image/avif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.png': 'image/png',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
  };
  return types[extension] || 'application/octet-stream';
}

function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end < start
    || start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export class DesktopMediaLibrary {
  private readonly userDataDirectory: string;
  private readonly videosDirectory: string;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly showItemInFolder: (path: string) => void;
  private activeProfile: MediaProfileState | null = null;
  private readonly profiles = new Map<string, MediaProfileState>();
  private readonly downloads = new Map<string, Promise<DesktopMediaAsset>>();

  constructor(
    private readonly emitStatus: (status: DesktopMediaAsset) => void,
    options: DesktopMediaLibraryOptions = {},
  ) {
    this.userDataDirectory = options.userDataDirectory || app.getPath('userData');
    this.videosDirectory = options.videosDirectory || app.getPath('videos');
    this.openPath = options.openPath || ((path) => shell.openPath(path));
    this.showItemInFolder = options.showItemInFolder
      || ((path) => shell.showItemInFolder(path));
    mkdirSync(this.userDataDirectory, { recursive: true });
  }

  bindProfile(profileKey: string | null): void {
    const normalized = String(profileKey || '').trim();
    if (!normalized) {
      this.activeProfile = null;
      return;
    }
    const profileHash = desktopUserHash(normalized);
    const cached = this.profiles.get(profileHash);
    if (cached) {
      this.activeProfile = cached;
      return;
    }
    const profileDirectory = desktopMediaProfileDirectory(
      this.userDataDirectory,
      normalized,
    );
    mkdirSync(profileDirectory, { recursive: true });
    const settingsPath = join(profileDirectory, 'settings.json');
    const indexPath = join(profileDirectory, 'index.json');
    const defaultDirectory = this.defaultDirectory();
    const settings = jsonOrFallback<PersistedMediaSettings>(
      settingsPath,
      {
        autoSaveOnPlay: false,
        directory: defaultDirectory,
      },
    );
    if (!settings.directory) settings.directory = defaultDirectory;
    let index = jsonOrFallback<PersistedMediaIndex>(
      indexPath,
      { version: INDEX_VERSION, assets: {} },
    );
    if (
      index.version !== INDEX_VERSION
      || typeof index.assets !== 'object'
      || !index.assets
    ) {
      index = { version: INDEX_VERSION, assets: {} };
    }
    const state: MediaProfileState = {
      profileHash,
      settingsPath,
      indexPath,
      settings,
      index,
      transient: new Map<string, DesktopMediaAsset>(),
    };
    this.profiles.set(profileHash, state);
    this.activeProfile = state;
  }

  private defaultDirectory(): string {
    return join(this.videosDirectory, '知萃');
  }

  private persistSettings(state: MediaProfileState): void {
    writeJson(state.settingsPath, state.settings);
  }

  private persistIndex(state: MediaProfileState): void {
    writeJson(state.indexPath, state.index);
  }

  private requireActiveProfile(): MediaProfileState {
    if (this.activeProfile) return this.activeProfile;
    const error = new Error('请先登录知萃账号，再使用本地媒体功能') as Error & {
      code: string;
    };
    error.code = 'LOCAL_USER_NOT_BOUND';
    throw error;
  }

  private isActiveProfile(state: MediaProfileState): boolean {
    return this.activeProfile?.profileHash === state.profileHash;
  }

  private publicSettings(state: MediaProfileState | null): DesktopMediaSettings {
    const settings = state?.settings || {
      autoSaveOnPlay: false,
      directory: this.defaultDirectory(),
    };
    return {
      autoSaveOnPlay: Boolean(settings.autoSaveOnPlay),
      directory: settings.directory,
      defaultDirectory: this.defaultDirectory(),
    };
  }

  getSettings(): DesktopMediaSettings {
    return this.publicSettings(this.activeProfile);
  }

  setAutoSave(enabled: boolean): DesktopMediaSettings {
    const state = this.requireActiveProfile();
    state.settings.autoSaveOnPlay = Boolean(enabled);
    this.persistSettings(state);
    return this.getSettings();
  }

  async chooseDirectory(
    owner: BrowserWindow | null,
  ): Promise<DesktopMediaSettings> {
    const state = this.requireActiveProfile();
    const selected = await this.selectDirectory(owner, state);
    if (selected && this.isActiveProfile(state)) {
      state.settings.directory = selected;
      this.persistSettings(state);
    }
    return this.publicSettings(state);
  }

  private async selectDirectory(
    owner: BrowserWindow | null,
    state: MediaProfileState,
  ): Promise<string | null> {
    const result = owner
      ? await dialog.showOpenDialog(owner, {
        title: '选择知萃视频保存目录',
        defaultPath: state.settings.directory,
        buttonLabel: '保存到这里',
        properties: ['openDirectory', 'createDirectory'],
      })
      : await dialog.showOpenDialog({
        title: '选择知萃视频保存目录',
        defaultPath: state.settings.directory,
        buttonLabel: '保存到这里',
        properties: ['openDirectory', 'createDirectory'],
      });
    const selected = result.filePaths[0];
    if (!result.canceled && selected) {
      mkdirSync(selected, { recursive: true });
      return selected;
    }
    return null;
  }

  async downloadToChosenDirectory(
    owner: BrowserWindow | null,
    request: DesktopMediaSaveRequest,
  ): Promise<DesktopMediaDownloadResult> {
    const state = this.requireActiveProfile();
    const existing = this.getAssetFrom(state, request.awemeId);
    if (existing.status === 'cached') {
      return {
        canceled: false,
        asset: existing,
        directory: existing.directory,
      };
    }
    const selected = await this.selectDirectory(owner, state);
    if (!selected || !this.isActiveProfile(state)) return { canceled: true };
    state.settings.directory = selected;
    this.persistSettings(state);
    const asset = await this.saveForProfile(state, request, selected);
    return { canceled: false, asset, directory: selected };
  }

  async openDirectory(): Promise<boolean> {
    const state = this.requireActiveProfile();
    mkdirSync(state.settings.directory, { recursive: true });
    return (await this.openPath(state.settings.directory)) === '';
  }

  private localUrl(kind: 'video' | 'cover', awemeId: string): string {
    return `zhicui-media://${kind}/${encodeURIComponent(awemeId)}`;
  }

  private cachedAsset(
    awemeId: string,
    record: MediaIndexRecord,
  ): DesktopMediaAsset {
    return {
      awemeId,
      status: 'cached',
      videoUrl: this.localUrl('video', awemeId),
      coverUrl: record.coverPath && existsSync(record.coverPath)
        ? this.localUrl('cover', awemeId)
        : undefined,
      fileName: basename(record.videoPath),
      directory: dirname(record.videoPath),
      sizeBytes: record.sizeBytes,
      totalBytes: record.sizeBytes,
      receivedBytes: record.sizeBytes,
      percent: 100,
      savedAt: record.savedAt,
    };
  }

  getAsset(rawAwemeId: string): DesktopMediaAsset {
    const state = this.activeProfile;
    const awemeId = validateAwemeId(rawAwemeId);
    if (!state) return { awemeId, status: 'remote' };
    return this.getAssetFrom(state, awemeId);
  }

  private getAssetFrom(
    state: MediaProfileState,
    rawAwemeId: string,
  ): DesktopMediaAsset {
    const awemeId = validateAwemeId(rawAwemeId);
    const active = state.transient.get(awemeId);
    if (active) return active;

    const record = state.index.assets[awemeId];
    if (!record) return { awemeId, status: 'remote' };
    if (!existsSync(record.videoPath)) {
      delete state.index.assets[awemeId];
      this.persistIndex(state);
      return { awemeId, status: 'remote' };
    }
    return this.cachedAsset(awemeId, record);
  }

  private updateTransient(
    state: MediaProfileState,
    status: DesktopMediaAsset,
  ): void {
    if (status.status === 'cached' || status.status === 'remote') {
      state.transient.delete(status.awemeId);
    } else {
      state.transient.set(status.awemeId, status);
    }
    if (this.isActiveProfile(state)) this.emitStatus(status);
  }

  private assertFreeSpace(directory: string, expectedBytes?: number): void {
    try {
      const stats = statfsSync(directory);
      const available = Number(stats.bavail) * Number(stats.bsize);
      const required = Math.max(
        expectedBytes || 0,
        MIN_FREE_SPACE_BYTES,
      );
      if (Number.isFinite(available) && available < required) {
        throw new Error('当前磁盘空间不足，请更换保存目录或清理空间');
      }
    } catch (error) {
      if (
        error instanceof Error
        && error.message.includes('磁盘空间不足')
      ) {
        throw error;
      }
      // Some network drives do not implement statfs. The actual write still
      // reports a clear error, so this preflight is best-effort.
    }
  }

  private async fetchToFile(
    url: string,
    targetPath: string,
    expectedKind: 'video' | 'image',
    targetDirectory: string,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<{ contentType: string; sizeBytes: number }> {
    const response = await net.fetch(url, {
      redirect: 'error',
      headers: {
        Accept: expectedKind === 'video' ? 'video/*,*/*;q=0.8' : 'image/*,*/*;q=0.8',
        'Accept-Encoding': 'identity',
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(
        expectedKind === 'video'
          ? `视频读取失败（${response.status}）`
          : `封面读取失败（${response.status}）`,
      );
    }
    const contentType = response.headers.get('content-type') || '';
    const normalizedContentType = contentType.toLowerCase();
    const isGenericVideo = (
      expectedKind === 'video'
      && normalizedContentType.startsWith('application/octet-stream')
    );
    if (
      !normalizedContentType.startsWith(`${expectedKind}/`)
      && !isGenericVideo
    ) {
      throw new Error(expectedKind === 'video' ? '返回内容不是视频' : '返回内容不是图片');
    }

    const totalHeader = Number(response.headers.get('content-length') || 0);
    const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0
      ? totalHeader
      : undefined;
    this.assertFreeSpace(targetDirectory, totalBytes);

    let receivedBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        receivedBytes += chunk.length;
        onProgress?.({
          receivedBytes,
          totalBytes,
          percent: totalBytes
            ? Math.min(100, (receivedBytes / totalBytes) * 100)
            : undefined,
        });
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as never),
      meter,
      createWriteStream(targetPath, { flags: 'wx' }),
    );
    return { contentType, sizeBytes: receivedBytes };
  }

  async save(
    request: DesktopMediaSaveRequest,
    targetDirectory?: string,
  ): Promise<DesktopMediaAsset> {
    const state = this.requireActiveProfile();
    return this.saveForProfile(
      state,
      request,
      targetDirectory || state.settings.directory,
    );
  }

  private async saveForProfile(
    state: MediaProfileState,
    request: DesktopMediaSaveRequest,
    targetDirectory: string,
  ): Promise<DesktopMediaAsset> {
    const awemeId = validateAwemeId(request.awemeId);
    const existing = this.getAssetFrom(state, awemeId);
    if (existing.status === 'cached') return existing;
    const downloadKey = `${state.profileHash}:${awemeId}`;
    const running = this.downloads.get(downloadKey);
    if (running) return running;

    const operation = this.download(
      state,
      { ...request, awemeId },
      targetDirectory,
    ).finally(() => this.downloads.delete(downloadKey));
    this.downloads.set(downloadKey, operation);
    return operation;
  }

  private async download(
    state: MediaProfileState,
    request: DesktopMediaSaveRequest,
    targetDirectory: string,
  ): Promise<DesktopMediaAsset> {
    const awemeId = request.awemeId;
    mkdirSync(targetDirectory, { recursive: true });
    const baseName = `${awemeId}-${safeFilePart(request.title)}`;
    const initialVideoPath = join(targetDirectory, `${baseName}.mp4`);
    const videoPartPath = `${initialVideoPath}.part-${process.pid}-${Date.now()}`;
    let coverPartPath = '';

    this.updateTransient(state, {
      awemeId,
      status: 'downloading',
      directory: targetDirectory,
      receivedBytes: 0,
      percent: 0,
    });

    try {
      const videoResult = await this.fetchToFile(
        request.mediaUrl,
        videoPartPath,
        'video',
        targetDirectory,
        (progress) => {
          this.updateTransient(state, {
            awemeId,
            status: 'downloading',
            directory: targetDirectory,
            receivedBytes: progress.receivedBytes,
            totalBytes: progress.totalBytes,
            percent: progress.percent,
          });
        },
      );
      const videoExtension = contentExtension(videoResult.contentType, '.mp4');
      const videoPath = join(targetDirectory, `${baseName}${videoExtension}`);
      rmSync(videoPath, { force: true });
      renameSync(videoPartPath, videoPath);

      let coverPath: string | undefined;
      if (request.coverUrl) {
        const proposedCoverPath = join(targetDirectory, `${baseName}.jpg`);
        coverPartPath = `${proposedCoverPath}.part-${process.pid}-${Date.now()}`;
        try {
          const coverResult = await this.fetchToFile(
            request.coverUrl,
            coverPartPath,
            'image',
            targetDirectory,
          );
          const coverExtension = contentExtension(coverResult.contentType, '.jpg');
          coverPath = join(targetDirectory, `${baseName}${coverExtension}`);
          rmSync(coverPath, { force: true });
          renameSync(coverPartPath, coverPath);
          coverPartPath = '';
        } catch {
          rmSync(coverPartPath, { force: true });
          coverPartPath = '';
        }
      }

      const record: MediaIndexRecord = {
        awemeId,
        title: request.title,
        videoPath,
        coverPath,
        sizeBytes: videoResult.sizeBytes,
        savedAt: new Date().toISOString(),
      };
      state.index.assets[awemeId] = record;
      this.persistIndex(state);
      const asset = this.cachedAsset(awemeId, record);
      this.updateTransient(state, asset);
      return asset;
    } catch (error) {
      rmSync(videoPartPath, { force: true });
      if (coverPartPath) rmSync(coverPartPath, { force: true });
      const asset: DesktopMediaAsset = {
        awemeId,
        status: 'error',
        directory: targetDirectory,
        error: error instanceof Error
          ? error.message
          : '视频保存失败，请稍后重试',
      };
      this.updateTransient(state, asset);
      return asset;
    }
  }

  async reveal(rawAwemeId: string): Promise<boolean> {
    const state = this.activeProfile;
    const awemeId = validateAwemeId(rawAwemeId);
    if (!state) return false;
    const record = state.index.assets[awemeId];
    if (!record || !existsSync(record.videoPath)) return false;
    this.showItemInFolder(record.videoPath);
    return true;
  }

  remove(rawAwemeId: string): DesktopMediaAsset {
    const state = this.activeProfile;
    const awemeId = validateAwemeId(rawAwemeId);
    if (!state) return { awemeId, status: 'remote' };
    const record = state.index.assets[awemeId];
    if (record) {
      rmSync(record.videoPath, { force: true });
      if (record.coverPath) rmSync(record.coverPath, { force: true });
      delete state.index.assets[awemeId];
      this.persistIndex(state);
    }
    const asset: DesktopMediaAsset = { awemeId, status: 'remote' };
    this.updateTransient(state, asset);
    return asset;
  }

  async handleProtocolRequest(request: Request): Promise<Response> {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const kind = parsed.hostname;
    if (kind !== 'video' && kind !== 'cover') {
      return new Response('Not found', { status: 404 });
    }

    let awemeId: string;
    try {
      awemeId = validateAwemeId(decodeURIComponent(parsed.pathname.slice(1)));
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const state = this.activeProfile;
    if (!state) return new Response('Not found', { status: 404 });
    const record = state.index.assets[awemeId];
    const path = kind === 'video' ? record?.videoPath : record?.coverPath;
    if (!path || !existsSync(path)) {
      return new Response('Not found', { status: 404 });
    }

    const stat = statSync(path);
    const range = parseRange(request.headers.get('range'), stat.size);
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Type': contentTypeForPath(path),
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.headers.has('range') && !range) {
      headers.set('Content-Range', `bytes */${stat.size}`);
      return new Response(null, { status: 416, headers });
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = end - start + 1;
    headers.set('Content-Length', String(length));
    if (range) {
      headers.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: range ? 206 : 200,
        headers,
      });
    }

    const stream = Readable.toWeb(createReadStream(path, { start, end }));
    return new Response(stream as unknown as BodyInit, {
      status: range ? 206 : 200,
      headers,
    });
  }
}
