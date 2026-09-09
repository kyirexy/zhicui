import type { ApiResponse, PlatformLibraryImportEntry, PlatformLibraryImportResult } from './types';
import type { PlatformSyncSnapshot } from './platformSyncSnapshot';

export interface PlatformImportBatch {
  urls: string[];
  sourceRankOffset: number;
  sourceSnapshotSize: number;
}

export function platformImportBatchBody(
  batch: PlatformImportBatch,
  sourceSyncedAt: string,
  sourceMode?: 'collect' | 'like' | 'post',
  snapshot?: PlatformSyncSnapshot,
) {
  return {
    urls: batch.urls,
    // 普通手动导入也保持用户输入顺序，不因分批完成时间不同而倒排。
    source_rank_offset: batch.sourceRankOffset,
    source_synced_at: sourceSyncedAt,
    ...(sourceMode ? {
      source_mode: sourceMode,
      source_snapshot_size: batch.sourceSnapshotSize,
      ...(typeof snapshot?.orderReliable === 'boolean' ? { source_order_reliable: snapshot.orderReliable } : {}),
      ...(snapshot?.coverage ? { source_coverage: snapshot.coverage } : {}),
    } : {}),
  };
}

export async function importPlatformBatches(
  urls: string[],
  send: (batch: PlatformImportBatch) => Promise<ApiResponse<PlatformLibraryImportResult>>,
  onProgress?: (completed: number, total: number) => void,
): Promise<ApiResponse<PlatformLibraryImportResult>> {
  // 同一快照只登记每个链接的首次位置，大小和offset必须基于同一份去重列表。
  const uniqueUrls = [...new Set(urls.map((value) => value.trim()).filter(Boolean))];
  if (uniqueUrls.length === 0) return { success: false, error: '请至少提交一条视频链接' };
  const entries: PlatformLibraryImportEntry[] = [];
  // 顺序提交同一个快照，不能因 ASR 完成时间不同而改变来源排名。
  for (let offset = 0; offset < uniqueUrls.length; offset += 10) {
    const batch = uniqueUrls.slice(offset, offset + 10);
    let response: ApiResponse<PlatformLibraryImportResult>;
    try {
      response = await send({ urls: batch, sourceRankOffset: offset, sourceSnapshotSize: uniqueUrls.length });
    } catch (error) {
      response = { success: false, error: error instanceof Error ? error.message : '导入连接失败' };
    }
    if (!response.success || !response.data) {
      const message = response.error || '导入失败，请稍后重试';
      entries.push(...uniqueUrls.slice(offset).map((input) => ({
        input, success: false, status: 'pending' as const, error: `结果待确认，可重试：${message}`,
      })));
      break;
    }
    // 服务端遗漏的条目不能被当成成功或静默丢掉。
    entries.push(...response.data.items);
    if (response.data.items.length < batch.length) {
      const reported = new Set(response.data.items.map((item) => item.input));
      entries.push(...batch.filter((input) => !reported.has(input)).map((input) => ({
        input, success: false, status: 'pending' as const, error: '服务端未返回该视频结果，待确认，可重试',
      })));
    }
    onProgress?.(Math.min(offset + batch.length, uniqueUrls.length), uniqueUrls.length);
  }
  const success = entries.filter((entry) => entry.success).length;
  const skipped = entries.filter((entry) => entry.status === 'skipped').length;
  const pending = entries.filter((entry) => entry.status === 'pending').length;
  return {
    success: true,
    data: { items: entries, total: entries.length, success, skipped, pending, failed: entries.filter((entry) => entry.status === 'failed').length },
  };
}
