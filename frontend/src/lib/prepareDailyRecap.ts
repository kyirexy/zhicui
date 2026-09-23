import {
  createAgentThread, getAgentThread, getDouyinBatchExtraction,
  importPlatformLibraryItems, resumeAgentTurnStream, startDouyinBatchExtraction,
  streamAgentMessage,
} from './api';
import { readStoredToken } from './authSession';
import { getDailyAnalysis, getDailyRecap, type DailyRecap, type DailyRecapItem } from './dailyRecapApi';
import type { AgentThread, ApiResponse, DouyinBatchExtractionJob } from './types';

interface Preparation {
  scope: string[];
  jobId?: string;
  threadId?: string;
  clientTurnId?: string;
  turnId?: string;
  sent?: boolean;
  complete?: boolean;
}

export type DailyRecapKind = 'yesterday' | 'today';

// 只保存任务标识，不缓存正文、媒体链接或身份令牌。浏览器禁用存储时仍可在本页续跑。
const memory = new Map<string, Preparation>();
const running = new Set<string>();
function read(key: string): Preparation | undefined {
  try { return JSON.parse(localStorage.getItem(key) || 'null') || memory.get(key); }
  catch { return memory.get(key); }
}
function save(key: string, value: Preparation) {
  memory.set(key, { ...value });
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储受限时保留内存任务。 */ }
}
function data<T>(result: ApiResponse<T>, fallback: string): T {
  if (!result.success || !result.data) throw new Error(result.error || fallback);
  return result.data;
}
function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new Error('已暂停等待，后台已开始的文稿任务会保留')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 1200);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export interface DailyRecapPreparationOptions {
  beforePrepare?: () => Promise<{ warnings: string[] }>;
  isVisible?: (item: DailyRecapItem) => boolean;
}

/** 一次提交整批文稿，复用已保存的任务，再把准备好的资料交给同一个 AI 会话。 */
export async function prepareDailyRecap(
  recap: DailyRecap,
  onProgress: (message: string) => void,
  signal: AbortSignal | undefined,
  userId: string,
  kind: DailyRecapKind = 'yesterday',
  options: DailyRecapPreparationOptions = {},
): Promise<{ href: string }> {
  const token = readStoredToken();
  const check = () => {
    if (!token || readStoredToken() !== token) throw new Error(`账号已切换，请在当前账号重新打开${kind === 'today' ? '今日分析' : '昨日回顾'}`);
    if (signal?.aborted) throw new Error('已暂停等待，已完成的文稿会保留');
  };
  check();
  // 固定点击时的日期；今日接口跳过历史导入统计，跨午夜也沿用快速查询。
  const fetchRecap = (date: string) => kind === 'today'
    ? getDailyAnalysis(recap.timezone, signal, date)
    : getDailyRecap(recap.timezone, signal, date);
  // 保留昨日回顾 v1 的任务键以兼容已在运行的任务；今日分析使用独立键避免串会话。
  const key = kind === 'today'
    ? `zhicui:daily-recap:v2:today:${userId}:${recap.date}:${recap.timezone}`
    : `zhicui:daily-recap:v1:${userId}:${recap.date}:${recap.timezone}`;
  if (running.has(key)) throw new Error('这份回顾正在处理中，请等待当前任务');
  running.add(key);
  try {
    const syncResult = options.beforePrepare ? await options.beforePrepare() : undefined;
    check();
    // 每次点击重新确认可见来源；日期固定，跨午夜也不会换成另一天。
    let fresh = await fetchRecap(recap.date);
    check();
    const originalIds = new Set(recap.items.map((item) => item.id));
    // 今日分析必须包含本轮刚同步的资料，而不是只分析点击前的旧列表。
    const selected = fresh.items.filter((item) => (kind === 'today' || originalIds.has(item.id))
      && (options.isVisible?.(item) ?? true));
    if (!selected.length) throw new Error(kind === 'today'
      ? '同步已完成，今天还没有可分析的新增喜欢或收藏。'
      : '这些资料已不在当前回顾中，请刷新后重试');
    const scope = selected.map((item) => item.id).sort();
    const previous = read(key);
    const state: Preparation = previous && JSON.stringify(previous.scope) === JSON.stringify(scope)
      ? previous : { scope };
    save(key, state);
    const href = () => ({ href: `/harness?thread=${encodeURIComponent(state.threadId!)}` });
    let reusableThread: AgentThread | undefined;
    let completedThread: AgentThread | undefined;
    const sameSources = (thread: AgentThread | undefined, noteIds: string[]) => thread?.source_scope === 'selected'
      && JSON.stringify([...new Set(thread.source_ids)].sort()) === JSON.stringify([...new Set(noteIds)].sort());
    const missing = selected.filter((item) => !item.transcript_ready && item.can_extract);

    if (state.threadId) {
      const result = await getAgentThread(state.threadId);
      check();
      if (result.success && result.data) {
        if (state.complete) {
          // 已完成的部分回顾仍需补齐缺失文稿；来源不变时继续复用，避免重复生成。
          // 用户已在原会话继续提问时，先打开正在运行的会话，不并行生成另一份总结。
          const readyIds = selected.filter((item) => item.transcript_ready && item.note_id).map((item) => item.note_id!);
          if (result.data.active_turn || (!missing.length && sameSources(result.data, readyIds))) return href();
          completedThread = result.data;
        } else if (state.turnId) {
          onProgress(`正在恢复已有 AI ${kind === 'today' ? '分析' : '回顾'}…`);
          check();
          const resumed = await resumeAgentTurnStream(state.threadId, state.turnId, {
            onProgress: (event) => { check(); onProgress(event.message); },
          }, signal);
          check();
          // 失败/取消的持久任务仍能打开原会话查看原因或手动重试。
          // 恢复流失败不能把首页困在重试循环，也不能自动再次收费生成。
          if (!resumed.success || !resumed.data) return href();
          state.complete = true;
          save(key, state);
          return href();
        }
        // 兼容旧版 AI 流：响应中断时先打开原会话，不能自动再次产生同一笔请求。
        if (!completedThread && state.sent) return href();
        if (!completedThread && (result.data.message_count > 0 || result.data.active_turn)) {
          // 已从其他入口使用的会话不再自动补发回顾。
          state.sent = true;
          save(key, state);
          return href();
        }
        if (!completedThread) reusableThread = result.data;
      } else if (result.status === 404) {
        delete state.threadId; delete state.turnId; delete state.sent; delete state.complete;
        delete state.clientTurnId;
        save(key, state);
      } else {
        throw new Error(result.error || '已有回顾暂时无法读取，请重试');
      }
    }

    let job: DouyinBatchExtractionJob | undefined;
    if (state.jobId) {
      const result = await getDouyinBatchExtraction(state.jobId, signal);
      check();
      if (result.success && result.data) job = result.data;
      else if (result.status !== 404) throw new Error(result.error || '已有文稿任务暂时无法读取，请重试');
    }
    if (!job) {
      const ids = [...new Set(missing.filter((item) => item.platform === 'douyin').map((item) => item.video_id))];
      if (ids.length) {
        check();
        job = data(await startDouyinBatchExtraction(ids, 'transcript'), '文稿提取未能启动');
        state.jobId = job.job_id;
        save(key, state);
        check();
      }
    }
    const waitDouyin = async () => {
      while (job?.status === 'running') {
        check();
        onProgress(`文稿同时处理 ${job.active} 条 · 完成 ${job.success}/${job.total} · 排队 ${job.queued}${job.skipped ? ` · 无音频 ${job.skipped} 条，已跳过` : ''}`);
        await pause(signal);
        check();
        job = data(await getDouyinBatchExtraction(job.job_id, signal), '读取文稿任务失败，已完成的文稿会保留');
      }
    };
    // B站通常导入时已有字幕；残缺旧资料用已有导入入口补齐，不传来源排序参数。
    const bili = missing.filter((item) => item.platform === 'bilibili');
    let next = 0;
    let biliCompleted = 0;
    const prepareBili = async () => {
      while (next < bili.length) {
        check();
        const item = bili[next++];
        try { await importPlatformLibraryItems([item.source_url], undefined, undefined, undefined, signal); }
        catch { check(); /* 单条读取失败后继续，最终只使用再次确认已就绪的资料。 */ }
        check();
        onProgress(`B站文稿已检查 ${++biliCompleted}/${bili.length} 条，准备好的资料会自动复用`);
      }
    };
    await Promise.all([waitDouyin(), ...Array.from({ length: Math.min(4, bili.length) }, prepareBili)]);
    check();
    delete state.jobId;
    save(key, state);
    fresh = await fetchRecap(recap.date);
    check();
    const selectedIds = new Set(scope);
    const visible = fresh.items.filter((item) => selectedIds.has(item.id) && (options.isVisible?.(item) ?? true));
    const ready = visible.filter((item) => item.transcript_ready && item.note_id);
    const noteIds = [...new Set(ready.map((item) => item.note_id!))];
    if (completedThread && sameSources(completedThread, noteIds)) return href();
    if (!noteIds.length) {
      const noAudioIds = new Set(job?.items.filter((item) => item.state === 'no_audio').map((item) => item.aweme_id));
      if (visible.length > 0 && visible.every((item) => item.transcript_status === 'no_audio'
        || item.transcript_source === 'no-audio' || (item.platform === 'douyin' && noAudioIds.has(item.video_id)))) {
        throw new Error('本次内容无音频，暂无可用于提问的文案；原视频和同步记录已保留');
      }
      throw new Error(`本次${kind === 'today' ? '分析' : '回顾'}文稿尚未就绪，请重试；已有视频和同步记录会保留`);
    }
    const unavailable = selected.length - ready.length;
    const periodLabel = kind === 'today' ? '今日分析' : '昨日回顾';
    onProgress(unavailable > 0
      ? `${noteIds.length} 条文稿已就绪，${unavailable} 条暂不可用；正在生成已就绪资料的${kind === 'today' ? '分析' : '回顾'}…`
      : `${noteIds.length} 条文稿已就绪，正在生成 AI ${kind === 'today' ? '分析' : '回顾'}…`);
    check();
    // 创建后离开页面可能尚未发送；重新确认来源完全一致后复用空会话。
    // 可见资料或 Note 标识发生变化时，旧会话不能继续带入失效来源。
    const reuseEmptyThread = sameSources(reusableThread, noteIds);
    const thread = reuseEmptyThread ? reusableThread! : data(await createAgentThread({
      title: `${recap.date} ${periodLabel}`, source_scope: 'selected', source_ids: noteIds,
    }), `${kind === 'today' ? '分析' : '回顾'}会话未能创建，已提取文稿会保留`);
    state.threadId = thread.id;
    if (!reuseEmptyThread) {
      delete state.turnId; delete state.sent; delete state.complete;
    }
    if (!reuseEmptyThread || !state.clientTurnId) state.clientTurnId = crypto.randomUUID();
    save(key, state);
    check();
    const syncWarning = syncResult?.warnings.length ? `本次同步存在限制：${syncResult.warnings.join('；')}。请在总结开头明确提醒，仅总结已读取的资料。\n` : '';
    const content = syncWarning + `请根据本会话选中的 ${noteIds.length} 条视频资料，整理 ${recap.date} 的「${periodLabel}」。\n`
      + '统计依据是当天首次同步到知萃的点赞与收藏，不代表当天实际点赞收藏，也不代表视频发布时间；首次导入可能包含历史视频。\n'
      + `当天记录共 ${fresh.total} 条，本次选择 ${selected.length} 条；${unavailable} 条未就绪或已不可见，请明确说明覆盖范围，不要假装已经读过。\n`
      + '先按主题归类，提炼共同观点和不同意见，再给出最值得记住的要点及 3 个可执行的小行动。重要结论引用具体视频来源；证据不足请明确说明。最后给出 3 个适合继续追问的问题。不要逐条机械复述，也不要联网补充未选中的资料。';
    state.sent = true;
    save(key, state);
    const result = await streamAgentMessage(thread.id, {
      // 每日摘要只基于已选视频文稿，不需要深度研究或联网；显式 fast
      // 可避免来源较多时 auto 被升级为 deep，明显缩短首屏等待时间。
      content, client_turn_id: state.clientTurnId, research_mode: 'fast',
      output_style: 'summary', web_scope: 'video_only',
    }, {
      onTurn: (turnId) => { check(); state.turnId = turnId; save(key, state); },
      onProgress: (event) => { check(); onProgress(event.message); },
    }, signal);
    check();
    data(result, `AI ${kind === 'today' ? '今日分析' : '昨日回顾'}暂未完成，已保存会话，可继续打开`);
    state.complete = true;
    save(key, state);
    return href();
  } finally { running.delete(key); }
}
