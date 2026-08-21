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

export function formatDouyinSyncError(
  error: string | null | undefined,
  sourceLabel = '视频',
): string {
  const cleaned = (error || '')
    .trim()
    .replace(/^(?:RuntimeError|Error|Exception):\s*/i, '');

  if (/403|风控|www-hj\.douyin\.com|挑战域|平台风控拒绝/i.test(cleaned)) {
    return `抖音暂时限制了${sourceLabel}列表读取。账号仍保持绑定，已有资料不会丢失；请稍后再试，暂时不要连续同步。`;
  }
  if (/429|限频|请求过于频繁/i.test(cleaned)) {
    return `${sourceLabel}同步得太频繁了。已有资料不会丢失，请稍后再试。`;
  }
  if (/登录状态失效|重新扫码登录|cookie.*(?:失效|无效)|请先.*绑定/i.test(cleaned)) {
    return `抖音登录状态已失效，请重新绑定账号后再同步${sourceLabel}。`;
  }
  if (/未读取到/.test(cleaned) && /保留上次同步结果/.test(cleaned)) {
    return `暂时没有读到新的${sourceLabel}。账号仍保持绑定，已有资料已经保留，请稍后再试。`;
  }
  return cleaned || `${sourceLabel}同步暂时没有完成，请稍后重试。`;
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
    return formatDouyinSyncError(error, sourceLabel);
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
