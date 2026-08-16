import type {
  VideoAnalysisCatalog,
  VideoAnalysisOffering,
  VideoAnalysisItemStatus,
  VideoAnalysisQuote,
  VideoAnalysisRun,
  VideoAnalysisRunStatus,
} from './types';

const ACTIVE_STATUSES = new Set<VideoAnalysisRunStatus>([
  'reserved',
  'queued',
  'running',
  'preparing',
  'scene_detection',
  'visual_analysis',
  'summary_update',
]);

const TERMINAL_STATUSES = new Set<VideoAnalysisRunStatus>([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);

export function isActiveVideoAnalysisStatus(status: VideoAnalysisRunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function isVideoAnalysisAttentionStatus(status: VideoAnalysisRunStatus): boolean {
  return status === 'reauthorization_required';
}

export function isTerminalVideoAnalysisStatus(status: VideoAnalysisRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function videoAnalysisItemStatusLabel(status: VideoAnalysisItemStatus): string {
  if (status === 'cached') return '复用缓存 · 0 萃点';
  if (status === 'unsupported') return '不支持 · 未扣费';
  return videoAnalysisStatusLabel(status);
}

export function videoAnalysisStatusLabel(status: VideoAnalysisRunStatus): string {
  const labels: Record<VideoAnalysisRunStatus, string> = {
    quoting: '正在计算报价',
    awaiting_confirmation: '等待确认',
    prepared: '准备开始',
    reserved: '已预留萃点',
    queued: '等待解析',
    running: '正在解析',
    preparing: '准备视频',
    scene_detection: '识别关键场景',
    visual_analysis: '理解视频画面',
    summary_update: '更新摘要',
    succeeded: '解析完成',
    partial: '部分完成',
    failed: '解析失败',
    cancelled: '已取消',
    reauthorization_required: '需要重新确认',
  };
  return labels[status] || status;
}

export function videoAnalysisStageLabel(stage?: string): string {
  const labels: Record<string, string> = {
    prepared: '准备视频',
    downloading: '临时读取视频',
    detecting_scenes: '识别关键场景',
    sampling_frames: '提取关键画面',
    analyzing_visuals: '理解视频画面',
    persisting: '更新摘要',
    completed: '解析完成',
  };
  return stage ? labels[stage] || '' : '';
}

export function offeringIsRecommended(offering: VideoAnalysisOffering): boolean {
  return Boolean(offering.recommended ?? offering.is_recommended);
}

export function offeringIsFree(offering: VideoAnalysisOffering): boolean {
  return Boolean(
    offering.is_free
    ?? offering.price?.is_free
    ?? (
      (offering.price?.base_points || 0) === 0
      && (offering.price?.per_minute_points || 0) === 0
      && (offering.price?.per_frame_points || 0) === 0
      && (offering.price?.per_media_unit_points || 0) === 0
    ),
  );
}

export function catalogOfferings(catalog: VideoAnalysisCatalog | null): VideoAnalysisOffering[] {
  if (!catalog) return [];
  return catalog.items?.length ? catalog.items : catalog.offerings || [];
}

export function recommendedOffering(catalog: VideoAnalysisCatalog | null): VideoAnalysisOffering | null {
  const items = catalogOfferings(catalog);
  if (!items.length) return null;
  if (catalog && typeof catalog.recommendation === 'object' && catalog.recommendation) {
    return catalog.recommendation;
  }
  const recommendedId = typeof catalog?.recommendation === 'string'
    ? catalog.recommendation
    : catalog?.recommended_offering_id;
  return items.find(item => item.id === recommendedId)
    || items.find(offeringIsRecommended)
    || items[0];
}

export function quoteEstimatedPoints(quote?: VideoAnalysisQuote | null): number {
  return Math.max(0, Number(quote?.estimated_points || 0));
}

export function quoteMaxPoints(quote?: VideoAnalysisQuote | null): number {
  return Math.max(quoteEstimatedPoints(quote), Number(quote?.max_points || 0));
}

export function formatPoints(points: number | null | undefined): string {
  return `${Math.max(0, Math.trunc(Number(points) || 0)).toLocaleString('zh-CN')} 萃点`;
}

export function formatPointsWithCny(points: number | null | undefined): string {
  const clean = Math.max(0, Math.trunc(Number(points) || 0));
  return `${clean.toLocaleString('zh-CN')} 萃点（约 ¥${(clean / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') || '0'}）`;
}

export function formatSignedPoints(points: number | null | undefined): string {
  const clean = Math.trunc(Number(points) || 0);
  const sign = clean > 0 ? '+' : '';
  return `${sign}${clean.toLocaleString('zh-CN')} 萃点`;
}

export function createVideoAnalysisIdempotencyKey(runId: string): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `video-analysis:${runId}:${random}`;
}

export function runItemCount(run: VideoAnalysisRun): number {
  return Math.max(1, Number(run.item_count || run.note_ids?.length || run.items?.length || 1));
}
