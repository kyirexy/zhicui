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
  created?: number;
  reused?: number;
  error?: string;
}

/** 文稿任务状态与同步结果合并展示；过期任务的回调不能覆盖下一轮或其他账号。 */
export function createSyncNoticeReporter(
  summary: string,
  isCurrent: () => boolean,
  publish: (message: string) => void,
): (progress: string) => void {
  return (progress) => {
    if (isCurrent()) publish([summary, progress].filter(Boolean).join('；'));
  };
}

export function formatTranscriptPreparationProgress(job: {
  status: 'running' | 'success' | 'partial' | 'failed';
  total: number;
  success: number;
  failed: number;
  active?: number;
  queued?: number;
  error?: string;
}): string {
  const completed = boundedCount(job.success);
  const total = boundedCount(job.total);
  if (job.status === 'failed') {
    const hint = /余额|额度|配额/.test(job.error || '') ? '请检查可用额度后重试'
      : /登录|401/.test(job.error || '') ? '请重新登录后重试'
        : /未配置|配置.*(?:缺失|无效)|API.*(?:key|密钥)/i.test(job.error || '') ? '请检查文案提取设置后重试'
          : '请稍后重试';
    return `文案准备未完成 · 已完成 ${completed}/${total}，${hint}`;
  }
  if (job.status === 'partial' || (job.status === 'success' && job.failed > 0)) {
    return `文案已完成 ${completed}/${total}，${boundedCount(job.failed)} 条未完成，可重试`;
  }
  if (job.status === 'success') return `文案已完成 ${completed}/${total}`;
  return `文案准备中 · 已完成 ${completed}/${total}${job.failed > 0 ? `，${boundedCount(job.failed)} 条未完成` : ''}`;
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
      ? failed.map((result) => `${result.sourceLabel}：${formatDouyinSyncError(result.error, result.sourceLabel)}`).join('；')
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
    ? `；${failed.map((result) => `${result.sourceLabel}：${formatDouyinSyncError(result.error, result.sourceLabel)}`).join('；')}`
    : '';
  const counts = successful.every((result) => result.created !== undefined && result.reused !== undefined)
    ? `新增 ${successful.reduce((sum, item) => sum + boundedCount(item.created), 0)} 条，已有 ${successful.reduce((sum, item) => sum + boundedCount(item.reused), 0)} 条`
    : `已同步 ${checked} 条${newlyVisible > 0 ? `，新显示 ${newlyVisible} 条` : ''}`;
  return `${counts}${failedSuffix}`;
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
    ? `约 ${Math.max(1, Math.ceil(retrySeconds / 60))} 分钟后再试。`
    : '请稍后重试。';
  if (/已取消|用户取消/.test(cleaned)) return '已取消同步。';
  if (
    diagnostics.error_code === 'argus_uifid_missing'
    || /收藏登录信息不完整|UIFID/i.test(cleaned)
  ) {
    return '请重新登录抖音后同步收藏。';
  }
  if (diagnostics.error_code === 'verification_required' || diagnostics.needs_action) {
    return `请在抖音完成验证，再继续同步${sourceLabel}。`;
  }
  if (
    diagnostics.error_code === 'source_blocked'
    || diagnostics.error_code === 'risk_controlled'
    || /403|风控|www-hj\.douyin\.com|挑战域|平台风控拒绝/i.test(cleaned)
  ) {
    return `${sourceLabel}暂时无法同步，${retryHint}`;
  }
  if (/429|限频|请求过于频繁/i.test(cleaned)) {
    return `${sourceLabel}同步较频繁，请稍后重试。`;
  }
  if (/登录.*失效|会话.*失效|重新.*(?:登录|连接.*账号)|cookie.*(?:失效|无效)|请先.*绑定/i.test(cleaned)) {
    return `请重新登录抖音后同步${sourceLabel}。`;
  }
  if (/首屏|列表开头|确认官方页面|没有找到抖音.*列表|本人主页|对应标签|还未确认.*列表/.test(cleaned)) {
    return `请打开抖音的“${sourceLabel}”，完成操作后重试。`;
  }
  if (/验证|验证码/.test(cleaned)) return `请在抖音完成验证，再继续同步${sourceLabel}。`;
  if (/\d+\s*分钟/.test(cleaned)) return `${sourceLabel}暂时无法同步，约 ${cleaned.match(/(\d+)\s*分钟/)![1]} 分钟后再试。`;
  return `${sourceLabel}同步未完成，请稍后重试。`;
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
      return `${sourceLabel}同步中 · ${safeProcessed}/${safeTarget}`;
    }
    return `正在同步最近 ${safeRequestedCount} 条${sourceLabel}…`;
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
      return `${sourceLabel}已同步 ${synchronized} 条`;
    }
    return `还没有同步到${sourceLabel}，请在抖音确认列表后重试。`;
  }

  return `正在准备${sourceLabel}同步…`;
}
