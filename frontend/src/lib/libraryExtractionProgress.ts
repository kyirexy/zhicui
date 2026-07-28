import type {
  DouyinBatchExtractionJob,
  DouyinLibraryItem,
} from '@/lib/types';

export interface LibraryExtractionSummary {
  total: number;
  completed: number;
  active: number;
  queued: number;
  failed: number;
  percent: number;
}

export interface LibraryCompletedResult {
  item: DouyinLibraryItem;
  transcriptChars: number;
  updatedAt: string;
}

export function summarizeLibraryExtraction(
  job: DouyinBatchExtractionJob | null,
): LibraryExtractionSummary {
  if (!job) {
    return {
      total: 0,
      completed: 0,
      active: 0,
      queued: 0,
      failed: 0,
      percent: 0,
    };
  }

  const total = Math.max(0, Number(job.total) || job.items.length);
  const completed = Math.max(0, Number(job.success) || 0);
  const failed = Math.max(0, Number(job.failed) || 0);
  const active = Math.max(0, Number(job.active) || 0);
  const queued = Math.max(0, Number(job.queued) || 0);
  const settled = Math.min(total, completed + failed);

  return {
    total,
    completed,
    active,
    queued,
    failed,
    percent: total > 0 ? Math.round((settled / total) * 100) : 0,
  };
}

export function getRecentCompletedResults(
  job: DouyinBatchExtractionJob | null,
  items: DouyinLibraryItem[],
  limit = 4,
): LibraryCompletedResult[] {
  if (!job || limit <= 0) return [];

  const itemById = new Map(items.map((item) => [item.aweme_id, item]));
  return job.items
    .filter((result) => result.state === 'done')
    .sort((left, right) => (
      Date.parse(right.updated_at || '') - Date.parse(left.updated_at || '')
    ))
    .flatMap((result) => {
      const item = itemById.get(result.aweme_id);
      return item
        ? [{
            item,
            transcriptChars: result.transcript_chars,
            updatedAt: result.updated_at,
          }]
        : [];
    })
    .slice(0, limit);
}
