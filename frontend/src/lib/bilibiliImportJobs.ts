import type { ApiResponse, BilibiliImportJob, PlatformLibraryImportEntry, PlatformLibraryImportResult } from './types';
import type { PlatformImportBatch } from './platformImportBatch';
import { platformImportInputKey } from './platformImportBatch.ts';

const terminal = (job: BilibiliImportJob) => ['succeeded', 'partial', 'failed'].includes(job.status);

export function bilibiliSubmissionKey(mode?: string, syncedAt?: string, offset = 0): string | undefined {
  const time = Date.parse(syncedAt || '');
  return mode && Number.isFinite(time) ? `${mode}:${time}:${offset}` : undefined;
}

export function bilibiliJobEntries(job: BilibiliImportJob, inputs = job.urls || []): PlatformLibraryImportEntry[] {
  const reported = Array.isArray(job.items) ? job.items.filter((item) => item && typeof item.input === 'string') : [];
  const urls = [...new Set((inputs.length ? inputs : reported.map((item) => item.input)).map(platformImportInputKey))];
  return urls.map((input) => {
    const matches = reported.filter((item) => platformImportInputKey(item.input) === input);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (entry && ['imported', 'reused', 'skipped', 'failed'].includes(entry.status)
      && (entry.status === 'skipped' || entry.success === (entry.status === 'imported' || entry.status === 'reused'))) {
      return { ...entry, input, success: entry.status === 'skipped' ? false : entry.success,
        platform: 'bilibili', job_id: job.id, background_pending: false,
        submission_key: bilibiliSubmissionKey(job.source_mode, job.source_synced_at, job.source_rank_offset) };
    }
    return { input, platform: 'bilibili', job_id: job.id, success: false, status: 'pending',
      submission_key: bilibiliSubmissionKey(job.source_mode, job.source_synced_at, job.source_rank_offset),
      background_pending: !terminal(job), error: terminal(job) ? '同步结果尚未确认' : '正在后台准备文案' };
  });
}

export function mergeBilibiliJobResults(current: PlatformLibraryImportEntry[], jobs: BilibiliImportJob[]): PlatformLibraryImportEntry[] {
  const ids = new Set(current.map((entry) => entry.job_id).filter(Boolean));
  const keys = new Set(current.map((entry) => entry.submission_key).filter(Boolean));
  const selected = jobs.filter((job) => job.status === 'queued' || job.status === 'running'
    || ids.has(job.id) || keys.has(bilibiliSubmissionKey(job.source_mode, job.source_synced_at, job.source_rank_offset)));
  if (!selected.length) return current;
  const replacement = selected.flatMap((job) => bilibiliJobEntries(job));
  const selectedIds = new Set(selected.map((job) => job.id));
  const selectedKeys = new Set(replacement.map((entry) => entry.submission_key).filter(Boolean));
  return [...current.filter((entry) => !selectedIds.has(entry.job_id || '')
    && !selectedKeys.has(entry.submission_key)), ...replacement];
}

export function hasUnresolvedBilibiliSource(entries: PlatformLibraryImportEntry[], modes: string[]): boolean {
  return entries.some((entry) => entry.platform === 'bilibili' && entry.status === 'pending'
    && (!entry.submission_key || modes.includes(entry.submission_key.split(':')[0])));
}

/** 前台等待结束后低频跟进已保存的任务；不重新采集，不重新提交。 */
export function watchBilibiliJobs(
  ids: string[],
  read: (id: string) => Promise<ApiResponse<BilibiliImportJob>>,
  onUpdate: (jobs: BilibiliImportJob[]) => void,
  options: {
    isCurrent: () => boolean;
    schedule?: (callback: () => void) => () => void;
  },
): () => void {
  let active = true;
  let remaining = [...new Set(ids)];
  let cancelTimer = () => {};
  const schedule = options.schedule || ((callback: () => void) => {
    const timer = setTimeout(callback, 10_000);
    return () => clearTimeout(timer);
  });
  const tick = async () => {
    if (!active || !options.isCurrent()) return;
    const responses = await Promise.all(remaining.map(async (id) => {
      try { const response = await read(id); return response.success && response.data?.id === id ? response.data : undefined; }
      catch { return undefined; }
    }));
    if (!active || !options.isCurrent()) return;
    const updates = responses.filter((job): job is BilibiliImportJob => Boolean(job));
    if (updates.length) onUpdate(updates);
    const finished = new Set(updates.filter(terminal).map((job) => job.id));
    remaining = remaining.filter((id) => !finished.has(id));
    if (remaining.length && active && options.isCurrent()) cancelTimer = schedule(() => { void tick(); });
  };
  if (remaining.length) cancelTimer = schedule(() => { void tick(); });
  return () => { active = false; cancelTimer(); };
}

/** 先持久保存全部批次，再读取状态。状态轮询不会重新发送任何导入请求。 */
export async function importBilibiliJobs(
  urls: string[],
  submit: (batch: PlatformImportBatch) => Promise<ApiResponse<BilibiliImportJob>>,
  read: (id: string) => Promise<ApiResponse<BilibiliImportJob>>,
  options: {
    isCurrent: () => boolean;
    onProgress?: (completed: number, total: number) => void;
    wait?: () => Promise<void>;
    maxPolls?: number;
  },
): Promise<ApiResponse<PlatformLibraryImportResult>> {
  const input = [...new Set(urls.map(platformImportInputKey).filter(Boolean))];
  if (!input.length) return { success: false, error: '请至少提交一条视频链接' };
  const jobs: Array<{ urls: string[]; job: BilibiliImportJob }> = [];
  const unconfirmed: PlatformLibraryImportEntry[] = [];
  let interrupted = false;
  const cancelled = () => ({ success: false as const, error: '账号已切换，同步状态读取已停止' });
  const safe = async <T>(work: () => Promise<ApiResponse<T>>): Promise<ApiResponse<T>> => {
    try { return await work(); } catch { return { success: false }; }
  };
  for (let offset = 0; offset < input.length; offset += 10) {
    if (!options.isCurrent()) return cancelled();
    const batch = input.slice(offset, offset + 10);
    const response = await safe(() => submit({ urls: batch, sourceRankOffset: offset, sourceSnapshotSize: input.length }));
    if (!options.isCurrent()) return cancelled();
    if (!response.success || !response.data?.id || !['queued', 'running', 'succeeded', 'partial', 'failed'].includes(response.data.status)) {
      const rejected = [400, 401, 403, 404, 422, 429].includes(response.status || 0);
      unconfirmed.push(...batch.map((url): PlatformLibraryImportEntry => ({ input: url, platform: 'bilibili',
        success: false, status: rejected ? 'failed' : 'pending', error: '同步提交暂未确认' })));
      unconfirmed.push(...input.slice(offset + batch.length).map((url): PlatformLibraryImportEntry => ({ input: url,
        platform: 'bilibili', success: false, status: 'not_submitted', error: '尚未开始同步' })));
      interrupted = true;
      break;
    }
    jobs.push({ urls: batch, job: response.data });
  }
  let completed = -1;
  const report = () => {
    const count = jobs.reduce((sum, entry) => sum + bilibiliJobEntries(entry.job, entry.urls)
      .filter((item) => item.status !== 'pending').length, 0);
    if (count !== completed) { completed = count; options.onProgress?.(count, input.length); }
  };
  report();
  for (let poll = 0; poll < (options.maxPolls ?? 15) && jobs.some((entry) => !terminal(entry.job)); poll += 1) {
    if (!options.isCurrent()) return cancelled();
    if (poll > 0) await (options.wait?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 2000)));
    if (!options.isCurrent()) return cancelled();
    const active = jobs.filter((entry) => !terminal(entry.job));
    const responses = await Promise.all(active.map((entry) => safe(() => read(entry.job.id))));
    if (!options.isCurrent()) return cancelled();
    let disconnected = false;
    responses.forEach((response, index) => {
      const entry = active[index];
      if (!response.success || !response.data || response.data.id !== entry.job.id) { disconnected = true; return; }
      entry.job = response.data;
    });
    report();
    // 任务已持久保存；服务短暂断开只停止等待，不重发 POST，不无限占用同步按钮。
    if (disconnected) break;
  }
  const entries = [...jobs.flatMap((entry) => bilibiliJobEntries(entry.job, entry.urls)), ...unconfirmed];
  return { success: true, data: { items: entries, total: entries.length,
    success: entries.filter((entry) => entry.success).length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
    pending: entries.filter((entry) => entry.status === 'pending').length,
    skipped: entries.filter((entry) => entry.status === 'skipped').length,
    not_submitted: entries.filter((entry) => entry.status === 'not_submitted').length,
    interrupted: interrupted || entries.some((entry) => entry.status === 'pending' && !entry.background_pending) } };
}
