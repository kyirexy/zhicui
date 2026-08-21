import {
  collectDouyinLibrary,
  getDouyinBatchExtraction,
  getDouyinCollectionJob,
  getDouyinLibraryStatus,
  listDouyinLibraryItems,
  startDouyinBatchExtraction,
} from '@/lib/api';
import type {
  DouyinBatchExtractionJob,
  DouyinCollectionJob,
  DouyinSourceMode,
  LibraryAutoSyncIntervalMinutes,
} from '@/lib/types';
import { formatDouyinSyncError } from '@/lib/douyinSyncFeedback';

const STATE_PREFIX = 'zhicui-library-auto-sync:v1:';
const LOCK_PREFIX = 'zhicui-library-auto-sync-lock:v1:';
const LOCK_TTL_MS = 50 * 60 * 1000;
const SYNC_COUNT = 50;
const COLLECTION_POLL_MS = 2_000;
const EXTRACTION_POLL_MS = 2_500;
const AUTO_SYNC_EVENT = 'zhicui:library-auto-sync-status';
const DOUYIN_SYNC_MODES: Array<{ mode: DouyinSourceMode; label: string }> = [
  { mode: 'collect', label: '收藏' },
  { mode: 'like', label: '喜欢' },
  { mode: 'post', label: '作品' },
];

export type LibraryAutoSyncStatus = 'idle' | 'running' | 'success' | 'partial' | 'error';

export interface LibraryAutoSyncState {
  status: LibraryAutoSyncStatus;
  intervalMinutes: LibraryAutoSyncIntervalMinutes;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  message: string;
  syncedCount: number;
  preparedCount: number;
}

interface AutoSyncLock {
  owner: string;
  expiresAt: number;
}

const activeRuns = new Map<string, Promise<LibraryAutoSyncState>>();

function stateKey(userId: string): string {
  return `${STATE_PREFIX}${encodeURIComponent(userId)}`;
}

function lockKey(userId: string): string {
  return `${LOCK_PREFIX}${encodeURIComponent(userId)}`;
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage);
}

function defaultState(
  intervalMinutes: LibraryAutoSyncIntervalMinutes = 0,
): LibraryAutoSyncState {
  return {
    status: 'idle',
    intervalMinutes,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: intervalMinutes > 0
      ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
      : null,
    message: intervalMinutes > 0 ? '等待下一次自动同步' : '自动同步已关闭',
    syncedCount: 0,
    preparedCount: 0,
  };
}

export function readLibraryAutoSyncState(
  userId: string,
  intervalMinutes: LibraryAutoSyncIntervalMinutes = 0,
): LibraryAutoSyncState {
  if (!storageAvailable() || !userId) return defaultState(intervalMinutes);
  try {
    const raw = window.localStorage.getItem(stateKey(userId));
    if (!raw) return defaultState(intervalMinutes);
    const parsed = JSON.parse(raw) as LibraryAutoSyncState;
    if (!parsed || typeof parsed.status !== 'string') return defaultState(intervalMinutes);
    return { ...defaultState(intervalMinutes), ...parsed };
  } catch {
    return defaultState(intervalMinutes);
  }
}

function writeLibraryAutoSyncState(
  userId: string,
  state: LibraryAutoSyncState,
): LibraryAutoSyncState {
  if (storageAvailable()) {
    try {
      window.localStorage.setItem(stateKey(userId), JSON.stringify(state));
    } catch {
      // 状态持久化失败不影响同步任务本身。
    }
    window.dispatchEvent(new CustomEvent(AUTO_SYNC_EVENT, {
      detail: { userId, state },
    }));
  }
  return state;
}

export function subscribeLibraryAutoSyncState(
  userId: string,
  listener: (state: LibraryAutoSyncState) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handleEvent = (event: Event) => {
    const detail = (event as CustomEvent<{
      userId: string;
      state: LibraryAutoSyncState;
    }>).detail;
    if (detail?.userId === userId) listener(detail.state);
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key !== stateKey(userId) || !event.newValue) return;
    try {
      listener(JSON.parse(event.newValue) as LibraryAutoSyncState);
    } catch {
      // 忽略其他标签页写入的损坏状态。
    }
  };
  window.addEventListener(AUTO_SYNC_EVENT, handleEvent);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(AUTO_SYNC_EVENT, handleEvent);
    window.removeEventListener('storage', handleStorage);
  };
}

export function configureLibraryAutoSyncSchedule(
  userId: string,
  intervalMinutes: LibraryAutoSyncIntervalMinutes,
): LibraryAutoSyncState {
  const current = readLibraryAutoSyncState(userId, intervalMinutes);
  if (current.intervalMinutes === intervalMinutes && (
    intervalMinutes === 0 || current.nextRunAt
  )) {
    return current;
  }
  return writeLibraryAutoSyncState(userId, {
    ...current,
    status: current.status === 'running' ? 'running' : 'idle',
    intervalMinutes,
    nextRunAt: intervalMinutes > 0
      ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
      : null,
    message: intervalMinutes > 0 ? '等待下一次自动同步' : '自动同步已关闭',
  });
}

export function isLibraryAutoSyncDue(
  userId: string,
  intervalMinutes: LibraryAutoSyncIntervalMinutes,
): boolean {
  if (intervalMinutes === 0) return false;
  const state = configureLibraryAutoSyncSchedule(userId, intervalMinutes);
  return !state.nextRunAt || Date.parse(state.nextRunAt) <= Date.now();
}

function createOwnerId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function acquireLock(userId: string): string | null {
  const owner = createOwnerId();
  if (!storageAvailable()) return owner;
  try {
    const key = lockKey(userId);
    const currentRaw = window.localStorage.getItem(key);
    if (currentRaw) {
      const current = JSON.parse(currentRaw) as AutoSyncLock;
      if (current.expiresAt > Date.now()) return null;
    }
    const next: AutoSyncLock = { owner, expiresAt: Date.now() + LOCK_TTL_MS };
    window.localStorage.setItem(key, JSON.stringify(next));
    const verified = JSON.parse(window.localStorage.getItem(key) || '{}') as AutoSyncLock;
    return verified.owner === owner ? owner : null;
  } catch {
    return owner;
  }
}

function releaseLock(userId: string, owner: string): void {
  if (!storageAvailable()) return;
  try {
    const key = lockKey(userId);
    const current = JSON.parse(window.localStorage.getItem(key) || '{}') as AutoSyncLock;
    if (current.owner === owner) window.localStorage.removeItem(key);
  } catch {
    // 过期锁会在下一次获取时被覆盖。
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCollection(jobId: string): Promise<DouyinCollectionJob> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await sleep(COLLECTION_POLL_MS);
    const response = await getDouyinCollectionJob(jobId);
    if (!response.success || !response.data) continue;
    if (response.data.status === 'success') return response.data;
    if (response.data.status === 'failed') {
      throw new Error(response.data.error || '视频资料同步没有完成');
    }
  }
  throw new Error('视频资料同步等待超时，将在下个周期重试');
}

async function waitForExtraction(jobId: string): Promise<DouyinBatchExtractionJob> {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    await sleep(EXTRACTION_POLL_MS);
    const response = await getDouyinBatchExtraction(jobId);
    if (!response.success || !response.data) continue;
    if (response.data.status !== 'running') return response.data;
  }
  throw new Error('文案仍在后台准备，可稍后到视频库查看');
}

function nextRunAt(intervalMinutes: LibraryAutoSyncIntervalMinutes): string | null {
  return intervalMinutes > 0
    ? new Date(Date.now() + intervalMinutes * 60_000).toISOString()
    : null;
}

function extractionFailureReason(job: DouyinBatchExtractionJob): string {
  const reason = job.items.find((item) => item.state === 'error' && item.error)?.error;
  return reason ? reason.slice(0, 120) : '文案服务暂时不可用';
}

async function prepareTranscripts(
  awemeIds: string[],
  onRetry: (failedCount: number) => void,
): Promise<{ prepared: number; failed: number; reason: string }> {
  if (awemeIds.length === 0) return { prepared: 0, failed: 0, reason: '' };

  const firstResponse = await startDouyinBatchExtraction(awemeIds, 'transcript');
  if (!firstResponse.success || !firstResponse.data) {
    return {
      prepared: 0,
      failed: awemeIds.length,
      reason: firstResponse.error || '文案任务没有启动',
    };
  }

  const firstJob = await waitForExtraction(firstResponse.data.job_id);
  const retryIds = firstJob.items
    .filter((item) => item.state === 'error')
    .map((item) => item.aweme_id);
  if (retryIds.length === 0) {
    return { prepared: firstJob.success, failed: 0, reason: '' };
  }

  onRetry(retryIds.length);
  const retryResponse = await startDouyinBatchExtraction(retryIds, 'transcript');
  if (!retryResponse.success || !retryResponse.data) {
    return {
      prepared: firstJob.success,
      failed: retryIds.length,
      reason: retryResponse.error || extractionFailureReason(firstJob),
    };
  }

  const retryJob = await waitForExtraction(retryResponse.data.job_id);
  return {
    prepared: firstJob.success + retryJob.success,
    failed: retryJob.failed,
    reason: retryJob.failed > 0 ? extractionFailureReason(retryJob) : '',
  };
}

async function executeLibraryAutoSync(
  userId: string,
  intervalMinutes: LibraryAutoSyncIntervalMinutes,
): Promise<LibraryAutoSyncState> {
  const owner = acquireLock(userId);
  if (!owner) {
    return readLibraryAutoSyncState(userId, intervalMinutes);
  }

  const startedAt = new Date().toISOString();
  writeLibraryAutoSyncState(userId, {
    ...readLibraryAutoSyncState(userId, intervalMinutes),
    status: 'running',
    intervalMinutes,
    lastAttemptAt: startedAt,
    message: '正在更新抖音收藏、喜欢和作品…',
  });

  try {
    const statusResponse = await getDouyinLibraryStatus();
    if (!statusResponse.success || !statusResponse.data?.cookie_valid) {
      throw new Error('请先到视频资料连接抖音账号');
    }

    let syncedCount = 0;
    const targetIds = new Set<string>();
    const syncFailures: string[] = [];

    for (const [index, source] of DOUYIN_SYNC_MODES.entries()) {
      writeLibraryAutoSyncState(userId, {
        ...readLibraryAutoSyncState(userId, intervalMinutes),
        status: 'running',
        intervalMinutes,
        lastAttemptAt: startedAt,
        message: `正在更新抖音${source.label}（${index + 1}/${DOUYIN_SYNC_MODES.length}）…`,
        syncedCount,
      });

      const collectResponse = await collectDouyinLibrary(SYNC_COUNT, source.mode);
      if (!collectResponse.success || !collectResponse.data) {
        syncFailures.push(`${source.label}：${formatDouyinSyncError(collectResponse.error, source.label)}`);
        continue;
      }
      try {
        const collection = await waitForCollection(collectResponse.data.job_id);
        syncedCount += collection.success;
        const listResponse = await listDouyinLibraryItems(
          SYNC_COUNT,
          source.mode,
          'collection',
        );
        if (!listResponse.success || !listResponse.data) {
          syncFailures.push(`${source.label}：${listResponse.error || '无法读取最新列表'}`);
          continue;
        }
        listResponse.data.items
          .filter((item) => item.can_extract && !item.extracted)
          .forEach((item) => targetIds.add(item.aweme_id));
      } catch (error) {
        syncFailures.push(
          `${source.label}：${formatDouyinSyncError(
            error instanceof Error ? error.message : '同步失败',
            source.label,
          )}`,
        );
      }
    }

    if (syncFailures.length === DOUYIN_SYNC_MODES.length) {
      throw new Error(`抖音资料没有更新：${syncFailures[0]}`);
    }

    const targets = Array.from(targetIds).slice(0, 100);
    writeLibraryAutoSyncState(userId, {
      ...readLibraryAutoSyncState(userId, intervalMinutes),
      status: 'running',
      intervalMinutes,
      lastAttemptAt: startedAt,
      message: targets.length > 0 ? `正在准备 ${targets.length} 条新视频文案…` : '视频资料已更新',
      syncedCount,
    });

    let extraction: { prepared: number; failed: number; reason: string };
    try {
      extraction = await prepareTranscripts(targets, (failedCount) => {
        writeLibraryAutoSyncState(userId, {
          ...readLibraryAutoSyncState(userId, intervalMinutes),
          status: 'running',
          intervalMinutes,
          lastAttemptAt: startedAt,
          message: `${failedCount} 条文案首次准备失败，正在自动重试…`,
          syncedCount,
        });
      });
    } catch (error) {
      extraction = {
        prepared: 0,
        failed: targets.length,
        reason: error instanceof Error ? error.message : '文案服务暂时不可用',
      };
    }

    const isPartial = syncFailures.length > 0 || extraction.failed > 0;
    const detail = extraction.failed > 0
      ? `${extraction.failed} 条文案稍后重试：${extraction.reason}`
      : syncFailures.length > 0
        ? `${syncFailures.length} 个来源稍后重试：${syncFailures[0]}`
        : '';

    const successState: LibraryAutoSyncState = {
      status: isPartial ? 'partial' : 'success',
      intervalMinutes,
      lastAttemptAt: startedAt,
      lastSuccessAt: new Date().toISOString(),
      nextRunAt: nextRunAt(intervalMinutes),
      message: isPartial
        ? `视频资料已更新；${detail}`
        : targets.length > 0
          ? `同步完成，${extraction.prepared}/${targets.length} 条新文案已准备`
          : '同步完成，收藏、喜欢和作品的文案都已就绪',
      syncedCount,
      preparedCount: extraction.prepared,
    };
    return writeLibraryAutoSyncState(userId, successState);
  } catch (error) {
    const failedState: LibraryAutoSyncState = {
      ...readLibraryAutoSyncState(userId, intervalMinutes),
      status: 'error',
      intervalMinutes,
      lastAttemptAt: startedAt,
      nextRunAt: nextRunAt(intervalMinutes),
      message: error instanceof Error ? error.message : '自动同步失败，将在下个周期重试',
    };
    return writeLibraryAutoSyncState(userId, failedState);
  } finally {
    releaseLock(userId, owner);
  }
}

export function runLibraryAutoSync(
  userId: string,
  intervalMinutes: LibraryAutoSyncIntervalMinutes,
): Promise<LibraryAutoSyncState> {
  const active = activeRuns.get(userId);
  if (active) return active;
  const run = executeLibraryAutoSync(userId, intervalMinutes).finally(() => {
    activeRuns.delete(userId);
  });
  activeRuns.set(userId, run);
  return run;
}
