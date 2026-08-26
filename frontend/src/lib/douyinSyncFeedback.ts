export interface CollectionSyncMessageInput {
  status?: 'pending' | 'running' | 'success' | 'failed';
  total?: number;
  success?: number;
  target?: number;
  processed?: number;
  error?: string | null;
  error_code?: string | null;
  channel?: string | null;
  fallback_attempted?: boolean;
  retry_after_seconds?: number;
  needs_action?: boolean;
  sourceLabel: string;
  requestedCount: number;
}

export interface MultiSourceSyncResult {
  sourceLabel: string;
  checked: number;
  newlyVisible: number;
  error?: string;
}

function boundedCount(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value || 0));
}

export function hasDouyinSyncFailureDiagnostic(
  input: Pick<CollectionSyncMessageInput,
    'error' | 'error_code' | 'needs_action'>,
): boolean {
  const errorCode = (input.error_code || '').trim();
  const error = (input.error || '').trim();
  return Boolean(errorCode || input.needs_action || error);
}

export function formatMultiSourceSyncSummary(
  results: MultiSourceSyncResult[],
): string {
  const successful = results.filter((result) => !result.error);
  const failed = results.filter((result) => Boolean(result.error));
  if (successful.length === 0) {
    return failed.length > 0
      ? failed.map((result) => `${result.sourceLabel}：${result.error}`).join('；')
      : '没有可同步的来源';
  }
  const checked = successful.reduce(
    (total, result) => total + boundedCount(result.checked),
    0,
  );
  const newlyVisible = successful.reduce(
    (total, result) => total + boundedCount(result.newlyVisible),
    0,
  );
  const failedSuffix = failed.length > 0
    ? `；${failed.map((result) => `${result.sourceLabel}：${result.error}`).join('；')}`
    : '';
  return `已同步 ${successful.length} 个来源，共检查 ${checked} 条，新显示 ${newlyVisible} 条${failedSuffix}`;
}

export function formatDouyinSyncError(
  error: string | null | undefined,
  sourceLabel = '视频',
  diagnostics: Pick<CollectionSyncMessageInput,
    'error_code' | 'retry_after_seconds' | 'needs_action'> = {},
): string {
  const cleaned = (error || '')
    .trim()
    .replace(/^(?:RuntimeError|Error|Exception):\s*/i, '');

  const retrySeconds = boundedCount(diagnostics.retry_after_seconds);
  const retryHint = retrySeconds > 0
    ? `约 ${Math.max(1, Math.ceil(retrySeconds / 60))} 分钟后可再试。`
    : '请稍后再试。';
  if (
    diagnostics.error_code === 'argus_uifid_missing'
    || /收藏登录信息不完整|UIFID/i.test(cleaned)
  ) {
    return '收藏读取条件还没有完成。请重新连接抖音账号，扫码后等待页面确认登录完成；喜欢和我的作品仍可正常同步。';
  }
  if (diagnostics.error_code === 'verification_required' || diagnostics.needs_action) {
    return `抖音要求重新验证账号后才能读取${sourceLabel}。已有资料不会丢失，请在账号管理中完成验证。`;
  }
  if (
    diagnostics.error_code === 'source_blocked'
    || diagnostics.error_code === 'risk_controlled'
    || /403|风控|www-hj\.douyin\.com|挑战域|平台风控拒绝/i.test(cleaned)
  ) {
    return `抖音暂时限制了${sourceLabel}列表读取。账号仍保持绑定，已有资料不会丢失；${retryHint}暂时不要连续同步。`;
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
  error_code,
  retry_after_seconds,
  needs_action,
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

  // 部分连接器版本会同时返回 success 和受限诊断，不能让传输状态掩盖风控。
  if (status === 'failed' || hasDouyinSyncFailureDiagnostic({
    error,
    error_code,
    needs_action,
  })) {
    return formatDouyinSyncError(error, sourceLabel, {
      error_code,
      retry_after_seconds,
      needs_action,
    });
  }

  if (status === 'success') {
    const synchronized = safeSuccess || safeTotal;
    if (synchronized > 0) {
      return `已检查 ${synchronized} 条${sourceLabel}，正在更新资料库…`;
    }
    return `本次未读取到${sourceLabel}，不计为同步成功。可能是该列表为空、登录账号不匹配，或抖音暂时限制了列表读取；请稍后再试，暂时不要连续同步。`;
  }

  return `正在准备${sourceLabel}同步…`;
}
