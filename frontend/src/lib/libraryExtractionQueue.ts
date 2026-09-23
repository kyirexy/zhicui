import type { DouyinBatchExtractionItem, DouyinBatchExtractionJob, DouyinBatchExtractionOperation, DouyinLibraryItem } from './types';
import { isNoAudioResult } from './libraryExtractionOutcome.ts';

interface BatchEntry {
  key: string;
  ids: string[];
  job: DouyinBatchExtractionJob;
  observing: boolean;
}

export interface ReservedExtractionBatch {
  key: string;
  ids: string[];
  operation: DouyinBatchExtractionOperation;
  initial?: DouyinBatchExtractionJob;
}

export function extractionBatchLimit(operation: DouyinBatchExtractionOperation): number {
  return operation === 'transcript' ? 100 : 50;
}

function isReady(item: Pick<DouyinLibraryItem, 'extracted_note_id' | 'transcript_chars' | 'ai_initialized'>,
  operation: DouyinBatchExtractionOperation): boolean {
  const transcript = Boolean(item.extracted_note_id) && item.transcript_chars > 0;
  return operation === 'transcript' ? transcript : transcript && item.ai_initialized;
}

export function aggregateExtractionJobs(jobs: DouyinBatchExtractionJob[]): DouyinBatchExtractionJob | null {
  if (!jobs.length) return null;
  const items = [...new Map(jobs.flatMap((job) => job.items).map((item) => [item.aweme_id, item])).values()];
  const success = items.filter((item) => item.state === 'done').length;
  const failed = items.filter((item) => item.state === 'error').length;
  const skipped = items.filter(isNoAudioResult).length;
  const active = items.filter((item) => item.state === 'transcribing' || item.state === 'analyzing').length;
  const queued = items.filter((item) => item.state === 'queued').length;
  const running = jobs.some((job) => job.status === 'running');
  return { ...jobs[0], job_id: jobs.map((job) => job.job_id).join(','), items, total: items.length,
    success, failed, skipped, active, queued,
    operation: jobs.every((job) => job.operation === jobs[0].operation) ? jobs[0].operation : 'full',
    status: running ? 'running' : failed ? success || skipped ? 'partial' : 'failed' : 'success',
    error: [...new Set(jobs.map((job) => job.error).filter(Boolean))].join('；') || undefined,
  };
}

/** 预留、提交与观察分别记录；追加时不会因旧批次完成而丢失新批次。 */
export class LibraryExtractionBatchTracker {
  private entries = new Map<string, BatchEntry>();
  private sequence = 0;
  private submitting = 0;
  private submissionWaiters: Array<() => void> = [];

  get busy(): boolean { return [...this.entries.values()].some((entry) => entry.observing); }

  reserve(targets: DouyinLibraryItem[], operation: DouyinBatchExtractionOperation): ReservedExtractionBatch[] {
    const runningIds = new Set([...this.entries.values()].filter((entry) => entry.observing || entry.job.status === 'running').flatMap((entry) => entry.ids));
    const readyIds = new Set(targets.filter((item) => isReady(item, operation)).map((item) => item.aweme_id));
    const noAudioIds = new Set(targets.filter(isNoAudioResult).map((item) => item.aweme_id));
    for (const entry of this.entries.values()) for (const item of entry.job.items) {
      if (isNoAudioResult(item)) noAudioIds.add(item.aweme_id);
      if (item.state === 'done' && isReady({ ...item, extracted_note_id: item.note_id || null }, operation)) readyIds.add(item.aweme_id);
    }
    const pending = [...new Set(targets.filter((item) => item.can_extract && item.aweme_id
      && !noAudioIds.has(item.aweme_id)
      && !readyIds.has(item.aweme_id) && !runningIds.has(item.aweme_id)
      && (operation !== 'ai' || Boolean(item.extracted_note_id) && item.transcript_chars > 0))
      .map((item) => item.aweme_id))];
    const resumable = [...this.entries.values()].filter((entry) => !entry.observing && entry.job.status === 'running');
    if (!pending.length && !resumable.length) return [];
    const batches: ReservedExtractionBatch[] = resumable.map((entry) => {
      entry.observing = true;
      return { key: entry.key, ids: entry.ids, operation: entry.job.operation, initial: entry.job };
    });
    // 新的一轮只保留仍在服务端运行的记录；上一轮完成总数不混入新任务。
    if (!this.busy) for (const [key, entry] of this.entries) if (entry.job.status !== 'running') this.entries.delete(key);
    const limit = extractionBatchLimit(operation);
    for (let offset = 0; offset < pending.length; offset += limit) {
      const ids = pending.slice(offset, offset + limit);
      const key = `pending-${++this.sequence}`;
      const now = new Date().toISOString();
      const items: DouyinBatchExtractionItem[] = ids.map((aweme_id) => ({ aweme_id, state: 'queued', error: '',
        transcript_chars: 0, ai_initialized: false, already_existed: false, updated_at: now }));
      this.entries.set(key, { key, ids, observing: true, job: { job_id: key, operation, status: 'running',
        created_at: now, started_at: now, concurrency: { asr: 0, llm: 0 }, total: ids.length,
        success: 0, failed: 0, active: 0, queued: ids.length, items, database_stores_media: false } });
      batches.push({ key, ids, operation });
    }
    return batches;
  }

  update(key: string, job: DouyinBatchExtractionJob): void {
    const entry = this.entries.get(key);
    if (entry) entry.job = job.status === 'failed' ? { ...job,
      items: job.items.map((item) => item.state === 'done' || isNoAudioResult(item) ? item : { ...item, state: 'error', error: item.error || job.error || '任务未完成，可重试' }),
    } : job;
  }

  finish(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.observing = false;
  }

  fail(key: string, error: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.job = { ...entry.job, status: 'failed', error, active: 0, queued: 0,
      items: entry.job.items.map((item) => item.state === 'done' || isNoAudioResult(item) ? item : { ...item, state: 'error', error }),
    };
    entry.observing = false;
  }

  pause(key: string, error: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.job = { ...entry.job, error };
  }

  forget(id: string): void {
    for (const [key, entry] of this.entries) if (!entry.observing && entry.ids.includes(id)) this.entries.delete(key);
  }

  snapshot(keys?: string[]): DouyinBatchExtractionJob | null {
    return aggregateExtractionJobs([...this.entries.values()].filter((entry) => !keys || keys.includes(entry.key)).map((entry) => entry.job));
  }

  async submit<T>(action: () => Promise<T>): Promise<T> {
    if (this.submitting >= 3) await new Promise<void>((resolve) => this.submissionWaiters.push(resolve));
    else this.submitting += 1;
    try { return await action(); }
    finally {
      const next = this.submissionWaiters.shift();
      if (next) next();
      else this.submitting -= 1;
    }
  }
}

export async function runReservedExtractionBatches(
  tracker: LibraryExtractionBatchTracker,
  batches: ReservedExtractionBatch[],
  options: {
    isCurrent: () => boolean;
    submit: (ids: string[], operation: DouyinBatchExtractionOperation) => Promise<DouyinBatchExtractionJob>;
    observe: (job: DouyinBatchExtractionJob, update: (job: DouyinBatchExtractionJob) => void) => Promise<DouyinBatchExtractionJob>;
    onChange: () => void;
  },
): Promise<DouyinBatchExtractionJob | null> {
  // 提交最多并发三次，只等待服务端持久化响应，不等待前一批转写完成再提交。
  await Promise.all(batches.map(async (batch) => {
    if (!options.isCurrent()) return;
    let accepted = Boolean(batch.initial);
    try {
      const initial = batch.initial || await tracker.submit(async () => {
        if (!options.isCurrent()) throw new Error('账号已切换，停止提交新任务');
        return options.submit(batch.ids, batch.operation);
      });
      if (!options.isCurrent()) return;
      accepted = true;
      tracker.update(batch.key, initial);
      options.onChange();
      const final = await options.observe(initial, (job) => {
        if (!options.isCurrent()) return;
        tracker.update(batch.key, job);
        options.onChange();
      });
      if (options.isCurrent()) tracker.update(batch.key, final);
    } catch (error) {
      if (options.isCurrent()) {
        const message = error instanceof Error ? error.message : '文稿任务连接中断';
        // 已接受任务的观察失败不能伪装成转写失败，也不能重新提交相同视频。
        if (accepted) tracker.pause(batch.key, message);
        else tracker.fail(batch.key, message);
      }
    } finally {
      if (options.isCurrent()) {
        tracker.finish(batch.key);
        options.onChange();
      }
    }
  }));
  return options.isCurrent() ? tracker.snapshot(batches.map((batch) => batch.key)) : null;
}
