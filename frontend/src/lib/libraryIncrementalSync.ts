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
  const pending = entries.filter((entry) => entry.status === 'pending').length;
  return `新增 ${added} 条，复用 ${reused} 条${failed ? `，${failed} 条需要重试` : ''}${pending ? `，${pending} 条待确认，可重试` : ''}${skipped ? `，跳过 ${skipped} 条过期结果` : ''}；历史资料已保留`;
}
