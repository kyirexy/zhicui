import type { PlatformAccountResult } from './desktopRuntime';

/** 清理桌面通信包装，避免把内部异常直接展示给用户。 */
export function formatPlatformSyncError(error: unknown): string {
  const fallback = '同步暂时中断，请稍后重试';
  const raw = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message : '';
  let message = raw.trim();
  for (let index = 0; index < 4; index += 1) {
    const cleaned = message
      .replace(/^Error invoking remote method\s+['"]desktop:[^'"]+['"]:\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim();
    if (cleaned === message) break;
    message = cleaned;
  }
  if (/(?:批次|会话)标识(?:无效|不合法)/.test(message)) {
    return '同步参数暂不兼容，请刷新页面后重试';
  }
  if (!/[\u4e00-\u9fff]/.test(message)
    || message.length > 180
    || /https?:\/\/|file:\/\/|[A-Za-z]:\\|\n|\b(?:IPC|TypeError|ReferenceError|SyntaxError|ENOTFOUND|ECONN\w*|ERR_\w*)\b|Error invoking remote method/i.test(message)) {
    return fallback;
  }
  return /登录|验证|验证码|重新连接|读取|保存|导入|同步|重试|取消|稍后|等待|账号|连接器/.test(message)
    ? message : fallback;
}

function isRoutineWarning(message: string): boolean {
  return /^(?:官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试|已按官方顺序读取前 \d+ 条，其余作品本次未读取；历史资料保留|官方列表暂未返回可确认顺序的作品；历史资料保留|本次读取前 \d+ 条，未扫描全部作品|本次仅同步所选数量，未扫描全部作品|本次仅同步已读取的部分，请稍后重试未读取内容)$/.test(message);
}

export function platformSyncWarning(result: Pick<PlatformAccountResult, 'coverage' | 'orderReliable' | 'warning'>): string {
  const raw = result.warning?.trim() || '';
  if (raw && !isRoutineWarning(raw)) {
    if (/验证|验证码/.test(raw)) return '请完成账号验证后继续同步';
    if (/登录|重新连接/.test(raw)) return '请重新登录后继续同步';
    const minutes = raw.match(/(\d+)\s*分钟/);
    if (minutes) return `请等待 ${minutes[1]} 分钟后重试`;
    if (/429|限频|频繁|风控|403/.test(raw)) return '请稍后重试';
  }
  if (result.coverage === 'partial') return '剩余视频未同步，请重试';
  if (result.orderReliable === false) return '同步还未完成，请重试';
  if (raw && !isRoutineWarning(raw)) return '部分视频还未同步，请重试';
  return '';
}

export function withPlatformSyncWarning(message: string, warning: string): string {
  if (!warning || message.includes(warning)) return message;
  return [message, warning].filter(Boolean).join('；');
}

export interface PlatformSyncSourceResult extends Pick<PlatformAccountResult, 'coverage' | 'orderReliable' | 'warning'> {
  sourceLabel: string;
  acceptedCount: number;
  requestedCount: number;
}

/** 普通成功由同步摘要展示；这里只保留未完成数量与必要操作。 */
export function formatPlatformSyncSourceResults(results: PlatformSyncSourceResult[]): string {
  const groups = new Map<string, string[]>();
  for (const result of results) {
    const warning = platformSyncWarning(result);
    if (!warning) continue;
    const accepted = Math.max(0, Math.trunc(result.acceptedCount) || 0);
    const requested = Math.max(1, Math.trunc(result.requestedCount) || 1);
    const count = accepted === 0
      ? `${result.sourceLabel}：尚未同步`
      : result.coverage === 'complete'
        ? `${result.sourceLabel}：已同步 ${accepted} 条`
        : `${result.sourceLabel}：已同步 ${accepted}/${requested} 条`;
    const labels = groups.get(warning) || [];
    if (!labels.includes(count)) labels.push(count);
    groups.set(warning, labels);
  }
  return Array.from(groups, ([message, labels]) => `${labels.join('、')}；${message}`).join('；');
}
