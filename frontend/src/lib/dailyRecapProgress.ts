import type { DouyinBatchExtractionJob } from './types';

type ExtractionProgress = Pick<DouyinBatchExtractionJob, 'total' | 'success' | 'failed' | 'skipped' | 'active' | 'queued' | 'downloading' | 'transcribing' | 'analyzing'>;

function count(value: number | undefined, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.floor(value)))
    : 0;
}

/** 成功、失败和无音频都属于已处理，不能把成功数量当成整批进度。 */
export function formatDailyRecapExtractionProgress(job: ExtractionProgress): string {
  const total = count(job.total);
  const success = count(job.success, total);
  const failed = count(job.failed, total - success);
  const skipped = count(job.skipped, total - success - failed);
  const processed = success + failed + skipped;
  const active = count(job.active, total - processed);
  const queued = count(job.queued, total - processed - active);
  const hasStages = job.downloading !== undefined && job.transcribing !== undefined && job.analyzing !== undefined;
  const downloading = count(job.downloading, active);
  const transcribing = count(job.transcribing, active - downloading);
  const analyzing = count(job.analyzing, active - downloading - transcribing);
  const stages = hasStages
    ? ` · 下载音频 ${downloading} · 语音转写 ${transcribing}` + (analyzing ? ` · AI 整理 ${analyzing}` : '')
    : ` · 处理中 ${active}`;
  return `文稿已处理 ${processed}/${total} · 成功 ${success} · 失败 ${failed}`
    + (skipped ? ` · 无音频 ${skipped}，已跳过` : '')
    + stages + ` · 排队 ${queued}`;
}

/** 仅使用后端报告的条目计数，不根据等待时间估算百分比。 */
export function dailyRecapProgressPercent(message: string): number | null {
  const match = /(?:已处理|已检查|已导入|(?<!未)完成)\s*(\d+)\s*\/\s*(\d+)/.exec(message);
  if (!match) return null;
  const processed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || total <= 0) return null;
  return Math.round(Math.min(total, Math.max(0, processed)) / total * 100);
}

const AI_STEP_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['扫描冻结的视频文稿', '正在阅读视频文稿…'],
  ['分批映射多条视频观点', '正在整理多条视频的要点…'],
  ['综合候选依据并生成回答', '正在生成 AI 总结…'],
  ['校验观点、独立来源和逐字引用', '正在核对总结与视频来源…'],
  ['按校验反馈修复观点和引用', '正在完善总结与来源引用…'],
  ['查证公开网页信息', '正在核实相关信息…'],
];

const AI_PROGRESS_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['正在拆解问题并规划检索方向', '正在准备 AI 总结…'],
  ['已自动切换为深度研究', '正在进一步分析视频资料…'],
  ['正在准备视频资料', '正在准备视频文稿…'],
  ['正在筛选与问题最相关的原文片段', '正在整理视频中的关键内容…'],
  ['正在分批核对多条视频中的观点', '正在对照多条视频的观点…'],
  ['正在基于候选依据组织回答', '正在生成 AI 总结…'],
  ['正在校验回答、引用与资料边界', '正在核对总结与视频来源…'],
];

/** 收起已知研究流程的内部术语，未识别消息原样保留，完成单步不代表总结完成。 */
export function formatDailyRecapAiProgress(message: string): string {
  const started = /^正在执行研究步骤[：:]\s*(.*)$/.exec(message);
  if (started) {
    return AI_STEP_LABELS.find(([prefix]) => started[1].startsWith(prefix))?.[1]
      || '正在分析已选资料…';
  }
  if (/^已完成研究步骤[：:]/.test(message)) return '正在继续整理分析结果…';
  if (/^研究步骤未完成[：:]/.test(message)) return '当前分析步骤暂未完成';
  if (/^研究步骤结果超过安全上限[：:]/.test(message)) return '本次分析内容较多，暂未完成';
  if (/^正在扫描\s*\d+\s*条视频文稿/.test(message)) return '正在阅读视频文稿…';
  return AI_PROGRESS_LABELS.find(([prefix]) => message.startsWith(prefix))?.[1] || message;
}
