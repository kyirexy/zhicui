export type DouyinRecoveryMode = 'like' | 'collect' | 'post';

export interface DouyinSyncRecoveryIssue {
  mode: DouyinRecoveryMode;
  count: number;
  phase: 'waiting' | 'failed';
  reason: 'first-page' | 'target-list' | 'login' | 'profile';
}

/** 优先识别结构化诊断，同时兼容已安装旧客户端返回的中文错误。 */
export function getDouyinSyncRecoveryIssue(input: {
  mode: DouyinRecoveryMode;
  count: number;
  phase: DouyinSyncRecoveryIssue['phase'];
  code?: string;
  error?: string;
  cancelled?: boolean;
}): DouyinSyncRecoveryIssue | null {
  if (input.cancelled) return null;
  const message = input.error || '';
  let reason: DouyinSyncRecoveryIssue['reason'];
  if (input.code === 'DOUYIN_SOURCE_FIRST_PAGE_REQUIRED'
    || /官方分类首屏|未.*确认.*列表开头/.test(message)) {
    reason = 'first-page';
  } else if (/账号登录已失效|请先重新登录|需要重新登录/.test(message)) {
    reason = 'login';
  } else if (/离开了本人抖音主页|同步期间.*切换.*账号/.test(message)) {
    reason = 'profile';
  } else if (/没有找到抖音.*列表|确认官方页面|官方页面尚未就绪|确认已进入本人主页|完成验证并进入/.test(message)) {
    reason = 'target-list';
  } else {
    return null;
  }
  return {
    mode: input.mode,
    count: Number.isFinite(input.count) ? Math.min(100, Math.max(1, Math.trunc(input.count))) : 50,
    phase: input.phase,
    reason,
  };
}

/** 仅更新本次来源，其他失败来源不能被后续同步成功或文稿进度清掉。 */
export function updateDouyinSyncRecovery(
  issues: DouyinSyncRecoveryIssue[],
  mode: DouyinRecoveryMode,
  issue: DouyinSyncRecoveryIssue | null,
): DouyinSyncRecoveryIssue[] {
  const remaining = issues.filter((item) => item.mode !== mode);
  return issue ? [...remaining, issue] : remaining;
}
