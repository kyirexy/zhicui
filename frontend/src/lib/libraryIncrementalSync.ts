import type { PlatformLibraryImportEntry } from './types';

/** 同步结果只是本次读取的前缀，更新已有条目并保留未出现在本批中的历史资料。 */
export function mergeSyncedItems<T>(previous: T[], incoming: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return [...incoming, ...previous].filter((item) => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function platformImportSummary(entries: PlatformLibraryImportEntry[]): string {
  const added = entries.filter((entry) => entry.success && entry.status === 'imported').length;
  const reused = entries.filter((entry) => entry.success && entry.status === 'reused').length;
  const failed = entries.filter((entry) => entry.status === 'failed').length;
  const skipped = entries.filter((entry) => entry.status === 'skipped').length;
  const pending = entries.filter((entry) => entry.status === 'pending' && !entry.background_pending).length;
  const background = entries.filter((entry) => entry.status === 'pending' && entry.background_pending).length;
  const unsubmitted = entries.filter((entry) => entry.status === 'not_submitted').length;
  return `新增 ${added} 条，已有 ${reused} 条${background ? `，${background} 条后台准备中` : ''}${failed ? `，${failed} 条未完成` : ''}${pending ? `，${pending} 条结果待确认` : ''}${unsubmitted ? `，${unsubmitted} 条尚未开始` : ''}${skipped ? `，跳过 ${skipped} 条过期结果` : ''}`;
}
