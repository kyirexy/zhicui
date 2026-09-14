import type { ApiResponse, PlatformLibraryImportEntry, PlatformLibraryImportResult } from './types';
import type { PlatformSyncSnapshot } from './platformSyncSnapshot';

export interface PlatformImportBatch {
  urls: string[];
  sourceRankOffset: number;
  sourceSnapshotSize: number;
}

export function platformImportInputKey(input: string): string {
  const value = input.trim();
  // 只规整后端明确支持的官网 BV 链接尾斜杠；主机、查询参数和其他平台仍严格区分。
  return /^https:\/\/www\.bilibili\.com\/video\/BV[0-9A-Za-z]{3,30}\/$/.test(value) ? value.slice(0, -1) : value;
}

export function platformFromImportInput(input: string): PlatformLibraryImportEntry['platform'] {
  const value = input.match(/https?:\/\/[^\s<>"，。]+/i)?.[0];
  if (!value) return 'unknown';
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return 'bilibili';
    if (host === 'xiaohongshu.com' || host.endsWith('.xiaohongshu.com') || host === 'xhslink.com') return 'xiaohongshu';
  } catch { /* 无法识别的链接保留原输入，不能猜测平台。 */ }
  return 'unknown';
}

/** 网络和代理错误只给出可执行的提示，不把 HTTP/内部异常铺在用户界面。 */
export function platformImportErrorMessage(error?: string, status?: number): string {
  if (status === 401 || status === 403) return '请重新登录知萃后查看同步结果';
  if (status === 429) return '操作较频繁，请稍后再试';
  if (status === 400 || status === 422) return '请检查视频链接后再试';
  if (status === 404) return '同步服务暂不可用，请稍后查看';
  if (status === 409) return '同步仍在处理中，请稍后查看结果';
  if (status && status >= 500) return '同步连接中断，请稍后查看结果';
  if (/重新登录|登录已过期/.test(error || '')) return '请重新登录知萃后查看同步结果';
  return '同步暂未完成，请稍后查看结果';
}

export function unsubmittedPlatformImports(urls: string[]): PlatformLibraryImportEntry[] {
  return urls.map((input) => ({ input, platform: platformFromImportInput(input), success: false,
    status: 'not_submitted', error: '尚未开始同步' }));
}

export function platformImportResultLabel(entry: PlatformLibraryImportEntry): string {
  const platform = entry.item?.platform || (entry.platform !== 'unknown' ? entry.platform : undefined)
    || platformFromImportInput(entry.input);
  const name = platform === 'bilibili' ? 'B站' : platform === 'xiaohongshu' ? '小红书' : '视频';
  const title = entry.item?.title || entry.input.slice(0, 60);
  const state = entry.status === 'not_submitted' ? '尚未开始'
    : entry.status === 'pending' ? (entry.background_pending ? '后台准备中' : '结果待确认')
      : entry.status === 'skipped' ? '已保留较新的资料'
        : entry.status === 'reused' ? '已有资料' : entry.success ? '已新增' : '未完成';
  return `${name} · ${title} · ${state}`;
}

export function platformImportNotice(entries: PlatformLibraryImportEntry[]): string {
  if (entries.some((entry) => entry.status === 'pending' && !entry.background_pending)) {
    return '同步连接中断，部分结果尚未确认。请稍后刷新结果，已有资料已保留。';
  }
  if (entries.some((entry) => entry.background_pending)) return '任务已保存，正在后台准备文案。你可以先使用已就绪的视频。';
  if (entries.some((entry) => entry.status === 'not_submitted')) return '后续视频尚未开始同步。';
  return '';
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
  const uniqueUrls = [...new Set(urls.map(platformImportInputKey).filter(Boolean))];
  if (uniqueUrls.length === 0) return { success: false, error: '请至少提交一条视频链接' };
  const entries: PlatformLibraryImportEntry[] = [];
  let interrupted = false;
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
      // 已发送的请求可能仍在服务端执行。未发送的尾部与结果未知必须分开，不能提示重发。
      const rejected = [400, 401, 403, 404, 422, 429].includes(response.status || 0);
      entries.push(...batch.map((input) => ({
        input, platform: platformFromImportInput(input), success: false,
        status: rejected ? 'failed' as const : 'pending' as const,
        error: platformImportErrorMessage(response.error, response.status),
      })));
      entries.push(...unsubmittedPlatformImports(uniqueUrls.slice(offset + batch.length)));
      interrupted = true;
      break;
    }
    // 按输入逐项核对；缺失、重复或未知条目都不能让总数/成功数虚增。
    const reported = Array.isArray(response.data.items) ? response.data.items : [];
    const batchEntries = batch.map((input): PlatformLibraryImportEntry => {
      const matches = reported.filter((item) => item && typeof item.input === 'string' && platformImportInputKey(item.input) === input);
      const item = matches[0];
      if (matches.length !== 1 || !item || !['imported', 'reused', 'failed', 'skipped', 'pending', 'not_submitted'].includes(item.status)
        || (item.status !== 'skipped' && item.success !== (item.status === 'imported' || item.status === 'reused'))) {
        return { input, platform: platformFromImportInput(input), success: false, status: 'pending', error: '同步结果尚未确认' };
      }
      return { ...item, input, success: item.status === 'skipped' ? false : item.success,
        platform: item.item?.platform || (item.platform !== 'unknown' ? item.platform : undefined)
        || platformFromImportInput(input) };
    });
    entries.push(...batchEntries);
    if (response.data.interrupted || batchEntries.some((item) => item.status === 'pending' || item.status === 'not_submitted')) {
      entries.push(...unsubmittedPlatformImports(uniqueUrls.slice(offset + batch.length)));
      interrupted = true;
      break;
    }
    onProgress?.(Math.min(offset + batch.length, uniqueUrls.length), uniqueUrls.length);
  }
  const success = entries.filter((entry) => entry.success).length;
  const skipped = entries.filter((entry) => entry.status === 'skipped').length;
  const pending = entries.filter((entry) => entry.status === 'pending').length;
  return {
    success: true,
    data: { items: entries, total: entries.length, success, skipped, pending,
      not_submitted: entries.filter((entry) => entry.status === 'not_submitted').length,
      interrupted, failed: entries.filter((entry) => entry.status === 'failed').length },
  };
}
