export interface CollectionSyncMessageInput {
  status?: 'pending' | 'running' | 'success' | 'failed';
  total?: number;
  success?: number;
  target?: number;
  processed?: number;
  error?: string | null;
  sourceLabel: string;
  requestedCount: number;
}

function boundedCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value || 0));
}

function friendlyJobError(error: string | null | undefined): string {
  return (error || '')
    .trim()
    .replace(/^(?:RuntimeError|Error|Exception):\s*/i, '');
}

export function formatCollectionSyncMessage({
  status,
  total,
  success,
  target,
  processed,
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
  const safeTarget = boundedCount(target) || safeTotal || safeRequestedCount;
  const safeProcessed = Math.min(
    safeTarget,
    Math.max(boundedCount(processed), safeSuccess),
  );

  if (status === 'pending' || status === 'running') {
    if (safeProcessed > 0) {
      return `已读取 ${safeProcessed}/${safeTarget} 条${sourceLabel}，正在继续同步…`;
    }
    return `正在读取最近 ${safeRequestedCount} 条${sourceLabel}，请稍候…`;
  }

  if (status === 'failed') {
    return friendlyJobError(error) || `${sourceLabel}同步失败，请稍后重试`;
  }

  if (status === 'success') {
    const synchronized = safeSuccess || safeTotal;
    if (synchronized > 0) {
      return `已检查 ${synchronized} 条${sourceLabel}，正在更新资料库…`;
    }
    return `没有读取到${sourceLabel}。请确认登录的是正确的抖音账号，或重新绑定后再试`;
  }

  return `正在准备${sourceLabel}同步…`;
}
