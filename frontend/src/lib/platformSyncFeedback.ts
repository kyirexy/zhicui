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

export interface PlatformSyncSourceResult extends Pick<PlatformAccountResult, 'coverage' | 'orderReliable' | 'warning'> {
  sourceLabel: string;
  acceptedCount: number;
  requestedCount: number;
}

/** 来源数量分别展示，相同诊断合并一次；limited是用户指定的读取范围。 */
export function formatPlatformSyncSourceResults(results: PlatformSyncSourceResult[]): string {
  const ranges: string[] = [];
  const diagnostics = new Map<string, string[]>();
  for (const result of results) {
    const accepted = Math.max(0, Math.trunc(result.acceptedCount) || 0);
    const requested = Math.max(1, Math.trunc(result.requestedCount) || 1);
    const prefix = result.orderReliable === true ? '前 ' : '';
    ranges.push(result.coverage === 'complete'
      ? `${result.sourceLabel}：已保存全部 ${accepted} 条（本次最多 ${requested} 条）`
      : `${result.sourceLabel}：已保存${prefix}${accepted}/${requested} 条`);
    const raw = result.warning?.trim() || '';
    const standard = /^(?:官方列表尚未完整读取，本次仅保留已确认顺序的作品；请稍后重试|已按官方顺序读取前 \d+ 条，其余作品本次未读取；历史资料保留|官方列表暂未返回可确认顺序的作品；历史资料保留|本次读取前 \d+ 条，未扫描全部作品|本次仅同步所选数量，未扫描全部作品|本次仅同步已读取的部分，请稍后重试未读取内容)$/.test(raw);
    const messages = [
      result.coverage === 'partial' ? '后续列表未完整读取，已有资料已保留，可稍后重试' : '',
      result.orderReliable === false ? '本次顺序未确认，保留上次已确认顺序' : '',
      raw && !standard ? raw : '',
    ].filter(Boolean);
    for (const message of messages) {
      const labels = diagnostics.get(message) || [];
      if (!labels.includes(result.sourceLabel)) labels.push(result.sourceLabel);
      diagnostics.set(message, labels);
    }
  }
  return [...ranges, ...Array.from(diagnostics, ([message, labels]) => `${labels.join('、')}：${message}`)].join('；');
}
