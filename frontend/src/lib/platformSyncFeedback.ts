import type { PlatformAccountResult } from './desktopRuntime';

export function platformSyncWarning(result: Pick<PlatformAccountResult, 'coverage' | 'orderReliable' | 'warning'>): string {
  if (result.warning?.trim()) return result.warning.trim();
  if (result.orderReliable === false) return '部分来源顺序暂时无法确认，请稍后重新同步校准';
  if (result.coverage === 'partial') return '本次仅同步已读取的部分，请稍后重试未读取内容';
  if (result.coverage === 'limited') return '本次仅同步所选数量，未扫描全部作品';
  return '';
}

export function withPlatformSyncWarning(message: string, warning: string): string {
  if (!warning || message.includes(warning)) return message;
  return [message, warning].filter(Boolean).join('；');
}
