import type { PlatformAccountCaptureDiagnostics, PlatformAccountResult } from './desktopRuntime';

export interface PlatformSyncSnapshot extends Pick<PlatformAccountResult, 'coverage' | 'orderReliable'> {
  readonly sourceSyncedAt: string;
  readonly diagnostics?: PlatformAccountCaptureDiagnostics;
}

// 诊断只帮助排障，不能代替身份、首屏或排序校验；显式白名单避免传播请求凭据。
export function safeCaptureDiagnostics(value: unknown): PlatformAccountCaptureDiagnostics | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const paths = {
    like: '/aweme/v1/web/aweme/favorite/',
    collect: '/aweme/v1/web/aweme/listcollection/',
    post: '/aweme/v1/web/aweme/post/',
  } as const;
  if (data.version !== 1 || data.platform !== 'douyin'
    || (data.mode !== 'like' && data.mode !== 'collect' && data.mode !== 'post')
    || data.endpoint_path !== paths[data.mode]) return undefined;
  const timestamp = (input: unknown): string | undefined => {
    if (typeof input !== 'string' || input.length > 40) return undefined;
    const time = Date.parse(input);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
  };
  const startedAt = timestamp(data.capture_started_at);
  const finishedAt = timestamp(data.capture_finished_at);
  if (!startedAt || !finishedAt || finishedAt < startedAt) return undefined;
  const count = (input: unknown): number => typeof input === 'number' && Number.isInteger(input)
    && input >= 0 && input <= 1000 ? input : 0;
  return {
    version: 1, platform: 'douyin', mode: data.mode,
    capture_started_at: startedAt, capture_finished_at: finishedAt,
    fresh_document_committed: data.fresh_document_committed === true,
    document_commit_count: count(data.document_commit_count),
    http_cache_bypassed: data.http_cache_bypassed === true,
    service_worker_bypassed: data.service_worker_bypassed === true,
    endpoint_path: paths[data.mode],
    request_methods: Array.isArray(data.request_methods)
      ? [...new Set(data.request_methods.filter((item): item is 'GET' | 'POST' => item === 'GET' || item === 'POST'))] : [],
    first_page_cursor: data.first_page_cursor === '0' ? '0' : null,
    page_count: count(data.page_count),
    first_video_ids: Array.isArray(data.first_video_ids)
      ? data.first_video_ids.filter((item): item is string => typeof item === 'string' && /^\d{5,32}$/.test(item)).slice(0, 3) : [],
  };
}

// 使用采集开始时固定的时间，后续分批登记或重试必须复用，不能把旧结果伪装成新快照。
export function capturePlatformSyncSnapshot(
  result: Pick<PlatformAccountResult, 'coverage' | 'orderReliable' | 'diagnostics'>,
  capturedAt: string,
): PlatformSyncSnapshot {
  const diagnostics = safeCaptureDiagnostics(result.diagnostics);
  return {
    coverage: result.coverage, orderReliable: result.orderReliable, sourceSyncedAt: capturedAt,
    ...(diagnostics ? { diagnostics } : {}),
  };
}

export function sourceSnapshotTime(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
