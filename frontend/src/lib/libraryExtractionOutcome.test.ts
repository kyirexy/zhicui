import assert from 'node:assert/strict';
import test from 'node:test';
import { isNoAudioResult, libraryExtractionErrorMessage } from './libraryExtractionOutcome.ts';
import { LibraryExtractionBatchTracker, aggregateExtractionJobs } from './libraryExtractionQueue.ts';
import { summarizeLibraryExtraction } from './libraryExtractionProgress.ts';
import { selectTranscriptPreparationTargets } from './libraryTranscriptPreparation.ts';
import { formatTranscriptPreparationProgress } from './douyinSyncFeedback.ts';
import type { DouyinBatchExtractionJob, DouyinLibraryItem } from './types';

const item = (id: string, extra = {}) => ({ aweme_id: id, can_extract: true, transcript_chars: 0,
  ai_initialized: false, ...extra }) as DouyinLibraryItem;
const job: DouyinBatchExtractionJob = {
  job_id: 'mixed', operation: 'transcript', status: 'success', total: 2, success: 1, skipped: 1,
  failed: 0, active: 0, queued: 0, concurrency: { asr: 4, llm: 2 }, created_at: '', started_at: '',
  database_stores_media: false,
  items: [
    { aweme_id: 'voice', state: 'done', error: '', note_id: 'note', transcript_chars: 30, ai_initialized: false, already_existed: false, updated_at: '' },
    { aweme_id: 'silent', state: 'no_audio', error: '', transcript_chars: 0, ai_initialized: false, already_existed: false, updated_at: '' },
  ],
};

test('无音频必须有明确状态，404 和普通失败不代表没有音轨', () => {
  assert.equal(isNoAudioResult({ state: 'no_audio' }), true);
  assert.equal(isNoAudioResult({ transcript_status: 'no_audio' }), true);
  assert.equal(isNoAudioResult({ transcript_source: 'no-audio' }), true);
  assert.equal(isNoAudioResult({ state: 'error', error_code: 'http_404' }), false);
  assert.equal(isNoAudioResult({ transcript_status: 'no_audio', transcript_chars: 20 }), false, '后来获得的真实文稿优先于旧标记');
  for (const raw of ['404 Client Error: Not Found for url: http://127.0.0.1:9000/media/private', 'ASR timeout https://private.invalid', 'Traceback: token=secret']) {
    const shown = libraryExtractionErrorMessage(raw);
    assert.doesNotMatch(shown, /http|private|token|Traceback|无音频/i);
    assert.match(shown, /重试/);
  }
});

test('混合批次无音频不算失败或文稿就绪，但进度达到100%', () => {
  const aggregate = aggregateExtractionJobs([job])!;
  assert.equal(aggregate.success, 1);
  assert.equal(aggregate.skipped, 1);
  assert.equal(aggregate.failed, 0);
  assert.equal(aggregate.status, 'success');
  assert.equal(summarizeLibraryExtraction(aggregate).percent, 100);
  assert.match(formatTranscriptPreparationProgress(aggregate), /1 条无音频，已跳过/);
  const onlySilent = aggregateExtractionJobs([{ ...job, items: job.items.slice(1) }])!;
  assert.equal(onlySilent.success, 0);
  assert.equal(onlySilent.failed, 0);
  assert.equal(summarizeLibraryExtraction(onlySilent).percent, 100);
});

test('已确认无音频不重复入队，任务整体失败也保留其终态', () => {
  const tracker = new LibraryExtractionBatchTracker();
  const [batch] = tracker.reserve([item('voice'), item('silent')], 'transcript');
  tracker.update(batch.key, { ...job, status: 'failed' });
  assert.equal(tracker.snapshot()?.items[1].state, 'no_audio');
  tracker.fail(batch.key, '进度连接中断');
  assert.equal(tracker.snapshot()?.items[1].state, 'no_audio');
  assert.deepEqual(tracker.reserve([item('silent')], 'transcript'), []);
  const persisted = item('persisted-silent', { transcript_status: 'no_audio' });
  assert.deepEqual(new LibraryExtractionBatchTracker().reserve([persisted], 'transcript'), []);
  assert.deepEqual(selectTranscriptPreparationTargets([[persisted, item('new')]]).map((value) => value.aweme_id), ['new']);
});
