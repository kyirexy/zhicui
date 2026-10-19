import type { CreatorSyncRun } from './types';

type RunSummary = Pick<CreatorSyncRun, 'operation' | 'auto_transcribe' | 'status'>
  & Partial<Pick<CreatorSyncRun, 'needs_action'>>;

export function isCreatorCatalogOnly(run: RunSummary): boolean {
  return run.operation === 'catalog_recent' || (run.operation === 'catalog_all' && !run.auto_transcribe);
}

export function creatorCompletionTitle(run: RunSummary): string {
  const subject = isCreatorCatalogOnly(run) ? '博主作品清单' : '博主文稿';
  if (run.status === 'failed' || run.needs_action?.required) return `${subject}未完成`;
  if (run.status === 'cancelled') return `${subject}任务已取消`;
  if (run.status === 'partial') return `${subject}部分完成`;
  return `${subject}${isCreatorCatalogOnly(run) ? '已更新' : '已完成'}`;
}
