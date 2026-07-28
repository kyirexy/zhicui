export interface CollectionSyncMessageInput {
  status?: 'pending' | 'running' | 'success' | 'failed';
  total?: number;
  success?: number;
  error?: string | null;
  sourceLabel: string;
  requestedCount: number;
}

function boundedCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value || 0));
}

export function formatCollectionSyncMessage({
  status,
  total,
  success,
  error,
  sourceLabel,
  requestedCount,
}: CollectionSyncMessageInput): string {
  const safeTotal = boundedCount(total);
  const safeSuccess = boundedCount(success);
  const safeRequestedCount = Math.max(
    1,
    Math.min(100, Math.trunc(requestedCount || 50)),
  );

  if (status === 'pending' || status === 'running') {
    if (safeTotal > 0) {
      return `已找到 ${safeTotal} 条${sourceLabel}，正在同步 ${Math.min(safeSuccess, safeTotal)}/${safeTotal}`;
    }
    return `正在读取最近 ${safeRequestedCount} 条${sourceLabel}，请稍候…`;
  }

  if (status === 'failed') {
    return error?.trim() || `${sourceLabel}同步失败，请稍后重试`;
  }

  if (status === 'success') {
    const synchronized = safeSuccess || safeTotal;
    if (synchronized > 0) {
      return `已同步 ${synchronized} 条${sourceLabel}，正在更新资料库…`;
    }
    return `没有读取到${sourceLabel}。请确认登录的是正确的抖音账号，或重新绑定后再试`;
  }

  return `正在准备${sourceLabel}同步…`;
}
