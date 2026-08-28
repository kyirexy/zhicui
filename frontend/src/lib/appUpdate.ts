import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { API_BASE } from './api';
import {
  CLIENT_RELEASE_CHANNEL,
  type ClientReleaseChannel,
} from './releaseChannel';

export interface AndroidReleaseManifest {
  schema_version: 1 | 2;
  channel: ClientReleaseChannel;
  availability: 'available';
  platform: 'android';
  artifact_kind: 'debug' | 'release';
  version: string;
  build: number;
  published_at: string;
  download_url: string;
  size_bytes: number;
  mandatory: boolean;
  sha256?: string;
  debuggable?: boolean;
  release_notes: string[];
}

export interface RuntimeAppInfo {
  nativeAndroid: boolean;
  version: string;
  build: number;
}

export type AndroidUpdateCheck =
  | {
      status: 'unsupported';
      installed: RuntimeAppInfo;
      release: null;
    }
  | {
      status: 'current' | 'update-available';
      installed: RuntimeAppInfo;
      release: AndroidReleaseManifest;
    }
  | {
      status: 'release-unavailable';
      installed: RuntimeAppInfo;
      release: null;
      channel: ClientReleaseChannel;
      reason: string;
    };

type UnknownRecord = Record<string, unknown>;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function releaseEndpoint(): string {
  const base = API_BASE.replace(/\/+$/, '');
  return `${base}/download/releases/android/${CLIENT_RELEASE_CHANNEL}.json`;
}

export function isTrustedApkUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:'
      && url.hostname === 'luxai.cn'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && (
        url.pathname === '/download/zhicui.apk'
        || /^\/download\/android\/[A-Za-z0-9._-]+\.apk$/.test(url.pathname)
      )
    );
  } catch {
    return false;
  }
}

export function parseAndroidReleaseManifest(
  value: unknown,
): AndroidReleaseManifest {
  if (!isRecord(value)) {
    throw new Error('版本清单不是有效对象');
  }

  const notes = value.release_notes;
  const build = value.build;
  const sizeBytes = value.size_bytes;
  const publishedAt = value.published_at;
  const version = value.version;
  const downloadUrl = value.download_url;

  const valid = (
    (value.schema_version === 1 || value.schema_version === 2)
    && (value.availability === undefined || value.availability === 'available')
    && value.platform === 'android'
    && typeof version === 'string'
    && VERSION_PATTERN.test(version)
    && Number.isInteger(build)
    && Number(build) > 0
    && typeof publishedAt === 'string'
    && Number.isFinite(Date.parse(publishedAt))
    && typeof downloadUrl === 'string'
    && isTrustedApkUrl(downloadUrl)
    && Number.isInteger(sizeBytes)
    && Number(sizeBytes) > 0
    && Array.isArray(notes)
    && notes.length >= 1
    && notes.length <= 20
    && notes.every(
      (note) => typeof note === 'string'
        && note.trim().length >= 1
        && note.trim().length <= 240,
    )
  );

  if (!valid) {
    throw new Error('线上版本信息格式无效，请稍后重试');
  }

  return {
    schema_version: value.schema_version as 1 | 2,
    channel: value.channel === 'stable' ? 'stable' : 'beta',
    availability: 'available',
    platform: 'android',
    artifact_kind: value.artifact_kind === 'release' ? 'release' : 'debug',
    version,
    build: Number(build),
    published_at: publishedAt,
    download_url: downloadUrl,
    size_bytes: Number(sizeBytes),
    mandatory: value.mandatory === true,
    sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
    debuggable: typeof value.debuggable === 'boolean' ? value.debuggable : undefined,
    release_notes: Array.from(
      new Set((notes as string[]).map((note) => note.trim())),
    ),
  };
}

export function hasNewerBuild(
  installedBuild: number,
  latestBuild: number,
): boolean {
  return (
    Number.isInteger(installedBuild)
    && installedBuild >= 0
    && Number.isInteger(latestBuild)
    && latestBuild > installedBuild
  );
}

export async function getRuntimeAppInfo(): Promise<RuntimeAppInfo> {
  const nativeAndroid = (
    typeof window !== 'undefined'
    && Capacitor.isNativePlatform()
    && Capacitor.getPlatform() === 'android'
  );
  if (!nativeAndroid) {
    return { nativeAndroid: false, version: 'Web', build: 0 };
  }

  const info = await App.getInfo();
  const parsedBuild = Number.parseInt(info.build, 10);
  return {
    nativeAndroid: true,
    version: info.version || '未知',
    build: Number.isFinite(parsedBuild) ? parsedBuild : 0,
  };
}

export async function fetchLatestAndroidRelease(): Promise<AndroidReleaseManifest> {
  const separator = releaseEndpoint().includes('?') ? '&' : '?';
  const response = await fetch(
    `${releaseEndpoint()}${separator}t=${Date.now()}`,
    {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    },
  );
  if (!response.ok) {
    throw new Error(`检查更新失败（${response.status}）`);
  }

  const payload: unknown = await response.json();
  const manifest = isRecord(payload) && payload.success === true
    ? payload.data
    : payload;
  return parseAndroidReleaseManifest(manifest);
}

export async function checkAndroidAppUpdate(): Promise<AndroidUpdateCheck> {
  const installed = await getRuntimeAppInfo();
  if (!installed.nativeAndroid) {
    return { status: 'unsupported', installed, release: null };
  }
  let release: AndroidReleaseManifest;
  try {
    release = await fetchLatestAndroidRelease();
  } catch (error) {
    const response = await fetch(`${releaseEndpoint()}?availability=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    }).catch(() => null);
    const payload = response?.ok ? await response.json().catch(() => null) : null;
    if (
      isRecord(payload)
      && payload.availability === 'unavailable'
      && typeof payload.reason === 'string'
    ) {
      return {
        status: 'release-unavailable',
        installed,
        release: null,
        channel: CLIENT_RELEASE_CHANNEL,
        reason: payload.reason,
      };
    }
    throw error;
  }
  return {
    status: hasNewerBuild(installed.build, release.build)
      ? 'update-available'
      : 'current',
    installed,
    release,
  };
}

export async function openAndroidReleaseDownload(url: string): Promise<void> {
  if (!isTrustedApkUrl(url)) {
    throw new Error('下载地址未通过安全校验');
  }
  if (
    typeof window === 'undefined'
    || !Capacitor.isNativePlatform()
    || Capacitor.getPlatform() !== 'android'
  ) {
    throw new Error('请在知萃 Android App 中下载更新');
  }
  await Browser.open({ url });
}

export function formatReleaseSize(sizeBytes: number): string {
  const megabytes = sizeBytes / (1024 * 1024);
  return `${megabytes.toFixed(megabytes >= 100 ? 0 : 1)} MB`;
}

export function formatReleaseDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '发布时间未知';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
