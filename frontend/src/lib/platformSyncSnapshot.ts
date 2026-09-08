import type { PlatformAccountResult } from './desktopRuntime';

export interface PlatformSyncSnapshot extends Pick<PlatformAccountResult, 'coverage' | 'orderReliable'> {
  readonly sourceSyncedAt: string;
}

// 使用采集开始时固定的时间，后续分批登记或重试必须复用，不能把旧结果伪装成新快照。
export function capturePlatformSyncSnapshot(
  result: Pick<PlatformAccountResult, 'coverage' | 'orderReliable'>,
  capturedAt: string,
): PlatformSyncSnapshot {
  return { coverage: result.coverage, orderReliable: result.orderReliable, sourceSyncedAt: capturedAt };
}

export function sourceSnapshotTime(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
